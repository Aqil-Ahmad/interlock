import { notImplemented } from '@interlock/shared';
import type { InterlockConfig, Logger } from '@interlock/shared';

/**
 * Composition root: the only place the watcher, bus, scheduler, store and API
 * are wired together. Everything else takes its collaborators as arguments,
 * which keeps the rest of the codebase testable without a running system.
 *
 * Startup order matters — store (migrations must succeed) → bus → API →
 * watcher → scheduler. Shutdown is the reverse and must abort in-flight runs
 * and dispose shadow worktrees, or the next start inherits stale locks.
 */

export interface DaemonOptions {
  readonly config: InterlockConfig;
  readonly logger: Logger;
}

export interface Daemon {
  start(): Promise<void>;
  /** Graceful stop: drain runs, dispose shadow worktrees, close the store. */
  stop(): Promise<void>;
  /** Stop and delete all Interlock data on this machine. */
  purge(): Promise<void>;
}

export function createDaemon(_options: DaemonOptions): Daemon {
  return notImplemented('createDaemon');
}
