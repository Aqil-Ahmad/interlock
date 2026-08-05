import { notImplemented } from '@interlock/shared';
import type { MergeOutcome } from '@interlock/shared';
import type { ShadowRepo } from '../git/repo-handle.js';
import type { ShadowWorktree } from '../git/shadow.js';

/**
 * Pairwise speculative merge.
 *
 * Both sides are commits that already exist in the shadow clone: either the
 * branch head, or a snapshot commit built from uncommitted work by
 * `git/worktree.ts`. Snapshot commits are what allow a conflict to be reported
 * before anything is committed.
 */

export interface SpeculativeMergeRequest {
  readonly shadow: ShadowRepo;
  readonly commitA: string;
  readonly commitB: string;
  readonly mergeBaseSha: string;
  /** Attempted merge strategy; `ort` is git's default three-way strategy. */
  readonly strategy?: 'ort' | 'recursive';
}

export interface SpeculativeMergeResult extends MergeOutcome {
  /** Worktree holding the merged tree; the caller disposes it. */
  readonly worktree: ShadowWorktree;
  /** Raw conflict markers per path, for the classifier. */
  readonly conflictBlocks: readonly ConflictBlock[];
  readonly durationMs: number;
}

/** One `<<<<<<< / ======= / >>>>>>>` region produced by git. */
export interface ConflictBlock {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly ours: string;
  readonly theirs: string;
  readonly base: string | null;
}

/**
 * Merge `commitB` into `commitA` inside a throwaway shadow worktree.
 *
 * A conflict is the result, not an error. This throws only when the merge could
 * not be attempted at all (`MERGE_FAILED`).
 */
export function speculativeMerge(
  _request: SpeculativeMergeRequest,
): Promise<SpeculativeMergeResult> {
  return notImplemented('speculativeMerge');
}
