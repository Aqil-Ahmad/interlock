import {
  captureDirtyState,
  commitSnapshotInShadow,
  assertObjectId,
  analysisBuildId,
  extractChangeSet,
  gitVersion,
  isObjectId,
  mergeBase,
  openUserRepo,
  runRequired,
  speculativeMerge,
  textualAnalyzer,
  textualFindingContent,
  textualFindingKey,
} from '@interlock/core';
import type {
  AnalyzerContext,
  AnalyzerOutcome,
  GitRunner,
  ShadowRepo,
  UserRepo,
} from '@interlock/core';
import {
  InterlockError,
  isInterlockError,
  makePairKey,
  silentLogger,
  ulid,
} from '@interlock/shared';
import type {
  BranchRef,
  BranchRefId,
  ChangeSet,
  ChangeSetId,
  EventId,
  Finding,
  FindingId,
  Logger,
  MergeOutcome,
  MergePair,
  MergePairId,
  Repo,
  RepoId,
  SnapshotId,
  SpeculativeRun,
  SpeculativeRunId,
} from '@interlock/shared';
import type { EventBus, Subscription } from '../bus/index.js';
import type { ShadowRegistry } from '../shadows.js';
import { toolchainFingerprint, verdictKey } from '../store/index.js';
import type { CachedVerdict, Store } from '../store/index.js';
import type { PairCandidate, PairPlan, PairRunRequest, PairRunResult } from './index.js';
import { pairOverlap } from './overlap.js';

/**
 * What the scheduler calls to plan and to run a pair.
 *
 * A run takes each side's content as the watcher last captured it — into the
 * shadow, so the tree is already there — commits it on the head it was captured
 * against, merges the pair against its merge base, classifies what conflicted,
 * and persists the run, its Findings and its events. Nothing here touches the
 * user's repository beyond reading it.
 */
export interface RunPipeline {
  /** Listen for the watcher's snapshots. Before the watcher starts, or its first pass is missed. */
  attach(): void;
  detach(): void;
  plan(repoId: RepoId, branchRefId: BranchRefId): Promise<PairPlan>;
  /**
   * Plan one named pair, as `plan` would plan it from either side — but never
   * declined for having nothing in common, which is the reason a person asks
   * for a pair by name.
   *
   * @throws InterlockError `BRANCH_NOT_FOUND` for a branch the store does not
   *         hold; `BRANCHES_UNRELATED` for two with no commit in common.
   */
  planPair(repoId: RepoId, a: BranchRefId, b: BranchRefId): Promise<PairCandidate>;
  runPair(request: PairRunRequest, signal: AbortSignal): Promise<PairRunResult>;
  /**
   * The trees a queued check of this repository would merge: each branch's
   * content as last seen. An idle branch's is as old as its last edit, and
   * nothing in the shadow references it, so collection has to be told.
   */
  heldTrees(repoId: RepoId): readonly string[];
}

/**
 * How long a snapshot commit is reused for its tree before another is made.
 *
 * A verdict names the commits its run merged, and a reused commit is as old as
 * the first run of its tree — on an idle default branch, as old as the daemon.
 * Bounded, a verdict's commits are never older than the verdict by more than
 * this, which is the margin collection leaves below the retention cutoff.
 */
export const SNAPSHOT_COMMIT_REUSE_MS = 60 * 60_000;

export interface RunPipelineOptions {
  readonly store: Store;
  readonly bus: EventBus;
  readonly runner: GitRunner;
  readonly shadows: ShadowRegistry;
  readonly logger?: Logger;
  /**
   * The build verdicts are keyed under: by default a digest of the code that
   * merges, classifies and redacts — `@interlock/core` and `@interlock/shared`.
   */
  readonly build?: string;
  /** {@link SNAPSHOT_COMMIT_REUSE_MS} unless given: a bench compressing a day compresses this too. */
  readonly commitReuseMs?: number;
}

/** A branch's content as the watcher last announced it. */
interface Announced {
  /** Null only on an event with no repository, which the watcher never publishes. */
  readonly repoId: RepoId | null;
  readonly treeOid: string | null;
  readonly headSha: string | null;
  readonly changeSetId: ChangeSetId | null;
  readonly at: string;
  /**
   * The watcher captured this tree, so the change set named beside it was
   * computed from it. False for a tree captured inside a run, which keeps the
   * last change set for ranking but has no snapshot of its own.
   */
  readonly announced: boolean;
}

/**
 * One side of a pair as content: what a verdict is keyed on.
 *
 * Found without git wherever it can be — the watcher already said which tree a
 * worktree holds, and a commit's tree never changes — so that a pair at
 * content already judged is answered before anything is captured, committed
 * or merged.
 */
interface Identified {
  readonly branch: BranchRef;
  readonly headSha: string;
  readonly treeOid: string;
  /**
   * For a branch no worktree holds, null until the side is merged: it is a
   * diff, and only the analyzer reads it.
   */
  readonly changeSet: ChangeSet | null;
  /** The watcher's snapshot of exactly this tree; null for a side it never snapshotted. */
  readonly snapshotId: SnapshotId | null;
  /** When the tree was captured; null for a branch no worktree holds, whose side is its head. */
  readonly capturedAt: string | null;
}

/** One side of a pair, ready to merge. */
interface Side extends Identified {
  readonly commit: string;
}

interface Skip {
  readonly skip: 'unreadable' | 'unborn';
}

export function createRunPipeline(options: RunPipelineOptions): RunPipeline {
  const { store, bus, runner, shadows } = options;
  const build = options.build ?? analysisBuildId();
  const commitReuseMs = options.commitReuseMs ?? SNAPSHOT_COMMIT_REUSE_MS;
  const log = (options.logger ?? silentLogger).child('run-pipeline');

  const announced = new Map<BranchRefId, Announced>();
  /**
   * Commits already made for a tree on a head.
   *
   * Each `commit-tree` of the same tree makes a new commit, since the time is
   * part of it; the tree is the identity and the first commit serves every
   * later merge of it.
   */
  const commits = new Map<string, { readonly sha: string; readonly madeAt: number }>();
  /**
   * Committed-only change sets for branches no worktree holds, by head.
   *
   * The watcher snapshots only checked-out branches, so without these every
   * other local branch — a repository's old, finished ones — reads as unknown
   * overlap, and unknown is always merged: every one of them, on every settle.
   */
  const committed = new Map<string, ChangeSet | null>();
  /**
   * A commit's tree, by commit. Immutable, so remembered without checking:
   * the answer cannot change, and asking again would be git on the path a
   * cached verdict exists to keep free of it.
   */
  const trees = new Map<string, string>();
  /**
   * The merge base of two heads, by head pair: immutable for the same reason,
   * and shared with planning, which asks first.
   */
  const bases = new Map<string, string | null>();
  const subscriptions: Subscription[] = [];
  const handles = new Map<RepoId, Promise<UserRepo>>();

  const handleOf = (repo: Repo): Promise<UserRepo> => {
    const known = handles.get(repo.id);
    if (known !== undefined) return known;
    const opening = openUserRepo(repo.rootPath, { runner });
    handles.set(repo.id, opening);
    opening.catch(() => {
      if (handles.get(repo.id) === opening) handles.delete(repo.id);
    });
    return opening;
  };

  const repoOf = async (repoId: RepoId): Promise<Repo | null> =>
    (await store.listRepos()).find((repo) => repo.id === repoId) ?? null;

  const changeSetOf = async (
    repo: Repo,
    handle: UserRepo,
    branch: BranchRef,
  ): Promise<ChangeSet | null> => {
    if (branch.worktreePath !== null) {
      const id = announced.get(branch.id)?.changeSetId ?? null;
      return id === null ? null : store.getChangeSet(id);
    }
    const key = `${branch.id}:${branch.headSha}`;
    if (committed.has(key)) return committed.get(key)!;
    const found = await committedChanges(repo, handle, branch);
    remember(committed, key, found);
    return found;
  };

  /**
   * A branch's committed changes against its merge base with the default
   * branch — the same comparison the watcher's change sets make.
   *
   * Null where the default branch does not resolve: `mergeBase` raises for a
   * revision it cannot find, and a guess here would rank a pair on nothing.
   */
  const committedChanges = async (
    repo: Repo,
    handle: UserRepo,
    branch: BranchRef,
  ): Promise<ChangeSet | null> => {
    let base: string | null;
    try {
      base = await mergeBase(handle, branch.headSha, repo.defaultBranch, { runner });
    } catch (error) {
      if (!isInterlockError(error) || error.code !== 'GIT_COMMAND_FAILED') throw error;
      return null;
    }
    return base === null ? null : extractChangeSet(handle, branch, base, { runner });
  };

  /**
   * A side as content: the watcher's tree on the head it was captured against,
   * or the head itself for a branch with no worktree.
   *
   * No git for a side the watcher announced, nor for a head seen before. A
   * worktree the watcher never announced is captured here.
   */
  const identify = async (
    repo: Repo,
    handle: UserRepo,
    shadow: ShadowRepo,
    branch: BranchRef,
  ): Promise<Identified | Skip> => {
    if (branch.worktreePath === null) {
      // Read back from storage, and about to be resolved and remembered: a ref
      // name here would be merged as whatever it names now.
      assertObjectId(branch.headSha, 'headSha');
      return {
        branch,
        headSha: branch.headSha,
        treeOid: await treeOfHead(shadow, branch.headSha),
        // Only the analyzer reads it, and for this side it is a diff: left to a
        // miss rather than paid by a hit.
        changeSet: null,
        snapshotId: null,
        capturedAt: null,
      };
    }
    const changeSet = await changeSetOf(repo, handle, branch);
    const seen =
      announced.get(branch.id) ??
      (await recapture(repo, handle, shadow, branch, branch.worktreePath));
    return fromSeen(branch, changeSet, seen);
  };

  const fromSeen = (
    branch: BranchRef,
    changeSet: ChangeSet | null,
    seen: Announced,
  ): Identified | Skip => {
    if (seen.treeOid === null) return { skip: 'unreadable' };
    if (seen.headSha === null) return { skip: 'unborn' };
    return {
      branch,
      headSha: seen.headSha,
      treeOid: seen.treeOid,
      changeSet,
      snapshotId: seen.announced ? (changeSet?.snapshotId ?? null) : null,
      capturedAt: seen.at,
    };
  };

  const treeOfHead = async (shadow: ShadowRepo, headSha: string): Promise<string> => {
    const known = trees.get(headSha);
    if (known !== undefined) return known;
    const tree = await runRequired(runner, shadow, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${headSha}^{tree}`,
    ]);
    const treeOid = tree.stdout.trim();
    if (!isObjectId(treeOid)) {
      throw new InterlockError('GIT_COMMAND_FAILED', 'git named no tree for a branch head', {
        remedy:
          'Report the git version in use; its rev-parse output differs from the documented form.',
        infra: true,
      });
    }
    remember(trees, headSha, treeOid);
    return treeOid;
  };

  const baseOf = async (handle: UserRepo, headA: string, headB: string): Promise<string | null> => {
    // Symmetric, so one entry answers the pair whichever side planned it.
    const key = headA < headB ? `${headA}:${headB}` : `${headB}:${headA}`;
    if (bases.has(key)) return bases.get(key)!;
    const base = await mergeBase(handle, headA, headB, { runner });
    remember(bases, key, base);
    return base;
  };

  /**
   * Commit a side so it can be merged.
   *
   * A tree the shadow does not hold — the shadow was rebuilt since, or the
   * capture predates this daemon's captures moving into it — is captured again
   * here, once, which is the whole remedy for `SNAPSHOT_STALE`. The side that
   * comes back may then be different content from the one identified.
   */
  const materialise = async (
    repo: Repo,
    handle: UserRepo,
    shadow: ShadowRepo,
    side: Identified,
  ): Promise<Side | Skip> => {
    if (side.capturedAt === null) {
      return {
        ...side,
        changeSet: await changeSetOf(repo, handle, side.branch),
        commit: side.headSha,
      };
    }
    try {
      return {
        ...side,
        commit: await commitOf(shadow, side.treeOid, side.headSha, side.capturedAt),
      };
    } catch (error) {
      if (!isInterlockError(error) || error.code !== 'SNAPSHOT_STALE') throw error;
    }
    const worktreePath = side.branch.worktreePath!;
    const seen = await recapture(repo, handle, shadow, side.branch, worktreePath);
    const again = fromSeen(side.branch, side.changeSet, seen);
    if ('skip' in again) return again;
    return {
      ...again,
      commit: await commitOf(shadow, again.treeOid, again.headSha, again.capturedAt!),
    };
  };

  /** The textual analyzer's fingerprint: its version, the git that merges, and this build. */
  const textualFingerprint = async (shadow: ShadowRepo): Promise<string> =>
    toolchainFingerprint({
      analyzer: textualAnalyzer.name,
      version: textualAnalyzer.version,
      tools: [`git ${await gitVersion(runner, shadow)}`, `interlock ${build}`],
    });

  const recapture = async (
    repo: Repo,
    handle: UserRepo,
    shadow: ShadowRepo,
    branch: BranchRef,
    worktreePath: string,
  ): Promise<Announced> => {
    const snapshot = await captureDirtyState(worktreePath, handle, {
      runner,
      objectStore: shadow,
    });
    log.debug('captured a side the watcher had not', { repoId: repo.id, branch: branch.name });
    const seen: Announced = {
      repoId: repo.id,
      treeOid: snapshot.treeOid,
      headSha: snapshot.headSha,
      changeSetId: announced.get(branch.id)?.changeSetId ?? null,
      at: snapshot.capturedAt,
      announced: false,
    };
    announced.set(branch.id, seen);
    return seen;
  };

  const commitOf = async (
    shadow: ShadowRepo,
    treeOid: string,
    headSha: string,
    capturedAt: string,
  ): Promise<string> => {
    const key = `${treeOid}:${headSha}`;
    const known = commits.get(key);
    // Checked, not trusted: a shadow rebuilt while the daemon runs keeps its
    // path and loses every commit made in it, and a cached one would fail
    // every merge of a side that never changes again — usually the default
    // branch, and every pair against it.
    if (known !== undefined && Date.now() - known.madeAt < commitReuseMs) {
      const present = await runner.run(shadow, ['cat-file', '-e', `${known.sha}^{commit}`]);
      if (present.exitCode === 0) return known.sha;
    }
    commits.delete(key);
    const made = await commitSnapshotInShadow(
      shadow,
      { treeOid, headSha, clean: false, takenAs: 'whole-tree', capturedAt },
      { runner },
    );
    remember(commits, key, { sha: made.commitSha, madeAt: Date.now() });
    return made.commitSha;
  };

  /**
   * The Findings only a run of their pair can end: open ones, and dismissals
   * still holding a conflict back. A pair holding either is planned whatever
   * its overlap — undoing the conflicting edit is exactly what removes the
   * overlap, and a dismissal no run ever comes back to is kept for good.
   */
  const heldFindings = async (repoId: RepoId): Promise<Finding[]> => [
    ...(await store.listOpenFindings(repoId)),
    ...(await store.listDismissedFindings(repoId)),
  ];

  const plan = async (repoId: RepoId, branchRefId: BranchRefId): Promise<PairPlan> => {
    const repo = await repoOf(repoId);
    if (repo === null) return { candidates: [], declined: 0 };
    const branches = await store.listBranchRefs(repoId);
    const moved = branches.find((branch) => branch.id === branchRefId);
    if (moved === undefined) return { candidates: [], declined: 0 };
    const handle = await handleOf(repo);
    const stored = new Map((await store.listMergePairs(repoId)).map((pair) => [pair.key, pair]));
    const withFindings = new Set(
      (await heldFindings(repoId)).map((finding) =>
        makePairKey(finding.attribution.branchA, finding.attribution.branchB),
      ),
    );
    const movedChanges = await changeSetOf(repo, handle, moved);

    const candidates: PairCandidate[] = [];
    let declined = 0;
    for (const other of branches) {
      if (other.id === moved.id) continue;
      const target = moved.name === repo.defaultBranch || other.name === repo.defaultBranch;
      const overlap = pairOverlap(movedChanges, await changeSetOf(repo, handle, other));
      const key = makePairKey(moved.id, other.id);
      const openFindings = withFindings.has(key);
      // Declined before git is asked for a merge base, which would be the only
      // cost it had: a pair with nothing in common cannot conflict textually.
      if (overlap.tier === 'none' && !target && !openFindings) {
        declined += 1;
        continue;
      }
      const base = await baseOf(handle, moved.headSha, other.headSha);
      if (base === null) continue;
      const [a, b] = moved.id < other.id ? [moved.id, other.id] : [other.id, moved.id];
      const pair = await store.upsertMergePair({
        id: stored.get(key)?.id ?? ulid<MergePairId>(),
        repoId,
        a,
        b,
        key,
        mergeBaseSha: base,
        priority: stored.get(key)?.priority ?? 0,
        lastRunAt: stored.get(key)?.lastRunAt ?? null,
        // A side moved, so the last run no longer describes the pair.
        stale: true,
      });
      candidates.push({ pair, overlap, target, openFindings });
    }
    return { candidates, declined };
  };

  const planPair = async (
    repoId: RepoId,
    a: BranchRefId,
    b: BranchRefId,
  ): Promise<PairCandidate> => {
    const repo = await repoOf(repoId);
    const branches = repo === null ? [] : await store.listBranchRefs(repoId);
    const [one, two] = [a, b].map((id) => branches.find((branch) => branch.id === id));
    if (repo === null || one === undefined || two === undefined) {
      throw new InterlockError('BRANCH_NOT_FOUND', 'A branch of the pair is no longer there', {
        details: { repoId, a, b },
        remedy: 'List the branches with `interlock status` and check again.',
      });
    }
    const handle = await handleOf(repo);
    const base = await baseOf(handle, one.headSha, two.headSha);
    if (base === null) {
      throw new InterlockError('BRANCHES_UNRELATED', 'The two branches share no history', {
        details: { a: one.id, b: two.id },
        remedy:
          'There is no merge base, so there is no merge to check. Pick two branches cut from one another.',
      });
    }
    const key = makePairKey(one.id, two.id);
    const stored = (await store.listMergePairs(repoId)).find((pair) => pair.key === key);
    const [x, y] = one.id < two.id ? [one.id, two.id] : [two.id, one.id];
    const pair = await store.upsertMergePair({
      id: stored?.id ?? ulid<MergePairId>(),
      repoId,
      a: x,
      b: y,
      key,
      mergeBaseSha: base,
      priority: stored?.priority ?? 0,
      lastRunAt: stored?.lastRunAt ?? null,
      stale: true,
    });
    const openFindings = (await heldFindings(repoId)).some(
      (finding) => makePairKey(finding.attribution.branchA, finding.attribution.branchB) === key,
    );
    return {
      pair,
      overlap: pairOverlap(
        await changeSetOf(repo, handle, one),
        await changeSetOf(repo, handle, two),
      ),
      target: one.name === repo.defaultBranch || two.name === repo.defaultBranch,
      openFindings,
    };
  };

  const runPair = async (request: PairRunRequest, signal: AbortSignal): Promise<PairRunResult> => {
    const { pair } = request.candidate;
    const repo = await repoOf(pair.repoId);
    const branches = repo === null ? [] : await store.listBranchRefs(repo.id);
    const branchA = branches.find((branch) => branch.id === pair.a);
    const branchB = branches.find((branch) => branch.id === pair.b);
    if (repo === null || branchA === undefined || branchB === undefined) {
      return { kind: 'skipped', reason: 'branch-gone' };
    }

    const handle = await handleOf(repo);
    // Held for the whole run: collection must not decide an object is garbage
    // between this run writing it, or finding it already written, and a merge
    // or a Finding naming it.
    return shadows.use(handle, repo.id, (shadow) =>
      analyse(request, signal, repo, handle, shadow, branchA, branchB),
    );
  };

  const analyse = async (
    request: PairRunRequest,
    signal: AbortSignal,
    repo: Repo,
    handle: UserRepo,
    shadow: ShadowRepo,
    branchA: BranchRef,
    branchB: BranchRef,
  ): Promise<PairRunResult> => {
    const { pair } = request.candidate;
    const idA = await identify(repo, handle, shadow, branchA);
    if ('skip' in idA) return { kind: 'skipped', reason: idA.skip };
    const idB = await identify(repo, handle, shadow, branchB);
    if ('skip' in idB) return { kind: 'skipped', reason: idB.skip };
    const base = await baseOf(handle, idA.headSha, idB.headSha);
    if (base === null) return { kind: 'skipped', reason: 'unrelated' };

    const fingerprint = await textualFingerprint(shadow);
    const keyOf = (a: Identified, b: Identified, mergeBaseSha: string): string =>
      verdictKey({
        fingerprint,
        branchA: a.branch.id,
        treeA: a.treeOid,
        branchB: b.branch.id,
        treeB: b.treeOid,
        mergeBaseSha,
        shadowGeneration: shadow.generation,
      });

    // The verdict's own key, so the two checks agree on what is the same: a
    // pair at unchanged content in a rebuilt clone, or under another toolchain,
    // is not a duplicate of the analysis it had before.
    const contentKey = keyOf(idA, idB, base);
    if (!request.isNew(contentKey)) {
      // Planning marked the pair stale because a side moved; a side that moved
      // back to content already analysed leaves the last run describing it.
      await store.upsertMergePair({ ...pair, mergeBaseSha: base, stale: false });
      return { kind: 'duplicate', contentKey };
    }

    const cached = await store.getCachedVerdict(contentKey);
    const origin = cached === null ? null : await store.getRun(cached.runId);
    if (cached !== null && origin?.mergeOutcome != null) {
      return reuse(request, signal, repo, [idA, idB], base, contentKey, {
        ...cached,
        mergeOutcome: origin.mergeOutcome,
      });
    }

    const sideA = await materialise(repo, handle, shadow, idA);
    if ('skip' in sideA) return { kind: 'skipped', reason: sideA.skip };
    const sideB = await materialise(repo, handle, shadow, idB);
    if ('skip' in sideB) return { kind: 'skipped', reason: sideB.skip };
    // A side captured again is new content, on a head that may have moved.
    const mergeBaseSha =
      sideA.headSha === idA.headSha && sideB.headSha === idB.headSha
        ? base
        : await baseOf(handle, sideA.headSha, sideB.headSha);
    if (mergeBaseSha === null) return { kind: 'skipped', reason: 'unrelated' };

    const { run, stored, started, finish } = await begin(
      request,
      repo,
      [sideA, sideB],
      mergeBaseSha,
    );

    try {
      if (signal.aborted) {
        await finish('superseded', {});
        return { kind: 'superseded' };
      }

      const mergeRequest = {
        shadow,
        commitA: sideA.commit,
        commitB: sideB.commit,
        mergeBaseSha,
      };
      let merged;
      try {
        merged = await speculativeMerge(mergeRequest, { runner });
      } catch (error) {
        // A commit the shadow no longer has: the shadow was rebuilt or removed
        // under its handle, and the next attempt should resolve it afresh.
        if (isInterlockError(error) && error.code === 'SNAPSHOT_STALE') shadows.forget(repo.id);
        throw error;
      }
      const mergedEvent = await bus.publish(
        {
          type: 'run.merge-completed',
          repoId: repo.id,
          at: new Date().toISOString(),
          runId: run.id,
          clean: merged.clean,
          conflictedPaths: merged.conflictedPaths,
        },
        { causedBy: started },
      );

      const analyzerStartedAt = Date.now();
      const context: AnalyzerContext = {
        runId: run.id,
        branchA: branchA.id,
        branchB: branchB.id,
        changeSetA: sideA.changeSet,
        changeSetB: sideB.changeSet,
        mergeRequest,
        merged,
        // Nothing here runs in a slot until a semantic analyzer does.
        slot: null,
        runner,
        logger: log,
        signal,
      };
      // A clean merge has no textual conflict, which is a verdict rather than
      // an analyzer that did not apply.
      const outcome: AnalyzerOutcome = textualAnalyzer.appliesTo(context)
        ? await textualAnalyzer.analyze(context)
        : { verdict: 'clean', findings: [] };
      const analyzerMs = Date.now() - analyzerStartedAt;
      const analyzed = await bus.publish(
        {
          type: 'run.analyzer-completed',
          repoId: repo.id,
          at: new Date().toISOString(),
          runId: run.id,
          analyzer: 'textual',
          verdict: outcome.verdict,
          durationMs: analyzerMs,
        },
        { causedBy: mergedEvent },
      );
      const mergeOutcome = {
        clean: merged.clean,
        conflictedPaths: merged.conflictedPaths,
        // The merge writes a tree and no commit; a commit is made only for a
        // slot of the worktree pool.
        mergedSha: null,
      };

      if (outcome.verdict === 'infra-failure') {
        await finish('failed', { mergeOutcome });
        return {
          kind: 'infra-failure',
          component: 'analyzer:textual',
          message: outcome.diagnostic ?? 'the textual analyzer could not run',
        };
      }

      // The discard point: a branch in this pair moved while it ran, so what it
      // found describes content that is already gone.
      if (signal.aborted) {
        await finish('superseded', { mergeOutcome });
        return { kind: 'superseded' };
      }

      const findingIds = await reconcileFindings(repo.id, stored, outcome.findings, analyzed);
      await store.upsertMergePair({ ...stored, lastRunAt: new Date().toISOString(), stale: false });
      const result = {
        analyzer: 'textual',
        verdict: outcome.verdict,
        findingIds,
        durationMs: analyzerMs,
        cached: false,
        diagnostic: outcome.diagnostic ?? null,
      } as const;
      const finished = await finish('complete', {
        mergeOutcome,
        findingIds,
        analyzerResults: [result],
      });
      // Keyed on what was merged, which a side captured again may have changed.
      await cacheVerdict(keyOf(sideA, sideB, mergeBaseSha), {
        result,
        runId: run.id,
        findings: outcome.findings,
      });
      return {
        kind: 'analysed',
        runId: run.id,
        contentKey: keyOf(sideA, sideB, mergeBaseSha),
        clean: merged.clean,
        cached: false,
        findingCount: findingIds.length,
        finished,
      };
    } catch (error) {
      await finish('failed', {}).catch((recording: unknown) => {
        log.warn('could not record a failed run', {
          runId: run.id,
          reason: recording instanceof Error ? recording.message : String(recording),
        });
      });
      throw error;
    }
  };

  /**
   * Remember a completed run's verdict, never failing the run for it.
   *
   * The run is already recorded complete and its Findings written; the cache
   * only saves the next run of the same content its work. A write that fails
   * here, propagated, would reach the run's own failure path and record the
   * completed run as failed over the top of its result.
   */
  const cacheVerdict = async (key: string, verdict: CachedVerdict): Promise<void> => {
    try {
      await store.putCachedVerdict(key, verdict);
    } catch (error) {
      log.warn('could not cache a verdict', {
        runId: verdict.runId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * Record a run for a pair, publish its start, and hand back how to end it:
   * every started run gets a `run.finished`.
   */
  const begin = async (
    request: PairRunRequest,
    repo: Repo,
    [sideA, sideB]: readonly [Identified, Identified],
    mergeBaseSha: string,
  ): Promise<{
    readonly run: SpeculativeRun;
    readonly stored: MergePair;
    readonly started: EventId;
    readonly finish: (
      status: 'complete' | 'superseded' | 'failed',
      patch: Partial<SpeculativeRun>,
    ) => Promise<EventId>;
  }> => {
    const stored = await store.upsertMergePair({
      ...request.candidate.pair,
      mergeBaseSha,
      priority: request.priority,
    });
    const run: SpeculativeRun = {
      id: ulid<SpeculativeRunId>(),
      mergePairId: stored.id,
      snapshotA: sideA.snapshotId ?? ulid<SnapshotId>(),
      snapshotB: sideB.snapshotId ?? ulid<SnapshotId>(),
      status: 'running',
      mergeOutcome: null,
      analyzerResults: [],
      findingIds: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
    };
    await store.upsertRun(run);
    const started = await bus.publish(
      {
        type: 'run.started',
        repoId: repo.id,
        at: run.startedAt,
        runId: run.id,
        mergePairId: stored.id,
      },
      { causedBy: request.cause },
    );
    const startedAt = Date.now();

    const finish = async (
      status: 'complete' | 'superseded' | 'failed',
      patch: Partial<SpeculativeRun>,
    ): Promise<EventId> => {
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startedAt;
      await store.upsertRun({ ...run, ...patch, status, finishedAt, durationMs });
      return bus.publish(
        {
          type: 'run.finished',
          repoId: repo.id,
          at: finishedAt,
          runId: run.id,
          status,
          findingCount: patch.findingIds?.length ?? 0,
          durationMs,
        },
        { causedBy: started },
      );
    };
    return { run, stored, started, finish };
  };

  /**
   * Answer a pair from a verdict reached on the same content: a run of its
   * own, with no capture, commit, merge or analyzer.
   *
   * The verdict's Findings are reconciled exactly as the run that reached it
   * reconciled them, so what a hit persists is what that run would persist
   * now — an open Finding for the same conflict keeps its identity, the
   * cached evidence replaces whatever a run on other content last wrote, and
   * the pair's other open Findings are resolved. Each is stamped as this run's
   * output, since this run is what raises it again; `cachedFrom` on the
   * analyzer's event names the run whose analysis it was.
   */
  const reuse = async (
    request: PairRunRequest,
    signal: AbortSignal,
    repo: Repo,
    sides: readonly [Identified, Identified],
    mergeBaseSha: string,
    contentKey: string,
    cached: CachedVerdict & { readonly mergeOutcome: MergeOutcome },
  ): Promise<PairRunResult> => {
    const { run, stored, started, finish } = await begin(request, repo, sides, mergeBaseSha);
    try {
      if (signal.aborted) {
        await finish('superseded', {});
        return { kind: 'superseded' };
      }
      const analyzed = await bus.publish(
        {
          type: 'run.analyzer-completed',
          repoId: repo.id,
          at: new Date().toISOString(),
          runId: run.id,
          analyzer: cached.result.analyzer,
          verdict: cached.result.verdict,
          durationMs: 0,
          cachedFrom: cached.runId,
        },
        { causedBy: started },
      );
      // The discard point, as for a run: a branch that moved while the hit was
      // recorded leaves its verdict describing content already gone.
      if (signal.aborted) {
        await finish('superseded', {});
        return { kind: 'superseded' };
      }
      const now = new Date().toISOString();
      const raised = cached.findings.map((finding): Finding => ({
        ...finding,
        id: ulid<FindingId>(),
        runId: run.id,
        firstSeenAt: now,
        updatedAt: now,
      }));
      const findingIds = await reconcileFindings(repo.id, stored, raised, analyzed);
      await store.upsertMergePair({ ...stored, lastRunAt: now, stale: false });
      const finished = await finish('complete', {
        mergeOutcome: cached.mergeOutcome,
        findingIds,
        analyzerResults: [{ ...cached.result, findingIds, cached: true }],
      });
      return {
        kind: 'analysed',
        runId: run.id,
        contentKey,
        clean: cached.mergeOutcome.clean,
        cached: true,
        findingCount: findingIds.length,
        finished,
      };
    } catch (error) {
      await finish('failed', {}).catch((recording: unknown) => {
        log.warn('could not record a failed run', {
          runId: run.id,
          reason: recording instanceof Error ? recording.message : String(recording),
        });
      });
      throw error;
    }
  };

  /**
   * Write a run's Findings over the pair's open and dismissed ones.
   *
   * The same conflict is found on every run while both branches sit still, so a
   * Finding that matches an open one by `textualFindingKey` takes over that
   * one's id, `firstSeenAt` and run — a Finding belongs to the run that raised
   * it, which the store keeps while the Finding is open — rather than opening a
   * duplicate. An open one the run did not reproduce is resolved.
   *
   * A Finding matching a dismissed one on the key and on each side's content
   * is the conflict a human already judged, at the content they judged: it
   * raises nothing, and the dismissal stands. Matched on the key alone, an edit
   * anywhere in the file would stay hidden behind a verdict about other code.
   * A dismissal the run did not find at its content has stopped reproducing,
   * and is ended, so the conflict coming back is raised as new.
   */
  const reconcileFindings = async (
    repoId: RepoId,
    pair: MergePair,
    found: readonly Finding[],
    cause: EventId,
  ): Promise<Finding['id'][]> => {
    const now = new Date().toISOString();
    const ofPair = (finding: Finding): boolean =>
      finding.kind === 'textual' &&
      makePairKey(finding.attribution.branchA, finding.attribution.branchB) === pair.key;
    const open = (await store.listOpenFindings(repoId)).filter(ofPair);
    const byKey = new Map(open.map((finding) => [textualFindingKey(finding), finding]));
    const dismissed = (await store.listDismissedFindings(repoId)).filter(ofPair);
    const holding = new Set<Finding['id']>();

    const ids: Finding['id'][] = [];
    for (const finding of found) {
      const key = textualFindingKey(finding);
      const content = textualFindingContent(finding);
      const judged = dismissed.find(
        (dismissal) =>
          key !== null &&
          content !== null &&
          textualFindingKey(dismissal) === key &&
          textualFindingContent(dismissal) === content,
      );
      if (judged !== undefined) {
        holding.add(judged.id);
        continue;
      }
      const previous = byKey.get(key);
      if (previous !== undefined) {
        byKey.delete(key);
        await store.upsertFinding({
          ...finding,
          id: previous.id,
          runId: previous.runId,
          firstSeenAt: previous.firstSeenAt,
        });
        ids.push(previous.id);
        continue;
      }
      await store.raiseFinding(finding);
      ids.push(finding.id);
      await bus.publish(
        {
          type: 'finding.raised',
          repoId,
          at: finding.firstSeenAt,
          findingId: finding.id,
          runId: finding.runId,
          kind: finding.kind,
          rule: finding.rule,
        },
        { causedBy: cause },
      );
    }

    for (const gone of byKey.values()) {
      // Dismissed since it was read: the dismissal is the newer word on it.
      const written = await store.upsertFinding({
        ...gone,
        status: 'resolved',
        resolvedAt: now,
        updatedAt: now,
      });
      if (!written) continue;
      await bus.publish(
        {
          type: 'finding.resolved',
          repoId,
          at: now,
          findingId: gone.id,
          reason: 'no-longer-reproduces',
        },
        { causedBy: cause },
      );
    }

    for (const dismissal of dismissed) {
      if (holding.has(dismissal.id)) continue;
      if (!(await store.endDismissal(dismissal.id, now))) continue;
      await bus.publish(
        {
          type: 'finding.resolved',
          repoId,
          at: now,
          findingId: dismissal.id,
          reason: 'no-longer-reproduces',
        },
        { causedBy: cause },
      );
    }
    return ids;
  };

  const resolveGone = async (
    repoId: RepoId,
    branch: BranchRefId,
    cause: EventId,
  ): Promise<void> => {
    const now = new Date().toISOString();
    for (const finding of await store.listOpenFindings(repoId)) {
      const { branchA, branchB } = finding.attribution;
      if (branchA !== branch && branchB !== branch) continue;
      await store.upsertFinding({
        ...finding,
        status: 'resolved',
        resolvedAt: now,
        updatedAt: now,
      });
      await bus.publish(
        { type: 'finding.resolved', repoId, at: now, findingId: finding.id, reason: 'branch-gone' },
        { causedBy: cause },
      );
    }
  };

  return {
    attach(): void {
      if (subscriptions.length > 0) return;
      subscriptions.push(
        bus.on('branch.snapshot', (event) => {
          announced.set(event.branchRefId, {
            repoId: event.repoId,
            treeOid: event.treeOid,
            // Absent from events stored before the field existed.
            headSha: event.headSha ?? null,
            changeSetId: event.changeSetId,
            at: event.at,
            announced: true,
          });
        }),
        // Awaited by the sweep before the branch's rows are deleted, and with
        // them — by cascade — its Findings; resolved here first, so the log
        // says how each one ended.
        bus.on('branch.disappeared', async (event, id) => {
          announced.delete(event.branchRefId);
          if (event.repoId !== null) await resolveGone(event.repoId, event.branchRefId, id);
        }),
      );
    },

    heldTrees(repoId: RepoId): readonly string[] {
      const held = new Set<string>();
      for (const seen of announced.values()) {
        if (seen.repoId === repoId && seen.treeOid !== null) held.add(seen.treeOid);
      }
      return [...held];
    },

    detach(): void {
      for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
    },

    plan,
    planPair,
    runPair,
  };
}

/**
 * How many entries each of the pipeline's caches keeps.
 *
 * One per tree edited, or head committed, for as long as the daemon runs would
 * be a leak; the oldest is the least likely to be merged again.
 */
const CACHE_ENTRIES = 1024;

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
}
