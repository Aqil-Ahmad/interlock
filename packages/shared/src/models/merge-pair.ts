import type { BranchRefId, MergePairId, RepoId } from '../ids.js';

/**
 * The unit of scheduling: an unordered pair of in-flight branches plus the
 * merge-base they share.
 *
 * Unordered is load-bearing — `(A,B)` and `(B,A)` must hit the same cache entry
 * — so identity always comes from {@link makePairKey}.
 */
export interface MergePair {
  readonly id: MergePairId;
  readonly repoId: RepoId;
  readonly a: BranchRefId;
  readonly b: BranchRefId;
  /** Stable identity of the pair, independent of argument order. */
  readonly key: MergePairKey;
  readonly mergeBaseSha: string;
  /** Scheduling priority; higher runs first (see scheduler notes.md). */
  readonly priority: number;
  readonly lastRunAt: string | null;
  /** True when either side moved since the last completed run. */
  readonly stale: boolean;
}

export type MergePairKey = string & { readonly __brand: 'merge-pair-key' };

/** Order-independent key for a pair of branch refs. */
export function makePairKey(a: BranchRefId, b: BranchRefId): MergePairKey {
  return (a < b ? `${a}:${b}` : `${b}:${a}`) as MergePairKey;
}
