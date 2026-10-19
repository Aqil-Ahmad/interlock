import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, InterlockError } from '@interlock/shared';
import type { LogRecord } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileSink, openLogFile, recordFatal, rotatedLogPath } from '../src/log-file.js';

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

  it('refuses a log that is a symlink, and leaves its target alone', () => {
    const target = join(base, 'target');
    writeFileSync(target, 'untouched\n');
    symlinkSync(target, path);

    expect(() => openLogFile(path)).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    const file = createFileSink(path);
    file.sink(record('one'));
    file.close();
    expect(readFileSync(target, 'utf8')).toBe('untouched\n');
  });

  it('throws an open that fails for another reason as itself', () => {
    expect(() => openLogFile(join(base, 'missing', 'daemon.log'))).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
  });

  it('refuses a log that is not a regular file', () => {
    // A device opens; it is refused once it is seen to be one.
    expect(() => openLogFile('/dev/null')).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
    mkdirSync(path);
    expect(() => openLogFile(path)).toThrow();
  });

  it('writes a record larger than the cap as one that says so, within the cap', () => {
    const file = createFileSink(path, lineBytes * 2);
    file.sink(record('x'.repeat(lineBytes * 4)));
    file.close();
    expect(statSync(path).size).toBeLessThanOrEqual(lineBytes * 2);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      level: 'info',
      msg: 'log record too large to keep',
    });
  });

  it('drops a record it cannot write rather than throwing, and writes the next once it can', () => {
    const file = createFileSink(path, lineBytes * 2);
    file.sink(record('x'.repeat(10)));
    file.sink(record('x'.repeat(10)));
    // A rotation that fails: the previous file's name is taken by a directory.
    mkdirSync(join(rotatedLogPath(path), 'held'), { recursive: true });
    expect(() => file.sink(record('lost'))).not.toThrow();
    // Said once, not per record.
    expect(() => file.sink(record('lost again'))).not.toThrow();

    rmSync(rotatedLogPath(path), { recursive: true });
    file.sink(record('kept'));
    file.close();
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect((JSON.parse(lines.at(-1)!) as LogRecord).msg).toBe('kept');
  });

  it('drops records after close rather than reopening', () => {
    const file = createFileSink(path);
    file.close();
    file.sink(record('late'));
    expect(existsSync(path)).toBe(false);
  });
});

/** The daemon's last words, where `interlock daemon start` and `logs` will find them. */
describe('recordFatal', () => {
  it('writes the code and the remedy on stderr while there is no logger', () => {
    const written: string[] = [];
    recordFatal(
      new InterlockError('CONFIG_INVALID', 'Bad config', { remedy: 'Fix it.' }),
      null,
      (text) => written.push(text),
    );
    expect(JSON.parse(written.join(''))).toStrictEqual({
      level: 'error',
      msg: 'Bad config',
      code: 'CONFIG_INVALID',
      remedy: 'Fix it.',
    });
  });

  it('records through the logger once there is one, and never on stderr', () => {
    const records: LogRecord[] = [];
    const logger = createLogger('daemon', { sink: (one) => records.push(one) });
    recordFatal(new Error('crashed'), logger, () => {
      throw new Error('stderr is the moved-aside file');
    });
    recordFatal('not an error', logger);
    expect(records.map(({ level, msg }) => ({ level, msg }))).toStrictEqual([
      { level: 'error', msg: 'crashed' },
      { level: 'error', msg: 'not an error' },
    ]);
  });
});
