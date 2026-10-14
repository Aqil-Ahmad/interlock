/**
 * `@interlock/daemon` — the long-running local service.
 *
 * Composes `@interlock/core` into a running system: watcher → event bus →
 * scheduler → merge engine → analyzers → store, plus the localhost API.
 */
export * from './bus/index.js';
export * from './watcher/index.js';
export * from './scheduler/index.js';
export * from './store/index.js';
export * from './api/index.js';
export * from './hooks/index.js';
export { createDaemon } from './daemon.js';
export type { Daemon, DaemonOptions } from './daemon.js';
export {
  DATA_DIR_LOCK_FILENAME,
  ensureDataDir,
  holdDataDir,
  isDataDirHeld,
  refuseDataDirInRepos,
} from './data-dir.js';
export type { DataDirHold } from './data-dir.js';
export { LOG_FILE_MODE, createFileSink, rotatedLogPath } from './log-file.js';
export type { FileSink } from './log-file.js';
export { inspectPurge, purgeDataDir } from './purge.js';
export type { PurgeOptions, PurgeReport } from './purge.js';
