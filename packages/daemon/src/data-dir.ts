import { chmodSync, mkdirSync, statSync } from 'node:fs';
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
