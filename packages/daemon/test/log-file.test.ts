import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogRecord } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileSink, rotatedLogPath } from '../src/log-file.js';

/** The capped log, on a real file system: the cap and the mode are what it is for. */
describe('log file sink', () => {
  let base: string;
  let path: string;

  const record = (msg: string): LogRecord => ({
    time: '2026-10-14T00:00:00.000Z',
    level: 'info',
    component: 'test',
    msg,
  });
  const lineBytes = Buffer.byteLength(`${JSON.stringify(record('x'.repeat(10)))}\n`);

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-log-')));
    path = join(base, 'daemon.log');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('creates nothing until the first record, then writes it owner-only', () => {
    const file = createFileSink(path);
    expect(existsSync(path)).toBe(false);
    file.sink(record('one'));
    file.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toStrictEqual(record('one'));
  });

  it('appends after what is already there', () => {
    writeFileSync(path, 'a crash trace\n', { mode: 0o600 });
    const file = createFileSink(path);
    file.sink(record('after'));
    file.close();
    expect(readFileSync(path, 'utf8').split('\n')[0]).toBe('a crash trace');
  });

  it('moves the file aside at the cap, keeping exactly one previous file', () => {
    const file = createFileSink(path, lineBytes * 2);
    for (let index = 0; index < 7; index++) file.sink(record(`m${String(index).padStart(9, '0')}`));
    file.close();
    const current = readFileSync(path, 'utf8').trim().split('\n');
    const previous = readFileSync(rotatedLogPath(path), 'utf8').trim().split('\n');
    expect(current.map((line) => (JSON.parse(line) as LogRecord).msg)).toStrictEqual([
      'm000000006',
    ]);
    expect(previous.map((line) => (JSON.parse(line) as LogRecord).msg)).toStrictEqual([
      'm000000004',
      'm000000005',
    ]);
    expect(statSync(path).size).toBeLessThanOrEqual(lineBytes * 2);
    expect(statSync(rotatedLogPath(path)).size).toBeLessThanOrEqual(lineBytes * 2);
  });

  it('moves a file already over the cap aside before writing to it', () => {
    writeFileSync(path, 'x'.repeat(lineBytes * 3), { mode: 0o600 });
    const file = createFileSink(path, lineBytes * 2);
    file.sink(record('x'.repeat(10)));
    file.close();
    expect(statSync(path).size).toBe(lineBytes);
    expect(statSync(rotatedLogPath(path)).size).toBe(lineBytes * 3);
  });

  it('drops records after close rather than reopening', () => {
    const file = createFileSink(path);
    file.close();
    file.sink(record('late'));
    expect(existsSync(path)).toBe(false);
  });
});
