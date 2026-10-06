import type { AnalyzerKind } from '@interlock/shared';
import type { FindingCount, Store } from './store/index.js';

/**
 * The false-positive budget: how often Interlock was wrong, by its own users'
 * account.
 *
 * A signal for fixing detectors, never a threshold: nothing reads it to decide
 * whether to raise a Finding. A rule with dismissals as wrong is a list of bugs
 * to open.
 *
 * Counted by cohort. A window holds the Findings first raised in it, and of
 * those, the ones dismissed since — whenever that was. So a rate is never above
 * 1, and an old window's can still rise as later dismissals come in. Counting
 * dismissals by when they were made would divide one set of Findings by
 * another, and a short window would read 200% after a day of catching up.
 */

/** The windows reported, in whole UTC hours including the current one. */
export const BUDGET_WINDOW_HOURS = [24, 7 * 24] as const;

const HOUR_MS = 60 * 60_000;

/** One rule's share of a window. */
export interface BudgetRule {
  readonly kind: AnalyzerKind;
  readonly rule: string;
  readonly raised: number;
  readonly dismissedWrong: number;
  readonly dismissedKnown: number;
  /** `dismissedWrong / raised`; null with nothing raised, which is no data rather than 0. */
  readonly rate: number | null;
}

export interface BudgetWindow {
  readonly hours: number;
  /** The start of the earliest hour counted: the window is exactly from here. */
  readonly since: string;
  /** When the report was made; the current hour is counted up to here. */
  readonly until: string;
  readonly raised: number;
  readonly dismissedWrong: number;
  readonly dismissedKnown: number;
  readonly rate: number | null;
  /**
   * Always null: not measured. Nothing counts a Finding reaching an agent, and
   * a zero here would claim none did.
   */
  readonly delivered: null;
  /** Most dismissed as wrong first, then most raised. Rules with nothing in the window are absent. */
  readonly rules: readonly BudgetRule[];
}

export interface BudgetReport {
  readonly windows: readonly BudgetWindow[];
}

/** The report for every window, read from counts retention never prunes. */
export async function budgetReport(store: Store, now: number = Date.now()): Promise<BudgetReport> {
  const until = new Date(now).toISOString();
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const windows: BudgetWindow[] = [];
  for (const hours of BUDGET_WINDOW_HOURS) {
    const since = new Date(currentHour - (hours - 1) * HOUR_MS).toISOString();
    const counts = await store.findingCounts(since.slice(0, 13));
    const rules = counts.map(ruleOf).sort(byDismissals);
    const raised = sum(counts, 'raised');
    const dismissedWrong = sum(counts, 'dismissedWrong');
    windows.push({
      hours,
      since,
      until,
      raised,
      dismissedWrong,
      dismissedKnown: sum(counts, 'dismissedKnown'),
      rate: rateOf(dismissedWrong, raised),
      delivered: null,
      rules,
    });
  }
  return { windows };
}

function ruleOf(count: FindingCount): BudgetRule {
  return { ...count, rate: rateOf(count.dismissedWrong, count.raised) };
}

function rateOf(wrong: number, raised: number): number | null {
  return raised === 0 ? null : wrong / raised;
}

function sum(
  counts: readonly FindingCount[],
  field: 'raised' | 'dismissedWrong' | 'dismissedKnown',
): number {
  return counts.reduce((total, count) => total + count[field], 0);
}

function byDismissals(a: BudgetRule, b: BudgetRule): number {
  return (
    b.dismissedWrong - a.dismissedWrong ||
    b.raised - a.raised ||
    (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)
  );
}
