import { DEFAULT_CONFIG, isInterlockError } from '@interlock/shared';
import { describe, expect, it } from 'vitest';
import {
  CEILING_DEBOUNCES,
  EDIT_TO_FINDING_BUDGET_MS,
  MAX_SWEEP_INTERVAL_MS,
  MIN_SWEEP_INTERVAL_MS,
  PASS_AND_RUN_ALLOWANCE_MS,
  fallbackSweepIntervalMs,
  maxDebounceMs,
  settleCeilingMs,
} from './timing.js';

/** The edit-to-Finding chain for an edit nothing reported: the arithmetic, checked. */
describe('the edit-to-Finding chain', () => {
  const chainMs = (debounceMs: number): number =>
    fallbackSweepIntervalMs(debounceMs) + settleCeilingMs(debounceMs) + PASS_AND_RUN_ALLOWANCE_MS;

  it('fits the budget at the default debounce, at the interval the watcher was sized for', () => {
    const debounceMs = DEFAULT_CONFIG.scheduler.debounceMs;
    expect(fallbackSweepIntervalMs(debounceMs)).toBe(MAX_SWEEP_INTERVAL_MS);
    expect(chainMs(debounceMs)).toBeLessThanOrEqual(EDIT_TO_FINDING_BUDGET_MS);
  });

  it('shortens the interval to keep the budget when the debounce grows', () => {
    const longer = 5_000;
    expect(fallbackSweepIntervalMs(longer)).toBeLessThan(MAX_SWEEP_INTERVAL_MS);
    expect(chainMs(longer)).toBe(EDIT_TO_FINDING_BUDGET_MS);
  });

  it('holds at every debounce it accepts, up to the longest', () => {
    for (let debounceMs = 0; debounceMs <= maxDebounceMs(); debounceMs += 250) {
      expect(chainMs(debounceMs), `debounce ${String(debounceMs)}`).toBeLessThanOrEqual(
        EDIT_TO_FINDING_BUDGET_MS,
      );
      expect(fallbackSweepIntervalMs(debounceMs)).toBeGreaterThanOrEqual(MIN_SWEEP_INTERVAL_MS);
    }
    expect(fallbackSweepIntervalMs(maxDebounceMs())).toBeGreaterThanOrEqual(MIN_SWEEP_INTERVAL_MS);
  });

  it('refuses a debounce that leaves no room, and says what would fit', () => {
    let refusal: unknown;
    try {
      fallbackSweepIntervalMs(maxDebounceMs() + 1);
    } catch (error) {
      refusal = error;
    }
    expect(isInterlockError(refusal) && refusal.code).toBe('CONFIG_INVALID');
    expect(isInterlockError(refusal) && refusal.remedy).toContain(String(maxDebounceMs()));
  });

  it('settles a busy branch at the ceiling multiple of its debounce', () => {
    expect(settleCeilingMs(2_000)).toBe(2_000 * CEILING_DEBOUNCES);
  });
});
