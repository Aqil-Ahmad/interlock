import { describeRepo, listBranchRefs, openUserRepo } from '@interlock/core';
import type { GitRunner, UserRepo } from '@interlock/core';
import { isInterlockError, matchesGlob, silentLogger } from '@interlock/shared';
import type { BranchRef, Logger, Repo } from '@interlock/shared';
import type { EventBus } from '../bus/index.js';
import type { Store } from '../store/index.js';

/**
 * Reconciles what git reports against what the store holds.
 *
 * This is where a path becomes a branch. The watcher deliberately resolves no
 * identity — a worktree can be checked out onto another branch between a write
 * and the lookup — so every event carrying a `branchRefId` is published from
 * here, after asking git, rather than from the signal that prompted it.
 *
 * It runs periodically as well as on signals: filesystem events are lossy on
 * macOS, and a branch created by a command that touched nothing inside a
 * watched worktree produces no signal at all.
 *
 * A store write and its event are two steps with no transaction around them, so
 * a failure between them can cost an announcement. That is a hole in the log
 * rather than in the state: the store is reconciled against git on the next
 * pass and never rebuilt from the log, so what is lost is traceability for one
 * change, not the change itself.
 */

export interface SweepOptions {
  readonly store: Store;
  readonly bus: EventBus;
  readonly runner: GitRunner;
  /** Root of Interlock's data dir; shadow paths are derived from it. */
  readonly dataDir: string;
  readonly logger?: Logger;
}

export interface SweepOutcome {
  readonly reconciled: readonly string[];
  /** Repositories that failed this pass. Each is retried on the next one. */
  readonly failed: readonly string[];
}

export interface Sweep {
  /**
   * Reconcile one repository, publishing what changed about it.
   *
   * Throws for a repository that cannot be read at all; {@link Sweep.all} is
   * what contains that.
   */
  reconcile(rootPath: string): Promise<void>;
  /** Reconcile every repository, containing a failure to the one it came from. */
  all(rootPaths: readonly string[]): Promise<SweepOutcome>;
}

export function createSweep(options: SweepOptions): Sweep {
  const log = (options.logger ?? silentLogger).child('sweep');
  const { store, bus, runner, dataDir } = options;
  /**
   * One pass per repository at a time.
   *
   * The timer and a filesystem signal are two triggers on the same work. Two
   * overlapping passes both read the stored branches before either writes, so
   * both see every branch as new and `branch.appeared` is published twice. The
   * store converges either way — upserts reconcile — but the log does not, and
   * it is append-only.
   */
  const inFlight = new Map<string, Promise<void>>();

  /**
   * The repository as it should now be stored.
   *
   * `describeRepo` re-reads `.interlock.json` on every call, which is what makes
   * a mid-session change to `ignoreBranches` take effect without a restart. A
   * malformed file is refused there, and refusing it must not cost the last good
   * config: serving a stale one is silent and permanent, while a warning here is
   * loud and recoverable the moment the file is fixed.
   */
  const describeOrKeep = async (handle: UserRepo, stored: Repo | null): Promise<Repo> => {
    try {
      return await describeRepo(handle, { runner, dataDir });
    } catch (error) {
      if (!isInterlockError(error) || error.code !== 'CONFIG_INVALID' || stored === null) {
        throw error;
      }
      log.warn('the repository override file is invalid; keeping the last good config', {
        rootPath: handle.rootPath,
        reason: error.message,
      });
      return { ...stored, lastSeenAt: new Date().toISOString() };
    }
  };

  const reconcileBranches = async (handle: UserRepo, repo: Repo): Promise<void> => {
    const observed = await listBranchRefs(handle, repo.id, {
      runner,
      ...(repo.config.ignoreBranches === undefined
        ? {}
        : { ignoreBranches: repo.config.ignoreBranches }),
    });

    // Keyed on `ref` rather than id: discovery mints a fresh ULID per
    // observation, so the id says nothing about whether this branch is new.
    const remaining = new Map((await store.listBranchRefs(repo.id)).map((ref) => [ref.ref, ref]));

    for (const branch of observed) {
      const before = remaining.get(branch.ref);
      remaining.delete(branch.ref);
      const after = await store.upsertBranchRef(branch);

      if (before === undefined) {
        await bus.publish({
          type: 'branch.appeared',
          repoId: repo.id,
          at: after.updatedAt,
          branchRefId: after.id,
          name: after.name,
          headSha: after.headSha,
          worktreePath: after.worktreePath,
        });
      } else if (moved(before, after)) {
        await bus.publish({
          type: 'branch.updated',
          repoId: repo.id,
          at: after.updatedAt,
          branchRefId: after.id,
          headSha: after.headSha,
          dirty: dirtyFlag(after),
        });
      }
    }

    const ignored = (name: string): boolean =>
      (repo.config.ignoreBranches ?? []).some((pattern) => matchesGlob(name, pattern));

    for (const gone of remaining.values()) {
      // Published before the row goes. Either order can fail between the two
      // steps, but only this one repeats itself: a delete that fails leaves the
      // branch to be reported again next sweep, where an event that fails after
      // the delete is a hole nothing will ever fill — the branch is absent from
      // git and from the store, so no later pass can notice it left.
      await bus.publish({
        type: 'branch.disappeared',
        repoId: repo.id,
        at: new Date().toISOString(),
        branchRefId: gone.id,
        // A branch the repository asked to ignore still exists. Reported as
        // deleted, a replay would read an exclusion as a destruction.
        reason: ignored(gone.name) ? 'ignored' : 'deleted',
      });
      // Its merge pairs and change sets go with it, by cascade.
      await store.deleteBranchRef(gone.id);
    }
  };

  const reconcileResolved = async (handle: UserRepo): Promise<void> => {
    // Looked up by the canonical root, not by what the caller passed.
    // `openUserRepo` resolves a subdirectory, a symlink or a linked worktree to
    // the main worktree, and that is what was stored — so looking up the
    // argument finds nothing, republishes `repo.discovered` every pass, and
    // leaves `describeOrKeep` with no last-good config to fall back on.
    const stored = await store.getRepoByPath(handle.rootPath);
    const described = await describeOrKeep(handle, stored);
    const repo = await store.upsertRepo(described);

    if (stored === null) {
      await bus.publish({
        type: 'repo.discovered',
        repoId: repo.id,
        at: repo.discoveredAt,
        rootPath: repo.rootPath,
        defaultBranch: repo.defaultBranch,
      });
    }

    await reconcileBranches(handle, repo);
  };

  /**
   * Begin a pass, claiming the repository under every spelling it is known by.
   *
   * Keyed on the caller's argument first, because that is the only thing
   * available without asking git and a check that has to await cannot exclude a
   * second caller. Once the canonical root is known the pass claims that too, so
   * a later call spelling the repository differently joins rather than
   * duplicating — and releases both, or a resolved pass would be handed to every
   * sweep afterwards and the repository would never be looked at again.
   */
  const start = (rootPath: string): Promise<void> => {
    const claimed = new Set([rootPath]);
    // The pass registers itself under a key it only learns after it has begun,
    // so it reaches its own handle through this rather than through a binding
    // that does not exist yet. Assigned before the first `await` returns.
    const self: { promise: Promise<void> | null } = { promise: null };

    const body = async (): Promise<void> => {
      const handle = await openUserRepo(rootPath, { runner });
      if (handle.rootPath !== rootPath && self.promise !== null) {
        // Only git can say that `/repo/src`, a symlink and `/repo` are one
        // worktree, so a second spelling gets this far before it can be
        // recognised. Join whoever claimed the canonical root first.
        const running = inFlight.get(handle.rootPath);
        if (running !== undefined) return running;
        claimed.add(handle.rootPath);
        inFlight.set(handle.rootPath, self.promise);
      }
      return reconcileResolved(handle);
    };

    const pass = body().finally(() => {
      // Nothing else can hold these: a call naming any of them would have joined
      // this pass rather than starting one. Both go, or a settled pass is handed
      // to every later sweep and the repository is never looked at again.
      for (const key of claimed) inFlight.delete(key);
    });
    self.promise = pass;
    inFlight.set(rootPath, pass);
    return pass;
  };

  return {
    reconcile(rootPath: string): Promise<void> {
      // Joined rather than queued: a second pass asked for while one is running
      // would read the same git state and find nothing new to say.
      return inFlight.get(rootPath) ?? start(rootPath);
    },

    async all(rootPaths: readonly string[]): Promise<SweepOutcome> {
      const reconciled: string[] = [];
      const failed: string[] = [];

      for (const rootPath of rootPaths) {
        try {
          await this.reconcile(rootPath);
          reconciled.push(rootPath);
        } catch (error) {
          // One repository's broken override file, deleted directory or wedged
          // git must not stop the repositories beside it — the same rule that
          // keeps one unreachable worktree from failing a branch listing.
          failed.push(rootPath);
          log.warn('reconciliation failed for one repository', {
            rootPath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { reconciled, failed };
    },
  };
}

/**
 * Whether anything a consumer could act on has changed.
 *
 * `worktreePath` is included even though the event does not carry it: the thing
 * downstream is a watcher holding a watch on that directory, and a branch that
 * moved to another worktree has to be re-targeted. It learns to re-read rather
 * than what to read, which is enough.
 *
 * A change to *which* files are dirty without a change to whether any are is
 * left out: that is the filesystem watcher's own signal, and repeating it here
 * would be an event carrying nothing new.
 */
function moved(before: BranchRef, after: BranchRef): boolean {
  return (
    before.headSha !== after.headSha ||
    dirtyFlag(before) !== dirtyFlag(after) ||
    before.worktreePath !== after.worktreePath
  );
}

/** `null` when the worktree could not be read, which is not clean. */
function dirtyFlag(ref: BranchRef): boolean | null {
  return ref.dirty === null ? null : ref.dirty.isDirty;
}
