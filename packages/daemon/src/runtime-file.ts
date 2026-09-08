import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runtimePath } from '@interlock/shared';
import type { DaemonRuntime, Logger } from '@interlock/shared';
import { ensureDataDir } from './data-dir.js';

/**
 * How a running daemon tells a client on this machine where to find it.
 *
 * The configured port may be `0`, so the port the CLI needs is knowable only
 * after the listener binds. This file is that answer and nothing more: it is
 * not a lock, and a daemon that crashed leaves one behind, so a client treats a
 * refused connection as the daemon being gone rather than trusting the file.
 */

/** Owner-only, like everything else under the data dir. */
const RUNTIME_FILE_MODE = 0o600;

/**
 * Publish the runtime file.
 *
 * Written under a temporary name and renamed onto the final one, which is
 * atomic within a directory — a client reading it never sees half a file, and a
 * previous daemon's file is replaced rather than truncated and rewritten.
 */
export function publishRuntime(dataDir: string, runtime: DaemonRuntime, logger: Logger): void {
  const path = runtimePath(dataDir);
  ensureDataDir(dirname(path), logger);
  const staging = `${path}.${String(runtime.pid)}.tmp`;
  try {
    writeFileSync(staging, `${JSON.stringify(runtime, null, 2)}\n`, { mode: RUNTIME_FILE_MODE });
    renameSync(staging, path);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
}

/**
 * Remove it on a clean stop.
 *
 * Failure is logged rather than raised: this runs during shutdown, and a file
 * left behind costs a client one refused connection while a throw here would
 * skip whatever the caller still has to close.
 */
export function unpublishRuntime(dataDir: string, logger: Logger): void {
  const path = runtimePath(dataDir);
  try {
    rmSync(path, { force: true });
  } catch (error) {
    logger.warn('could not remove the runtime file', {
      path,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
