import type { AgentSessionId, BranchRefId, RepoId, SnapshotId } from '../ids.js';

/**
 * An in-flight line of work: a branch, optionally checked out in its own
 * worktree, optionally driven by an agent session.
 *
 * This is what the watcher tracks and what the scheduler pairs up.
 */
export interface BranchRef {
  readonly id: BranchRefId;
  readonly repoId: RepoId;
  /** Full ref name, e.g. `refs/heads/feature/login`. */
  readonly ref: string;
  /** Short display name, e.g. `feature/login`. */
  readonly name: string;
  /** Commit the branch currently points at. */
  readonly headSha: string;
  /** Worktree path when this branch is checked out somewhere; null for bare refs. */
  readonly worktreePath: string | null;
  /**
   * Uncommitted work in this branch's worktree, or `null` when it could not be
   * read — a locked worktree on a volume that is gone, for instance. Distinct
   * from a clean state, which is a positive observation.
   */
  readonly dirty: DirtyState | null;
  /** Owning agent session, when one has been identified. */
  readonly sessionId: AgentSessionId | null;
  readonly firstSeenAt: string;
  readonly updatedAt: string;
}

/**
 * Snapshot of uncommitted work.
 *
 * `snapshotId` identifies the exact content that was merged, so runs can be
 * cached and invalidated precisely.
 */
export interface DirtyState {
  readonly isDirty: boolean;
  /** Content-addressed id of the working-tree state; null when clean. */
  readonly snapshotId: SnapshotId | null;
  readonly stagedFiles: readonly string[];
  readonly unstagedFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly capturedAt: string;
}

/**
 * Content identity of a branch for caching: head plus, when dirty, the snapshot
 * of uncommitted work. Runs with equal identities on both sides can reuse each
 * other's results.
 *
 * `null` when the worktree could not be read. Unobserved state has no identity
 * to key a cache on — treating it as the head alone would let a result computed
 * from a clean tree be reused for a branch whose tree is unknown.
 */
export function contentIdentity(ref: BranchRef): string | null {
  if (ref.dirty === null) return null;
  return ref.dirty.snapshotId === null ? ref.headSha : `${ref.headSha}+${ref.dirty.snapshotId}`;
}
