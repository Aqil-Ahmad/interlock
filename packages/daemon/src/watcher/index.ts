import { notImplemented } from '@interlock/shared';
import type { InterlockConfig, Logger } from '@interlock/shared';
import type { EventBus } from '../bus/index.js';

/**
 * Discovers repos, branches, worktrees and agent sessions, and publishes what
 * changed. Read-only with respect to user state.
 *
 * Three signals are combined:
 *  1. filesystem events on worktrees, debounced, ignoring `node_modules` and build output;
 *  2. git ref changes (`.git/refs`, packed-refs, `HEAD`);
 *  3. periodic reconciliation, because filesystem events are lossy on macOS.
 *
 * Steady-state CPU budget is <2%; it is tracked by `pnpm bench`.
 */

export interface WatcherOptions {
  readonly config: InterlockConfig;
  readonly bus: EventBus;
  readonly logger: Logger;
}

export interface Watcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Force a full reconciliation pass; used at startup and by `interlock status`. */
  refresh(): Promise<void>;
}

export function createWatcher(_options: WatcherOptions): Watcher {
  return notImplemented('createWatcher');
}

export { createWorktreeWatcher } from './worktree-watcher.js';
export type {
  ChangeSignal,
  SignalKind,
  WatchFactory,
  WatchTarget,
  WorktreeWatcher,
  WorktreeWatcherOptions,
} from './worktree-watcher.js';
export { createSweep } from './sweep.js';
export type { Sweep, SweepOptions, SweepOutcome } from './sweep.js';
export { createDebouncer } from './debounce.js';
export type { DebounceOptions, Debouncer } from './debounce.js';
