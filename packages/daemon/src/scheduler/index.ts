import { notImplemented } from '@interlock/shared';
import type { InterlockConfig, Logger, MergePair } from '@interlock/shared';
import type { EventBus } from '../bus/index.js';

/**
 * Decides which branch pairs to re-analyse and when: debouncing edits,
 * prioritising pairs whose changes overlap, invalidating incrementally when a
 * branch moves, and superseding runs that no longer describe current state.
 *
 * This is where the daemon's performance is won or lost. Read NOTES.md before
 * changing anything here.
 */

export interface SchedulerOptions {
  readonly config: InterlockConfig;
  readonly bus: EventBus;
  readonly logger: Logger;
  /** Executes one pair. Injected so the scheduler is testable without git. */
  readonly runPair: (pair: MergePair, signal: AbortSignal) => Promise<void>;
}

export interface Scheduler {
  start(): void;
  stop(): Promise<void>;
  /** Queue a pair immediately, bypassing debounce (used by `interlock check`). */
  enqueueNow(pair: MergePair): Promise<void>;
  readonly queueDepth: number;
}

export function createScheduler(_options: SchedulerOptions): Scheduler {
  return notImplemented('createScheduler');
}
