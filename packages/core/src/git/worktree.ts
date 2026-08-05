import { notImplemented } from '@interlock/shared';
import type { DirtyState } from '@interlock/shared';
import type { GitRunner, ShadowRepo, UserRepo } from './repo-handle.js';

/**
 * Working-tree observation and snapshotting.
 *
 * The subtle part is capturing a dirty worktree without touching the user's
 * index or stash: point `GIT_INDEX_FILE` at a temporary index under Interlock's
 * data dir, then `hash-object` + `write-tree`. That writes objects only — never
 * refs, never the user's index.
 */

export interface SnapshotOptions {
  readonly runner: GitRunner;
  /** Globs excluded from the snapshot, e.g. `node_modules`, build output. */
  readonly ignore?: readonly string[];
}

/** Capture the uncommitted state of a user worktree, read-only. */
export function captureDirtyState(
  _worktreePath: string,
  _repo: UserRepo,
  _options: SnapshotOptions,
): Promise<DirtyState> {
  return notImplemented('captureDirtyState');
}

/**
 * Materialise a snapshot as a commit **in the shadow repo only**, so the
 * speculative merge has two real commits to work with.
 */
export function commitSnapshotInShadow(
  _shadow: ShadowRepo,
  _snapshotTreeSha: string,
  _options: SnapshotOptions,
): Promise<string> {
  return notImplemented('commitSnapshotInShadow');
}
