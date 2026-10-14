import { closeSync, fstatSync, openSync, renameSync, writeSync } from 'node:fs';
import type { LogSink } from '@interlock/shared';

/**
 * The daemon's log when it runs in the background, as a file it caps itself.
 *
 * Written by the daemon rather than collected from its stderr by whoever
 * started it: the starter exits once the daemon is up, and a log that grows for
 * as long as the daemon runs needs someone still there to rotate it.
 */

/** Owner-only, like everything else under the data dir. Records are redacted at source, not here. */
export const LOG_FILE_MODE = 0o600;

/**
 * Where a file is rotated, in bytes.
 *
 * At most twice this on disk, with the previous file kept. A few days of an
 * ordinary daemon's records, and small enough that `logs -n` reading it whole
 * stays instant.
 */
export const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;

export interface FileSink {
  readonly sink: LogSink;
  /** Close the file. A record after this is dropped rather than reopening it. */
  close(): void;
}

/** The previous file, kept beside the current one. Exactly one: the cap is the point. */
export function rotatedLogPath(path: string): string {
  return `${path}.1`;
}

/**
 * Append each record as one JSON line, moving the file aside once it passes
 * `maxBytes`.
 *
 * Synchronous, so a record logged just before the process exits is on disk
 * when it does, and two records never interleave.
 *
 * Appended rather than written at an offset, because the daemon's own stderr
 * may be the same file — what is printed before there is a logger, and a crash
 * trace, land there — and two appenders never overwrite each other.
 */
export function createFileSink(path: string, maxBytes: number = LOG_FILE_MAX_BYTES): FileSink {
  /**
   * Opened at the first record, not here. The daemon logs nothing before it
   * has refused a data dir inside a watched repository and taken the data-dir
   * hold, so opening lazily is what keeps the log file from being the first
   * thing written into a directory the daemon is about to refuse.
   */
  let handle: number | null = null;
  let size = 0;
  let closed = false;

  function open(): number {
    // `mode` applies only when the file is created. One that is already there
    // was created by the CLI with the same mode, or by a daemon before it.
    const opened = openSync(path, 'a', LOG_FILE_MODE);
    size = fstatSync(opened).size;
    return opened;
  }

  function rotate(): number {
    if (handle !== null) closeSync(handle);
    // Over the previous one: a rename replaces its target atomically.
    renameSync(path, rotatedLogPath(path));
    handle = open();
    return handle;
  }

  return {
    sink(record): void {
      if (closed) return;
      let target = handle ?? (handle = open());
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line);
      // Before the write, so no file ever passes the cap by more than a record
      // — and a file already over it from a previous run is moved aside first.
      if (size > 0 && size + bytes > maxBytes) target = rotate();
      size += writeSync(target, line);
    },
    close(): void {
      closed = true;
      if (handle === null) return;
      closeSync(handle);
      handle = null;
    },
  };
}
