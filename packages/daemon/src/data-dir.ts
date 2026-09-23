import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { InterlockError } from '@interlock/shared';
import type { Logger } from '@interlock/shared';

/**
 * The directory Interlock keeps its own state in.
 *
 * Three things land there — the database, the API token and the runtime file —
 * and each of them creates the directory if it is not already present. They
 * have to agree about what mode it gets and about what to say when it is
 * already loose, because whichever runs first is the one that decides.
 */

/** Owner-only. A directory needs `x` to be traversable; nothing inside it does. */
export const DATA_DIR_MODE = 0o700;

/**
 * Create the directory if it is not there, and report one that is already
 * readable beyond its owner.
 *
 * Only a directory this call created gets its mode set — `mkdir` masks the mode
 * it is given with the umask, so creating one is not enough on its own.
 * Tightening a directory that was already there would reach outside Interlock's
 * own state: these paths are configurable, and a database or a token dropped
 * into a home or a shared directory must not silently change that directory for
 * everything else using it. Saying so is what is left, and silence would leave
 * a loose directory looking deliberate.
 */
export function ensureDataDir(path: string, logger: Logger): void {
  if (mkdirSync(path, { recursive: true, mode: DATA_DIR_MODE }) !== undefined) {
    chmodSync(path, DATA_DIR_MODE);
    return;
  }
  if ((statSync(path).mode & 0o077) !== 0) {
    logger.warn('the directory holding Interlock state is readable beyond its owner', { path });
  }
}

/** Beside the database, and never the database: the store keeps its own locks. */
export const DATA_DIR_LOCK_FILENAME = 'daemon.lock';

/** SQLite's answer when another connection holds the lock. */
const SQLITE_BUSY = 5;

/** A data directory held by this process until `release` is called. */
export interface DataDirHold {
  release(): void;
}

/**
 * Claim the directory for one daemon, for as long as that daemon runs.
 *
 * Everything under it assumes a single writer: shadow clones are built and
 * refreshed by one process at a time, and two daemons each serialising their
 * own calls still interleave with each other — one deleting a clone the other
 * is building. A port clash stops a second daemon only when both ask for the
 * same port, so it is not the guard.
 *
 * The lock is an exclusive SQLite connection rather than a pid file, because
 * the operating system releases it when the process dies however it dies. A pid
 * file outlives a `kill -9`, and taking over a stale one has two failure modes
 * this does not: a reused pid that keeps a dead daemon's claim alive, and two
 * starting daemons that both judge the file stale and both take it.
 *
 * The file stays behind after a clean stop, and that means nothing: the claim
 * is the open connection, not the file. Removing it on release would reopen the
 * race the lock exists to close — a daemon that opened the file the moment this
 * one closed it would be left holding a name the next one recreates, and two
 * daemons would each hold a lock on a different file.
 */
export function holdDataDir(path: string, logger: Logger): DataDirHold {
  ensureDataDir(path, logger);
  const lockPath = join(path, DATA_DIR_LOCK_FILENAME);
  // No busy timeout: a second daemon should be told at once, not after waiting
  // for one that may run for weeks.
  const db = new DatabaseSync(lockPath, { timeout: 0 });
  try {
    // Nothing is ever written here, and with the lock held exclusively a
    // journal on disk would stay behind as a second file for the whole run.
    db.exec('PRAGMA journal_mode = MEMORY');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    // Exclusive from the moment the transaction begins, and kept after it ends
    // because of the locking mode — nothing is written to hold it.
    db.exec('BEGIN EXCLUSIVE');
    db.exec('COMMIT');
  } catch (error) {
    db.close();
    const errcode = (error as { errcode?: number }).errcode;
    if (errcode === SQLITE_BUSY) {
      throw new InterlockError('CONFIG_INVALID', 'Another daemon is using this data directory', {
        cause: error,
        details: { dataDir: path },
        remedy:
          'Stop the daemon already running against it, or set INTERLOCK_DATA_DIR to a different directory.',
      });
    }
    // Anything else means the file is not a lock this code can take — most
    // often not a database at all. Not deleted here: whether another daemon
    // is running is exactly what cannot be known when the lock will not open.
    throw new InterlockError('CONFIG_INVALID', 'The data directory lock could not be taken', {
      cause: error,
      details: { dataDir: path, errcode: errcode ?? null },
      remedy: `If no Interlock daemon is running, delete ${lockPath} and start again.`,
    });
  }
  return {
    release(): void {
      db.close();
    },
  };
}
