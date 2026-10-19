import { closeSync, constants, fstatSync, openSync, renameSync, writeSync } from 'node:fs';
import { InterlockError, isInterlockError } from '@interlock/shared';
import type { LogRecord, LogSink, Logger } from '@interlock/shared';

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
 * Open the log for appending, creating it owner-only.
 *
 * Never through a symlink, and never anything but a regular file: the data dir
 * is the user's to point anywhere, and a `daemon.log` planted as a link would
 * have the daemon append its records to the file it names — one in a watched
 * repository, say.
 */
export function openLogFile(path: string): number {
  const flags =
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
  let handle: number;
  try {
    handle = openSync(path, flags, LOG_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ELOOP') throw error;
    throw notARegularFile(path, error);
  }
  if (!fstatSync(handle).isFile()) {
    closeSync(handle);
    throw notARegularFile(path);
  }
  return handle;
}

function notARegularFile(path: string, cause?: unknown): InterlockError {
  return new InterlockError('CONFIG_INVALID', 'The daemon log is not a regular file', {
    ...(cause === undefined ? {} : { cause }),
    details: { path },
    remedy: 'Remove it, or the link in its place, and start the daemon again.',
  });
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
  /** Whether the last record was lost, so a failing disk is reported once and not per record. */
  let failing = false;

  function open(): number {
    // `mode` applies only when the file is created. One that is already there
    // was created by the CLI with the same mode, or by a daemon before it.
    const opened = openLogFile(path);
    size = fstatSync(opened).size;
    return opened;
  }

  function release(): void {
    // Forgotten before it is closed: a descriptor number is reused at once,
    // and one written to after a failed close may belong to the store.
    const held = handle;
    handle = null;
    if (held !== null) closeSync(held);
  }

  function rotate(): number {
    release();
    // Over the previous one: a rename replaces its target atomically.
    renameSync(path, rotatedLogPath(path));
    return (handle = open());
  }

  /**
   * The line a record is written as, never longer than the cap: one larger
   * would pass it whatever was rotated first, so it is replaced by a record
   * saying so.
   */
  function lineOf(record: LogRecord): string {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes <= maxBytes) return line;
    const { time, level, component } = record;
    return `${JSON.stringify({ time, level, component, msg: 'log record too large to keep', bytes })}\n`;
  }

  return {
    sink(record): void {
      if (closed) return;
      // The sink's failure is decided here, once, rather than thrown into
      // whoever logged — a `.catch` handler, a timer — where a full disk would
      // become an unhandled rejection that ends the daemon. The record is
      // dropped, the file is reopened at the next one, and the loss is said
      // once on stderr, which may be what is failing too.
      try {
        let target = handle ?? (handle = open());
        const line = lineOf(record);
        // Before the write, so no file passes the cap — and one already over
        // it from a previous run is moved aside first.
        if (size > 0 && size + Buffer.byteLength(line) > maxBytes) target = rotate();
        size += writeSync(target, line);
        failing = false;
      } catch (error) {
        try {
          release();
        } catch {
          // Already gone.
        }
        if (failing) return;
        failing = true;
        try {
          writeSync(
            2,
            `${JSON.stringify({ level: 'error', msg: 'daemon log not written', error: String(error) })}\n`,
          );
        } catch {
          // Nowhere left to say it.
        }
      }
    },
    close(): void {
      closed = true;
      release();
    },
  };
}

/**
 * Record the error the daemon dies of, as its last line.
 *
 * Through the logger once there is one writing to the file: the daemon's
 * stderr is the log file as it was when the daemon started, which a rotation
 * moves aside, so a record written there would land where `interlock daemon
 * logs` no longer looks. Before that — the config is the likeliest thing to
 * have failed, and the logger's level comes from it — on stderr, in the same
 * shape. The code and the remedy are carried rather than flattened into the
 * message: the remedy is the part a person can act on.
 */
export function recordFatal(
  error: unknown,
  logger: Logger | null,
  write: (text: string) => unknown = process.stderr.write.bind(process.stderr),
): void {
  const record = isInterlockError(error)
    ? { msg: error.message, code: error.code, remedy: error.remedy }
    : { msg: error instanceof Error ? error.message : String(error) };
  if (logger === null) {
    write(`${JSON.stringify({ level: 'error', ...record })}\n`);
    return;
  }
  const { msg, ...fields } = record;
  logger.error(msg, fields);
}
