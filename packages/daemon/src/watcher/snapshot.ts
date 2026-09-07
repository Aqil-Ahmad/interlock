import { captureDirtyState, extractChangeSet, mergeBase } from '@interlock/core';
import type { GitRunner, UserRepo } from '@interlock/core';
import { isInterlockError, silentLogger, ulid } from '@interlock/shared';
import type {
  BranchRef,
  BranchRefId,
  ChangeSetId,
  Logger,
  Repo,
  SnapshotId,
} from '@interlock/shared';
import type { EventBus } from '../bus/index.js';
import type { Store } from '../store/index.js';

/**
 * Turns a branch's worktree into content identity, and publishes only when that
 * identity changed.
 *
 * A filesystem signal says a file was written; it cannot say the bytes differ
 * from what was there before, and editors and agents both rewrite files
 * identically all day. Hashing the worktree to a tree answers that exactly.
 *
 * The saving is not the capture — that runs either way — but everything behind
 * it: the diff, the scheduling, and every pair that would be marked stale for a
 * change that did not happen.
 */

export interface SnapshotPipelineOptions {
  readonly store: Store;
  readonly bus: EventBus;
  readonly runner: GitRunner;
  readonly logger?: Logger;
  /**
   * How long a worktree may go unhashed while nothing reports it changing.
   *
   * Filesystem events are lossy, so a signal arriving is proof that something
   * happened and no signal arriving is not proof that nothing did. This is the
   * safety net for the second case, and its cost is one hash per worktree per
   * interval — measured at roughly half a second for ten thousand files, which
   * is what makes it a ceiling rather than a cadence.
   */
  readonly recaptureAfterMs?: number;
  /** Injectable so the ceiling can be crossed without waiting for it. */
  readonly now?: () => number;
}

export interface SnapshotPipeline {
  /**
   * Capture a branch's worktree and publish it when the content moved.
   *
   * Does nothing for a branch that is not checked out anywhere: there is no
   * worktree to hash, and its committed state is already carried by
   * `branch.updated`.
   */
  capture(handle: UserRepo, repo: Repo, branch: BranchRef): Promise<void>;
  /**
   * Record that something on disk changed under this worktree.
   *
   * Hashing a worktree costs a walk over every file in it, so a pass that runs
   * on a timer must not do it for worktrees nothing reported. A marked one is
   * hashed on the next pass; an unmarked one waits for the ceiling.
   */
  markChanged(worktreePath: string): void;
  /** Drop a worktree's remembered identity, so the next capture is published. */
  forget(worktreePath: string): void;
}

/**
 * How long a worktree may go unhashed with nothing reporting a change.
 *
 * Long enough that the periodic cost is a rounding error, short enough that a
 * filesystem event the platform dropped is noticed while the work is still in
 * progress rather than after it lands.
 */
const DEFAULT_RECAPTURE_AFTER_MS = 60_000;

/**
 * What was last said about a worktree.
 *
 * `unknown` is a state that was published rather than the absence of one: it is
 * what keeps an unreadable worktree from being announced again on every pass,
 * and what makes the next readable pass an announcement rather than a repeat.
 */
type LastPublished =
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'tree';
      /**
       * Which branch that tree was announced for.
       *
       * A worktree switched to a new branch has the same content and so the
       * same tree, but nothing downstream has heard of the branch — comparing
       * the tree alone says nothing happened, and stamps the new branch with
       * the old one's snapshot.
       */
      readonly branchRefId: BranchRefId;
      readonly treeOid: string;
      readonly snapshotId: SnapshotId;
      readonly at: number;
      readonly changed: boolean;
    };

export function createSnapshotPipeline(options: SnapshotPipelineOptions): SnapshotPipeline {
  const log = (options.logger ?? silentLogger).child('snapshot');
  const { store, bus, runner } = options;

  /**
   * Last published identity per worktree.
   *
   * Keyed on the worktree rather than the branch: the tree is a property of
   * what is on disk, and a branch that moves to another checkout is looking at
   * different files even where its head has not moved.
   */
  const lastSeen = new Map<string, LastPublished>();
  const recaptureAfterMs = options.recaptureAfterMs ?? DEFAULT_RECAPTURE_AFTER_MS;
  const now = options.now ?? Date.now;

  return {
    async capture(handle: UserRepo, repo: Repo, branch: BranchRef): Promise<void> {
      if (branch.worktreePath === null) return;

      const previous = lastSeen.get(branch.worktreePath);

      if (branch.dirty === null) {
        // The transition is the news, not the state. Downstream already knows
        // this worktree is unknown, and saying so again every pass writes
        // hundreds of identical rows an hour into a log that retention only
        // trims by age. `moved` in the sweep reads null to null as no change
        // for the same reason, and the two must not disagree about it.
        if (previous?.kind === 'unknown') return;
        lastSeen.set(branch.worktreePath, { kind: 'unknown' });
        await publish(branch, null, null, 0);
        return;
      }

      // Nothing said this worktree moved. Hashing it anyway is the whole idle
      // cost of the daemon, and it buys only the changes the filesystem failed
      // to report — which the ceiling still catches. A worktree with no entry
      // has never been hashed, so it is hashed whatever anyone reported.
      // An entry saying `unknown` falls through to the hash, so a worktree that
      // came back is announced now rather than at the ceiling.
      const sameBranch = previous?.kind === 'tree' && previous.branchRefId === branch.id;
      if (
        previous?.kind === 'tree' &&
        sameBranch &&
        !previous.changed &&
        now() - previous.at < recaptureAfterMs
      ) {
        await rememberOn(branch, previous.snapshotId);
        return;
      }

      // Cleared before the walk, not after: a signal arriving while it runs
      // describes content the walk may already have missed, and writing
      // `changed: false` on the way out would drop it until the ceiling.
      if (previous?.kind === 'tree') {
        lastSeen.set(branch.worktreePath, { ...previous, changed: false });
      }
      const snapshot = await captureDirtyState(branch.worktreePath, handle, { runner });
      const marked = lastSeen.get(branch.worktreePath);
      const changedDuringCapture = marked?.kind === 'tree' && marked.changed;

      if (previous?.kind === 'tree' && sameBranch && previous.treeOid === snapshot.treeOid) {
        // Same content, so the clock restarts: without this the ceiling stays
        // expired and every later pass hashes the worktree again.
        lastSeen.set(branch.worktreePath, {
          ...previous,
          at: now(),
          changed: changedDuringCapture,
        });
        // The row still has to name the snapshot this content belongs to; the
        // sweep re-lists every branch with a null id and would otherwise leave
        // `contentIdentity` reading two different dirty states as one.
        await rememberOn(branch, previous.snapshotId);
        return;
      }

      const snapshotId = ulid<SnapshotId>();
      const base = await baseOrNone(handle, repo, branch);
      if (base === null) {
        // Two histories with no common ancestor have no diff to speak of, and
        // an empty one would read as "this branch changed nothing".
        log.debug('no merge base; publishing the tree without a diff', {
          branch: branch.name,
        });
        lastSeen.set(branch.worktreePath, {
          kind: 'tree',
          branchRefId: branch.id,
          treeOid: snapshot.treeOid,
          snapshotId,
          at: now(),
          changed: changedDuringCapture,
        });
        await rememberOn(branch, snapshotId);
        await publish(branch, snapshot.treeOid, null, 0);
        return;
      }

      const changeSet = await extractChangeSet(handle, branch, base, {
        runner,
        snapshot: { id: snapshotId, treeOid: snapshot.treeOid },
      });
      await store.upsertChangeSet(changeSet);
      lastSeen.set(branch.worktreePath, {
        kind: 'tree',
        branchRefId: branch.id,
        treeOid: snapshot.treeOid,
        snapshotId,
        at: now(),
        changed: changedDuringCapture,
      });
      await rememberOn(branch, snapshotId);
      await publish(branch, snapshot.treeOid, changeSet.id, changeSet.files.length);
    },

    markChanged(worktreePath: string): void {
      const previous = lastSeen.get(worktreePath);
      // Recorded on the entry rather than beside it: a worktree with no entry
      // is hashed regardless, so a mark for one would be state that only ever
      // needed cleaning up.
      if (previous?.kind === 'tree') lastSeen.set(worktreePath, { ...previous, changed: true });
    },

    forget(worktreePath: string): void {
      lastSeen.delete(worktreePath);
    },
  };

  /**
   * The merge base, or `null` where the default branch is not a ref this
   * repository has.
   *
   * `mergeBase` raises rather than answering `null` for a revision it cannot
   * resolve, so a pair is never dropped in silence — but the default branch is
   * a guess: `origin/HEAD` can name a branch nobody fetched, and a detached
   * head falls back to `main` whether or not one exists. Failing the whole
   * repository on every pass for that is the worse answer, and this one is not
   * silent: the snapshot says it has no diff and the reason is logged.
   */
  async function baseOrNone(
    handle: UserRepo,
    repo: Repo,
    branch: BranchRef,
  ): Promise<string | null> {
    try {
      return await mergeBase(handle, branch.headSha, repo.defaultBranch, { runner });
    } catch (error) {
      if (!isInterlockError(error) || error.code !== 'GIT_COMMAND_FAILED') throw error;
      log.warn('the default branch does not resolve; publishing without a diff', {
        defaultBranch: repo.defaultBranch,
        branch: branch.name,
      });
      return null;
    }
  }

  /** Record which snapshot the branch's uncommitted work belongs to. */
  async function rememberOn(branch: BranchRef, snapshotId: SnapshotId): Promise<void> {
    if (branch.dirty === null || branch.dirty.snapshotId === snapshotId) return;
    await store.upsertBranchRef({
      ...branch,
      dirty: { ...branch.dirty, snapshotId },
    });
  }

  async function publish(
    branch: BranchRef,
    treeOid: string | null,
    changeSetId: ChangeSetId | null,
    fileCount: number,
  ): Promise<void> {
    await bus.publish({
      type: 'branch.snapshot',
      repoId: branch.repoId,
      at: new Date().toISOString(),
      branchRefId: branch.id,
      treeOid,
      changeSetId,
      fileCount,
    });
  }
}
