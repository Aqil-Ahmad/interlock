import { InterlockError } from '@interlock/shared';

/**
 * Per-key coalescing of filesystem noise.
 *
 * Editors and agents produce bursts: a single save can arrive as a temp file, a
 * rename and a second write on the destination. Downstream every one of those
 * costs a `git status`, a snapshot and a ChangeSet, so collapsing them here is
 * the difference between the watcher's CPU budget and blowing it.
 *
 * Keyed per worktree rather than globally: two agents editing two worktrees are
 * independent, and one busy worktree must not delay the other's signal.
 */

export interface DebounceOptions {
  /** Quiet period after the last value before a key flushes. */
  readonly waitMs: number;
  /**
   * Upper bound on how long a key may be held back.
   *
   * A trailing debounce alone starves under a continuous writer — an agent
   * rewriting files in a loop keeps pushing the deadline out and nothing is ever
   * reported. This bounds the delay at the cost of splitting one long burst into
   * several signals, which is the right trade: a late signal is useless.
   */
  readonly maxWaitMs?: number;
  readonly onFlush: (key: string, values: readonly string[]) => void;
}

export interface Debouncer {
  /**
   * Record a value against a key, (re)starting its quiet period.
   *
   * `onFlush` runs from a timer, so whatever it throws reaches the process
   * rather than this caller.
   */
  push(key: string, value: string): void;
  /** Flush one key now, or every key when no key is given. */
  flush(key?: string): void;
  /** Drop everything pending without flushing. */
  cancel(key?: string): void;
  readonly pendingKeys: number;
}

interface Batch {
  /** Deduplicated: a burst names the same file repeatedly. */
  readonly values: Set<string>;
  timer: ReturnType<typeof setTimeout>;
  readonly firstPushedAt: number;
}

export function createDebouncer(options: DebounceOptions): Debouncer {
  const { waitMs, maxWaitMs, onFlush } = options;
  // A ceiling below the quiet period describes nothing: every batch would flush
  // at the ceiling and the quiet period would never apply. Refused rather than
  // clamped, so the misconfiguration is loud instead of silently reinterpreted.
  if (maxWaitMs !== undefined && maxWaitMs < waitMs) {
    throw new InterlockError('CONFIG_INVALID', 'The debounce ceiling is below its quiet period', {
      details: { waitMs, maxWaitMs },
      remedy: 'Set maxWaitMs to at least waitMs, or leave it unset.',
    });
  }
  const batches = new Map<string, Batch>();

  const emit = (key: string): void => {
    const batch = batches.get(key);
    if (batch === undefined) return;
    clearTimeout(batch.timer);
    batches.delete(key);
    onFlush(key, [...batch.values]);
  };

  return {
    push(key: string, value: string): void {
      const existing = batches.get(key);
      if (existing === undefined) {
        batches.set(key, {
          values: new Set([value]),
          timer: setTimeout(() => emit(key), waitMs),
          firstPushedAt: Date.now(),
        });
        return;
      }

      existing.values.add(value);
      clearTimeout(existing.timer);
      // Clamping the next deadline to what is left of the ceiling is the whole
      // mechanism: once the batch has been held that long the remainder is zero
      // and it fires, so a writer that never pauses cannot postpone it. Emitting
      // here instead would re-enter the consumer from inside an fs callback.
      const heldFor = Date.now() - existing.firstPushedAt;
      const remaining = maxWaitMs === undefined ? waitMs : Math.min(waitMs, maxWaitMs - heldFor);
      existing.timer = setTimeout(() => emit(key), remaining);
    },

    flush(key?: string): void {
      if (key !== undefined) {
        emit(key);
        return;
      }
      for (const pending of [...batches.keys()]) emit(pending);
    },

    cancel(key?: string): void {
      const drop = (pending: string): void => {
        const batch = batches.get(pending);
        if (batch === undefined) return;
        clearTimeout(batch.timer);
        batches.delete(pending);
      };

      if (key !== undefined) {
        drop(key);
        return;
      }
      for (const pending of [...batches.keys()]) drop(pending);
    },

    get pendingKeys(): number {
      return batches.size;
    },
  };
}
