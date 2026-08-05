import { notImplemented } from '@interlock/shared';
import type { BranchRef, ChangeSet } from '@interlock/shared';
import type { GitRunner, UserRepo } from './repo-handle.js';

/**
 * ChangeSet extraction: the normalized diff of a branch against its merge-base,
 * including uncommitted work.
 *
 * Two consumers with different needs — the scheduler wants touched paths
 * cheaply, the AST layer wants hunks precise enough to map to symbols — so
 * paths are computed eagerly and hunks lazily.
 */

export interface DiffOptions {
  readonly runner: GitRunner;
  readonly ignore?: readonly string[];
  /** Skip hunk-level detail; used by the scheduler's fast overlap check. */
  readonly pathsOnly?: boolean;
}

export function extractChangeSet(
  _repo: UserRepo,
  _branch: BranchRef,
  _mergeBaseSha: string,
  _options: DiffOptions,
): Promise<ChangeSet> {
  return notImplemented('extractChangeSet');
}

/** Cheap path-level diff used to prioritise pairs before any merge is attempted. */
export function touchedPaths(
  _repo: UserRepo,
  _branch: BranchRef,
  _mergeBaseSha: string,
  _options: DiffOptions,
): Promise<string[]> {
  return notImplemented('touchedPaths');
}
