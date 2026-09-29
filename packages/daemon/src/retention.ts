import type { Logger } from '@interlock/shared';
import type { PruneReport, Store } from './store/index.js';

/**
 * The retention window, enforced: the store pruned once shortly after start
 * and then on a timer.
 *
 * Once after start because a daemon restarted daily might never reach its first
 * interval, and a laptop that sleeps through the timer would otherwise keep
 * everything; off the startup path because a store that has not been pruned in
 * a while holds a backlog, and the daemon should be answering while it clears.
 */
export interface Retention {
  start(): void;
  /** Cancel the timer and wait for a pass in flight, so the store can close under nothing. */
  stop(): Promise<void>;
  /** Run a pass now, or join the one running. Resolves null when the pass failed. */
  pass(): Promise<PruneReport | null>;
}

export interface RetentionOptions {
  readonly store: Store;
  readonly windowMs: number;
  readonly logger: Logger;
  /** Overridable so a test does not wait out the cadence. */
  readonly intervalMs?: number;
  /** The clock the cutoff is read from. */
  readonly now?: () => number;
  /**
   * When the process that owns the store started: an unfinished run started
   * before it was left by a daemon that is gone. Left out, no unfinished run is
   * pruned — which is the answer for anything that cannot vouch for that.
   */
  readonly abandonedBefore?: string;
  /**
   * Run after the store is pruned, with its cutoff, and only when that
   * succeeded: what it may reclaim is what the store no longer names.
   */
  readonly collect?: (before: string) => Promise<void>;
}

/**
 * The longest gap between passes.
 *
 * Each pass deletes what aged out since the last, so the cadence is what keeps
 * a pass small: an hour of a busy daemon's rows is a few batches.
 */
export const RETENTION_INTERVAL_MS = 60 * 60_000;

/**
 * How often a pass runs for a window: hourly, or a quarter of the window if
 * that is sooner.
 *
 * A row can outlive the window by one interval — it ages out just after a pass
 * and waits for the next — so an hourly pass over a one-hour window would keep
 * rows for nearly two. A quarter bounds that to a quarter over at any window.
 */
export function retentionIntervalFor(windowMs: number): number {
  return Math.min(RETENTION_INTERVAL_MS, Math.floor(windowMs / 4));
}

export function createRetention(options: RetentionOptions): Retention {
  const log = options.logger.child('retention');
  const { store, windowMs } = options;
  const intervalMs = options.intervalMs ?? retentionIntervalFor(windowMs);
  const now = options.now ?? Date.now;

  let timer: ReturnType<typeof setInterval> | null = null;
  let first: ReturnType<typeof setImmediate> | null = null;
  let running: Promise<PruneReport | null> | null = null;

  const pass = (): Promise<PruneReport | null> => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };

  const run = async (): Promise<PruneReport | null> => {
    let before: string | null = null;
    // Inside the `try`, so a cutoff that is no date — a window validation should
    // have refused — fails the pass like anything else. A rejection from the
    // timer's pass has nothing to catch it, and ends the process.
    try {
      before = new Date(now() - windowMs).toISOString();
      const report = await store.prune(
        before,
        options.abandonedBefore === undefined ? {} : { abandonedBefore: options.abandonedBefore },
      );
      log.info('pruned the store', {
        before,
        windowMs,
        abandonedBefore: options.abandonedBefore ?? null,
        ...report,
      });
      if (options.collect !== undefined) await collectAfter(options.collect, before);
      return report;
    } catch (error) {
      // A pass that failed leaves everything it did not reach for the next,
      // which is an hour away; nothing is lost but disk in the meantime.
      log.warn('pruning the store failed', {
        before,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  /** A collection that throws is its own failure, not the store's, whose pruning is done. */
  const collectAfter = async (
    collect: (before: string) => Promise<void>,
    before: string,
  ): Promise<void> => {
    try {
      await collect(before);
    } catch (error) {
      log.warn('collecting after the store failed', {
        before,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    start(): void {
      if (timer !== null) return;
      first = setImmediate(() => {
        first = null;
        void pass();
      });
      timer = setInterval(() => {
        void pass();
      }, intervalMs);
      // The daemon's listener keeps the process alive; this must not.
      timer.unref();
    },

    async stop(): Promise<void> {
      if (first !== null) clearImmediate(first);
      first = null;
      if (timer !== null) clearInterval(timer);
      timer = null;
      await running;
    },

    pass,
  };
}
