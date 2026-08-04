import { notImplemented } from '@interlock/shared';
import type { BranchRef, Repo } from '@interlock/shared';
import type { GitRunner, UserRepo } from './repo-handle.js';

/**
 * Repo, branch and worktree discovery.
 *
 * Read-only plumbing against the user's repository: `rev-parse`,
 * `for-each-ref`, `worktree list`, `status --porcelain`.
 */

export interface DiscoveryOptions {
  readonly runner: GitRunner;
  /** Branch name globs to ignore, from the repo's config override. */
  readonly ignoreBranches?: readonly string[];
}

/** Resolve a path to the repository root that contains it. */
export function openUserRepo(_path: string, _options: DiscoveryOptions): Promise<UserRepo> {
  return notImplemented('openUserRepo', 'M1');
}

/** Read repo-level facts: default branch, shadow location, config override. */
export function describeRepo(_repo: UserRepo, _options: DiscoveryOptions): Promise<Repo> {
  return notImplemented('describeRepo', 'M1');
}

/**
 * List every in-flight line of work: local branches and linked worktrees, each
 * with its head, dirty state and, where known, owning agent session.
 */
export function listBranchRefs(_repo: UserRepo, _options: DiscoveryOptions): Promise<BranchRef[]> {
  return notImplemented('listBranchRefs', 'M1');
}

/** Merge-base of two refs; the third point of a three-way speculative merge. */
export function mergeBase(_repo: UserRepo, _a: string, _b: string, _options: DiscoveryOptions): Promise<string> {
  return notImplemented('mergeBase', 'M1');
}
