import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { captureDirtyState, extractChangeSet, mergeBase } from '@interlock/core';
import type { GitRunner, UserRepo, WorktreeSnapshot } from '@interlock/core';
import { isInterlockError, silentLogger, ulid } from '@interlock/shared';
import type {
  BranchRef,
  BranchRefId,
  ChangeSetId,
  DirtyState,
  Logger,
  Repo,
  SnapshotId,
} from '@interlock/shared';
import type { EventBus } from '../bus/index.js';
import type { ShadowRegistry } from '../shadows.js';
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
  /**
   * Where captured objects are written: each repository's shadow, never the
   * user's store, since a run commits these trees and merges them.
   */
  readonly shadows: ShadowRegistry;
  readonly logger?: Logger;
  /**
   * How long a worktree may go unhashed while its probe says nothing moved.
   *
   * The probe reads timestamps, so an edit that leaves them as they were —
   * possible only where git is told not to trust ctime — is invisible to it.
   * This is what still finds that edit eventually. It carries no budget: the
   * probe does that on every pass.
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
   * hashed on the next pass; an unmarked one only if its probe moved, or once
   * the backstop is due.
   */
  markChanged(worktreePath: string): void;
  /** Drop a worktree's remembered identity, so the next capture is published. */
  forget(worktreePath: string): void;
}

/**
 * How long a worktree may go unhashed while its probe says nothing moved.
 *
 * Every hash walks every file, and the probe has already looked at everything
 * status can see, so this only has to be short enough that an edit hidden from
 * both is not missed for good.
 */
const DEFAULT_RECAPTURE_AFTER_MS = 10 * 60_000;

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
      /**
       * The head that tree was captured against.
       *
       * A commit of exactly the work in the worktree, or a rebase that leaves
       * the files alone, moves the head and not the tree. Downstream commits the
       * tree on this head and merges from its ancestry, so the old one would
       * merge against a merge base the branch has left.
       */
      readonly headSha: string | null;
      readonly snapshotId: SnapshotId;
      readonly at: number;
      readonly changed: boolean;
      /** The probe as it read when that tree was captured; see {@link probe}. */
      readonly probe: string;
    };

export function createSnapshotPipeline(options: SnapshotPipelineOptions): SnapshotPipeline {
  const log = (options.logger ?? silentLogger).child('snapshot');
  const { store, bus, runner, shadows } = options;

  /**
   * Last published identity per worktree.
   *
   * Keyed on the worktree rather than the branch: the tree is a property of
   * what is on disk, and a branch that moves to another checkout is looking at
   * different files even where its head has not moved.
   */
  const lastSeen = new Map<string, LastPublished>();
  /**
   * The capture that last failed in each worktree, and what the probe read when
   * it did.
   *
   * One file nobody can read fails every capture of its worktree, and the
   * failure records no tree — so without this the probe, still reading as it
   * did before, sends every pass on a walk that fails at the same file. While
   * the probe holds still the same failure is reported again without the walk;
   * `chmod` moves a file's ctime, so fixing it is also what retries it.
   */
  const failed = new Map<
    string,
    {
      readonly probe: string;
      readonly headSha: string;
      readonly at: number;
      readonly error: unknown;
    }
  >();
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
        await publish(branch, null, null, null, 0);
        return;
      }

      // Nothing said this worktree moved, and its probe agrees. Hashing it
      // anyway is the whole idle cost of the daemon; the probe is what finds an
      // edit the filesystem failed to report, on this pass rather than at the
      // backstop. A worktree with no entry has never been hashed, so it is
      // hashed whatever anyone reported. An entry saying `unknown` falls
      // through to the hash, so a worktree that came back is announced now.
      const sameBranch = previous?.kind === 'tree' && previous.branchRefId === branch.id;
      const signature = await probe(branch.worktreePath, branch.dirty);
      if (
        previous?.kind === 'tree' &&
        sameBranch &&
        previous.headSha === branch.headSha &&
        !previous.changed &&
        previous.probe === signature &&
        now() - previous.at < recaptureAfterMs
      ) {
        await rememberOn(branch, previous.snapshotId);
        return;
      }
      const failure = failed.get(branch.worktreePath);
      if (
        failure?.probe === signature &&
        failure.headSha === branch.headSha &&
        !(previous?.kind === 'tree' && previous.changed) &&
        now() - failure.at < recaptureAfterMs
      ) {
        throw failure.error;
      }

      // Cleared before the walk, not after: a signal arriving while it runs
      // describes content the walk may already have missed, and writing
      // `changed: false` on the way out would drop it until the ceiling.
      if (previous?.kind === 'tree') {
        lastSeen.set(branch.worktreePath, { ...previous, changed: false });
      }
      let snapshot: WorktreeSnapshot;
      try {
        snapshot = await captureInto(handle, repo, branch.worktreePath);
      } catch (error) {
        failed.set(branch.worktreePath, {
          probe: signature,
          headSha: branch.headSha,
          at: now(),
          error,
        });
        throw error;
      }
      failed.delete(branch.worktreePath);
      const marked = lastSeen.get(branch.worktreePath);
      const changedDuringCapture = marked?.kind === 'tree' && marked.changed;

      if (
        previous?.kind === 'tree' &&
        sameBranch &&
        previous.treeOid === snapshot.treeOid &&
        previous.headSha === snapshot.headSha
      ) {
        // Same content, so the clock restarts: without this the ceiling stays
        // expired and every later pass hashes the worktree again.
        lastSeen.set(branch.worktreePath, {
          ...previous,
          at: now(),
          changed: changedDuringCapture,
          probe: signature,
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
          headSha: snapshot.headSha,
          snapshotId,
          at: now(),
          changed: changedDuringCapture,
          probe: signature,
        });
        await rememberOn(branch, snapshotId);
        await publish(branch, snapshot.treeOid, snapshot.headSha, null, 0);
        return;
      }

      const changeSet = await extractChangeSet(handle, branch, base, {
        runner,
        snapshot: { id: snapshotId, treeOid: snapshot.treeOid },
        objectStore: await shadows.get(handle, repo.id),
      });
      await store.upsertChangeSet(changeSet);
      lastSeen.set(branch.worktreePath, {
        kind: 'tree',
        branchRefId: branch.id,
        treeOid: snapshot.treeOid,
        headSha: snapshot.headSha,
        snapshotId,
        at: now(),
        changed: changedDuringCapture,
        probe: signature,
      });
      await rememberOn(branch, snapshotId);
      await publish(
        branch,
        snapshot.treeOid,
        snapshot.headSha,
        changeSet.id,
        changeSet.files.length,
      );
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
      failed.delete(worktreePath);
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

  /** Capture into the repository's shadow, dropping a shadow that refused it. */
  async function captureInto(
    handle: UserRepo,
    repo: Repo,
    worktreePath: string,
  ): Promise<WorktreeSnapshot> {
    const shadow = await shadows.get(handle, repo.id);
    try {
      return await captureDirtyState(worktreePath, handle, { runner, objectStore: shadow });
    } catch (error) {
      // A shadow removed or rebuilt underneath the handle refuses every capture
      // until something asks `ensureShadow` again.
      shadows.forget(repo.id);
      throw error;
    }
  }

  async function publish(
    branch: BranchRef,
    treeOid: string | null,
    headSha: string | null,
    changeSetId: ChangeSetId | null,
    fileCount: number,
  ): Promise<void> {
    await bus.publish({
      type: 'branch.snapshot',
      repoId: branch.repoId,
      at: new Date().toISOString(),
      branchRefId: branch.id,
      treeOid,
      headSha,
      changeSetId,
      fileCount,
    });
  }
}

/**
 * A cheap fingerprint of what `status` said about a worktree: every path it
 * listed as changed in the worktree — unstaged or untracked — with that file's
 * timestamps, size and inode as they are now.
 *
 * Nothing git is asked for here: the pass that brought the branch already ran
 * the status, against the user's own index and with optional locks off, so
 * nothing is refreshed or locked on their side. The listing alone is not
 * enough — a second edit to a file that is already modified changes nothing
 * `status` prints — which is what the stat fields are for. ctime carries it on
 * any filesystem that keeps it, since no write can set it back, so a tool that
 * restores mtime after writing still moves this; mtime, size and inode are
 * there for one that does not keep it faithfully. A clean tracked file is
 * `status`'s own to judge: it compares the same fields against the index.
 *
 * Staged paths are left out. Staging changes the index and not the worktree,
 * which is what a capture hashes, and any write to a staged file after staging
 * shows in the unstaged column. Paths are taken in the order `status` printed
 * them, which is git's own sorted order.
 *
 * A path that cannot be stat'ed — a tracked file deleted — is signed by the
 * reason, so it reads the same on every pass rather than moving the probe each
 * time.
 */
async function probe(worktreePath: string, dirty: DirtyState): Promise<string> {
  const listed = [
    ...dirty.unstagedFiles.map((path) => ['unstaged', path] as const),
    ...dirty.untrackedFiles.map((path) => ['untracked', path] as const),
  ];
  const signed = await Promise.all(
    listed.map(async ([group, path]) => {
      try {
        const stat = await lstat(join(worktreePath, path), { bigint: true });
        return [
          group,
          path,
          String(stat.ctimeNs),
          String(stat.mtimeNs),
          String(stat.size),
          String(stat.ino),
        ];
      } catch (error) {
        return [group, path, (error as NodeJS.ErrnoException).code ?? 'unreadable'];
      }
    }),
  );
  return createHash('sha256').update(JSON.stringify(signed)).digest('hex');
}
