import { notImplemented } from '@interlock/shared';
import type { GitRunner, ShadowRepo, UserRepo } from './repo-handle.js';

/**
 * Shadow clone and shadow worktree management.
 *
 * Disk strategy: one shadow clone per user repo, sharing its object store, with
 * a worktree per speculative merge. N branches then cost N checkouts rather
 * than N clones. Worktrees are disposable and garbage-collected under a quota.
 */

export interface ShadowOptions {
  readonly runner: GitRunner;
  /** Root of Interlock's data dir; shadows live under `<dataDir>/shadows/<repoId>`. */
  readonly dataDir: string;
  /** Total disk budget for shadow worktrees of this repo, in megabytes. */
  readonly diskQuotaMb?: number;
}

/**
 * The only way to obtain a writable repository handle.
 *
 * Creates the shadow clone if absent, otherwise fetches the user repo's refs
 * into it. Fetching *from* the user repo reads it; it never writes to it.
 */
export function ensureShadow(_repo: UserRepo, _options: ShadowOptions): Promise<ShadowRepo> {
  return notImplemented('ensureShadow', 'M2');
}

/** A disposable checkout inside the shadow clone, used for one merge attempt. */
export interface ShadowWorktree {
  readonly path: string;
  readonly shadow: ShadowRepo;
  /** Removes the worktree and prunes its administrative files. */
  dispose(): Promise<void>;
}

export function createShadowWorktree(
  _shadow: ShadowRepo,
  _atCommit: string,
  _options: ShadowOptions,
): Promise<ShadowWorktree> {
  return notImplemented('createShadowWorktree', 'M2');
}

/** Reclaim worktrees and objects beyond the disk quota, oldest-unused first. */
export function collectGarbage(_shadow: ShadowRepo, _options: ShadowOptions): Promise<number> {
  return notImplemented('collectGarbage', 'M2');
}
