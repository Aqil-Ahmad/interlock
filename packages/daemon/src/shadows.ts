import { ensureShadow } from '@interlock/core';
import type { GitRunner, ShadowRepo, UserRepo } from '@interlock/core';
import type { RepoId } from '@interlock/shared';

/**
 * One shadow handle per repository, shared by everything that writes objects.
 *
 * `ensureShadow` refreshes the clone's refs on every call — a fetch — and
 * nothing here needs those refs: the shadow borrows the user's object store
 * through alternates, so a commit the user made a second ago is already
 * readable by id. What the daemon needs is the handle, once, so it is resolved
 * once per repository and reused.
 *
 * The watcher's captures and the run pipeline's commits both land in this
 * shadow. A tree captured into the user's own store would be unreferenced there,
 * and their `gc` could reap it from under a commit made here.
 */
export interface ShadowRegistry {
  get(handle: UserRepo, repoId: RepoId): Promise<ShadowRepo>;
  /**
   * Drop a handle that failed, so the next caller resolves it afresh.
   *
   * `ensureShadow` rebuilds a clone that is missing or no longer borrows the
   * right store, which is the whole repair; a cached handle would keep
   * pointing every caller at the broken one.
   */
  forget(repoId: RepoId): void;
}

export interface ShadowRegistryOptions {
  readonly runner: GitRunner;
  readonly dataDir: string;
}

export function createShadowRegistry(options: ShadowRegistryOptions): ShadowRegistry {
  const handles = new Map<RepoId, Promise<ShadowRepo>>();
  return {
    get(handle: UserRepo, repoId: RepoId): Promise<ShadowRepo> {
      const known = handles.get(repoId);
      if (known !== undefined) return known;
      const resolving = ensureShadow(handle, { ...options, repoId });
      handles.set(repoId, resolving);
      // A failure is not remembered: the next caller tries again rather than
      // inheriting a rejection for as long as the daemon runs.
      resolving.catch(() => {
        if (handles.get(repoId) === resolving) handles.delete(repoId);
      });
      return resolving;
    },

    forget(repoId: RepoId): void {
      handles.delete(repoId);
    },
  };
}
