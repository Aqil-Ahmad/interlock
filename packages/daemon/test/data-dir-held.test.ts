import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATA_DIR_LOCK_FILENAME, holdDataDir, isDataDirHeld } from '../src/data-dir.js';

/** The question every client asks before it trusts the runtime file. */
describe('isDataDirHeld', () => {
  let base: string;
  let dataDir: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-held-')));
    dataDir = join(base, 'data');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('answers no for a directory that is not there, and creates nothing asking', () => {
    expect(isDataDirHeld(dataDir)).toBe(false);
    expect(readdirSync(base)).toStrictEqual([]);
  });

  it('follows the hold: held while it is taken, free once it is released', () => {
    const hold = holdDataDir(dataDir, silentLogger);
    try {
      expect(isDataDirHeld(dataDir)).toBe(true);
      // Asking does not take it from the holder.
      expect(isDataDirHeld(dataDir)).toBe(true);
    } finally {
      hold.release();
    }
    expect(isDataDirHeld(dataDir)).toBe(false);
    // And asking does not take it either: the next daemon still can.
    holdDataDir(dataDir, silentLogger).release();
  });

  it('is taken while another process is asking whether it is held', async () => {
    holdDataDir(dataDir, silentLogger).release();
    // A client's probe: a shared lock on the file, held for a moment. In
    // another process, since one process's locks never conflict with its own.
    const probe = spawn(
      process.execPath,
      [
        '-e',
        [
          "const { DatabaseSync } = require('node:sqlite');",
          'const db = new DatabaseSync(process.argv[1], { readOnly: true });',
          "db.exec('BEGIN'); db.exec('SELECT count(*) FROM sqlite_master');",
          "process.stdout.write('asking\\n');",
          "setTimeout(() => { db.exec('COMMIT'); db.close(); }, 200);",
        ].join('\n'),
        join(dataDir, DATA_DIR_LOCK_FILENAME),
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await new Promise<void>((resolve) => probe.stdout.once('data', () => resolve()));

    const hold = holdDataDir(dataDir, silentLogger);
    hold.release();
    await new Promise((resolve) => probe.once('exit', resolve));
  });

  it('refuses a lock file that is not a lock', () => {
    mkdirSync(dataDir);
    writeFileSync(
      join(dataDir, DATA_DIR_LOCK_FILENAME),
      'not a database at all, padded'.repeat(10),
    );
    expect(() => isDataDirHeld(dataDir)).toThrow(/could not be read/u);
  });
});
