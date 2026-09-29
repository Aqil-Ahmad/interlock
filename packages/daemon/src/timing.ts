import { InterlockError } from '@interlock/shared';

/**
 * The chain from an edit on disk to its textual Finding, in one place.
 *
 * The budget is 60 seconds, and three parts of the daemon spend it: the
 * watcher, which may not hear about an edit until its next pass; the
 * scheduler, which waits for a branch to settle; and the run. Each was once
 * sized on its own with the others assumed, so changing one quietly broke the
 * budget the others were counting on. Here the parts are named together, the
 * watcher's interval is derived from what the others leave, and a
 * configuration that leaves nothing is refused rather than missed at run time.
 */

/** From an edit on disk to its textual Finding. */
export const EDIT_TO_FINDING_BUDGET_MS = 60_000;

/**
 * A branch that never goes quiet still settles this many debounces after its
 * first unplanned change.
 *
 * Agents edit continuously; a debounce alone would never fire for the branch
 * that matters most. Five debounces is ten seconds by default.
 */
export const CEILING_DEBOUNCES = 5;

/**
 * What the chain keeps for everything after the scheduler lets a pair go: the
 * pass that noticed the edit finishing, the queue, and the run.
 *
 * A pass is a status per worktree and, where one moved, a hash; a textual run
 * is milliseconds. The rest is queue wait, which has no fixed bound — so this
 * is headroom, and the bench measures what is actually spent.
 */
export const PASS_AND_RUN_ALLOWANCE_MS = 15_000;

/**
 * The longest the watcher's timer waits between passes.
 *
 * A pass over three worktrees of ten thousand files measured 375–505 ms when
 * every pass hashed; this cap is what that was sized against, and a pass that
 * only probes costs a fraction of it.
 */
export const MAX_SWEEP_INTERVAL_MS = 30_000;

/**
 * The shortest the timer may be pushed to by a long debounce.
 *
 * Every pass is a `git status` per worktree. Below this, keeping the budget
 * would cost the idle budget instead, and that is a trade to refuse rather
 * than make silently.
 */
export const MIN_SWEEP_INTERVAL_MS = 10_000;

/** How long after its first unplanned change a busy branch is settled anyway. */
export function settleCeilingMs(debounceMs: number): number {
  return debounceMs * CEILING_DEBOUNCES;
}

/**
 * How often the watcher's timer must pass for an edit nothing reported to
 * still reach a Finding inside the budget.
 *
 * An edit whose filesystem event never arrives is found by the next pass's
 * probe, then waits out the settle ceiling, then the pass and the run: this is
 * what is left for the wait before that pass, capped where a longer debounce
 * does not buy anything.
 */
export function fallbackSweepIntervalMs(debounceMs: number): number {
  const left = EDIT_TO_FINDING_BUDGET_MS - settleCeilingMs(debounceMs) - PASS_AND_RUN_ALLOWANCE_MS;
  if (left < MIN_SWEEP_INTERVAL_MS) {
    throw new InterlockError(
      'CONFIG_INVALID',
      'scheduler.debounceMs leaves no room in the 60-second budget for an edit nothing reported',
      {
        details: { debounceMs, settleCeilingMs: settleCeilingMs(debounceMs) },
        remedy: `Set scheduler.debounceMs to ${String(maxDebounceMs())} or less.`,
      },
    );
  }
  return Math.min(MAX_SWEEP_INTERVAL_MS, left);
}

/** The longest debounce the chain can carry at the shortest interval. */
export function maxDebounceMs(): number {
  return Math.floor(
    (EDIT_TO_FINDING_BUDGET_MS - PASS_AND_RUN_ALLOWANCE_MS - MIN_SWEEP_INTERVAL_MS) /
      CEILING_DEBOUNCES,
  );
}
