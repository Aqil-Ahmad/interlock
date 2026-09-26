import {
  captureDirtyState,
  commitSnapshotInShadow,
  mergeBase,
  openUserRepo,
  runRequired,
  speculativeMerge,
  textualAnalyzer,
  textualFindingKey,
} from '@interlock/core';
import type {
  AnalyzerContext,
  AnalyzerOutcome,
  GitRunner,
  ShadowRepo,
  UserRepo,
} from '@interlock/core';
import { isInterlockError, makePairKey, silentLogger, ulid } from '@interlock/shared';
import type {
  BranchRef,
  BranchRefId,
  ChangeSet,
  ChangeSetId,
  EventId,
  Finding,
  Logger,
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
import type { Store } from '../store/index.js';
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
  runPair(request: PairRunRequest, signal: AbortSignal): Promise<PairRunResult>;
}

export interface RunPipelineOptions {
  readonly store: Store;
  readonly bus: EventBus;
  readonly runner: GitRunner;
  readonly shadows: ShadowRegistry;
  readonly logger?: Logger;
}

/** A branch's content as the watcher last announced it. */
interface Announced {
  readonly treeOid: string | null;
  readonly headSha: string | null;
  readonly changeSetId: ChangeSetId | null;
  readonly at: string;
}

/** One side of a pair, ready to merge. */
interface Side {
  readonly branch: BranchRef;
  readonly commit: string;
  readonly headSha: string;
  readonly treeOid: string;
  readonly changeSet: ChangeSet | null;
}

type SideOrSkip = Side | { readonly skip: 'unreadable' | 'unborn' };

export function createRunPipeline(options: RunPipelineOptions): RunPipeline {
  const { store, bus, runner, shadows } = options;
  const log = (options.logger ?? silentLogger).child('run-pipeline');

  const announced = new Map<BranchRefId, Announced>();
  /**
   * Commits already made for a tree on a head.
   *
   * Each `commit-tree` of the same tree makes a new commit, since the time is
   * part of it; the tree is the identity and the first commit serves every
   * later merge of it.
   */
  const commits = new Map<string, string>();
  const handles = new Map<RepoId, Promise<UserRepo>>();
  let subscription: Subscription | null = null;

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

  const changeSetOf = async (branch: BranchRef): Promise<ChangeSet | null> => {
    const id = announced.get(branch.id)?.changeSetId ?? null;
    return id === null ? null : store.getChangeSet(id);
  };

  /**
   * Commit a side as it stands: the watcher's tree on the head it was captured
   * against, or the head itself for a branch with no worktree.
   *
   * A tree the shadow does not hold — the shadow was rebuilt since, or the
   * capture predates this daemon's captures moving into it — is captured again
   * here, once, which is the whole remedy for `SNAPSHOT_STALE`.
   */
  const sideOf = async (
    repo: Repo,
    handle: UserRepo,
    shadow: ShadowRepo,
    branch: BranchRef,
  ): Promise<SideOrSkip> => {
    const changeSet = await changeSetOf(branch);
    if (branch.worktreePath === null) {
      const tree = await runRequired(runner, shadow, [
        'rev-parse',
        '--verify',
        '--quiet',
        `${branch.headSha}^{tree}`,
      ]);
      return {
        branch,
        commit: branch.headSha,
        headSha: branch.headSha,
        treeOid: tree.stdout.trim(),
        changeSet,
      };
    }

    const worktreePath = branch.worktreePath;
    let seen =
      announced.get(branch.id) ?? (await recapture(repo, handle, shadow, branch, worktreePath));
    if (seen.treeOid === null) return { skip: 'unreadable' };
    if (seen.headSha === null) return { skip: 'unborn' };

    let commit: string;
    try {
      commit = await commitOf(shadow, seen.treeOid, seen.headSha, seen.at);
    } catch (error) {
      if (!isInterlockError(error) || error.code !== 'SNAPSHOT_STALE') throw error;
      seen = await recapture(repo, handle, shadow, branch, worktreePath);
      if (seen.treeOid === null) return { skip: 'unreadable' };
      if (seen.headSha === null) return { skip: 'unborn' };
      commit = await commitOf(shadow, seen.treeOid, seen.headSha, seen.at);
    }
    return { branch, commit, headSha: seen.headSha, treeOid: seen.treeOid, changeSet };
  };

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
      treeOid: snapshot.treeOid,
      headSha: snapshot.headSha,
      changeSetId: announced.get(branch.id)?.changeSetId ?? null,
      at: snapshot.capturedAt,
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
    if (known !== undefined) return known;
    const made = await commitSnapshotInShadow(
      shadow,
      { treeOid, headSha, clean: false, takenAs: 'whole-tree', capturedAt },
      { runner },
    );
    commits.set(key, made.commitSha);
    return made.commitSha;
  };

  const plan = async (repoId: RepoId, branchRefId: BranchRefId): Promise<PairPlan> => {
    const repo = await repoOf(repoId);
    if (repo === null) return { candidates: [], declined: 0 };
    const branches = await store.listBranchRefs(repoId);
    const moved = branches.find((branch) => branch.id === branchRefId);
    if (moved === undefined) return { candidates: [], declined: 0 };
    const handle = await handleOf(repo);
    const stored = new Map((await store.listMergePairs(repoId)).map((pair) => [pair.key, pair]));
    const withFindings = new Set(
      (await store.listOpenFindings(repoId)).map((finding) =>
        makePairKey(finding.attribution.branchA, finding.attribution.branchB),
      ),
    );
    const movedChanges = await changeSetOf(moved);

    const candidates: PairCandidate[] = [];
    let declined = 0;
    for (const other of branches) {
      if (other.id === moved.id) continue;
      const target = moved.name === repo.defaultBranch || other.name === repo.defaultBranch;
      const overlap = pairOverlap(movedChanges, await changeSetOf(other));
      const key = makePairKey(moved.id, other.id);
      const openFindings = withFindings.has(key);
      // Declined before git is asked for a merge base, which would be the only
      // cost it had: a pair with nothing in common cannot conflict textually.
      if (overlap.tier === 'none' && !target && !openFindings) {
        declined += 1;
        continue;
      }
      const base = await mergeBase(handle, moved.headSha, other.headSha, { runner });
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
    let shadow: ShadowRepo;
    try {
      shadow = await shadows.get(handle, repo.id);
    } catch (error) {
      shadows.forget(repo.id);
      throw error;
    }

    const sideA = await sideOf(repo, handle, shadow, branchA);
    if ('skip' in sideA) return { kind: 'skipped', reason: sideA.skip };
    const sideB = await sideOf(repo, handle, shadow, branchB);
    if ('skip' in sideB) return { kind: 'skipped', reason: sideB.skip };

    const base = await mergeBase(handle, sideA.headSha, sideB.headSha, { runner });
    if (base === null) return { kind: 'skipped', reason: 'unrelated' };

    // Content, not ids: a snapshot id is minted per capture, so two captures of
    // the same work differ while the trees they hashed to do not.
    const contentKey = JSON.stringify([...[sideA.treeOid, sideB.treeOid].sort(), base]);
    if (!request.isNew(contentKey)) return { kind: 'duplicate', contentKey };

    const stored = await store.upsertMergePair({
      ...pair,
      mergeBaseSha: base,
      priority: request.priority,
    });
    const run: SpeculativeRun = {
      id: ulid<SpeculativeRunId>(),
      mergePairId: stored.id,
      snapshotA: ulid<SnapshotId>(),
      snapshotB: ulid<SnapshotId>(),
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
      status: SpeculativeRun['status'],
      patch: Partial<SpeculativeRun>,
    ): Promise<void> => {
      await store.upsertRun({
        ...run,
        ...patch,
        status,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      });
    };

    try {
      if (signal.aborted) {
        await finish('superseded', {});
        return { kind: 'superseded' };
      }

      const mergeRequest = {
        shadow,
        commitA: sideA.commit,
        commitB: sideB.commit,
        mergeBaseSha: base,
      };
      const merged = await speculativeMerge(mergeRequest, { runner });
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
      await finish('complete', {
        mergeOutcome,
        findingIds,
        analyzerResults: [
          {
            analyzer: 'textual',
            verdict: outcome.verdict,
            findingIds,
            durationMs: analyzerMs,
            cached: false,
            diagnostic: outcome.diagnostic ?? null,
          },
        ],
      });
      await store.upsertMergePair({ ...stored, lastRunAt: new Date().toISOString(), stale: false });
      const finished = await bus.publish(
        {
          type: 'run.finished',
          repoId: repo.id,
          at: new Date().toISOString(),
          runId: run.id,
          findingCount: findingIds.length,
          durationMs: Date.now() - startedAt,
        },
        { causedBy: started },
      );
      return {
        kind: 'analysed',
        runId: run.id,
        contentKey,
        clean: merged.clean,
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
   * Write a run's Findings over the pair's open ones.
   *
   * The same conflict is found on every run while both branches sit still, so a
   * Finding that matches an open one by `textualFindingKey` takes over that
   * one's id, `firstSeenAt` and run — a Finding belongs to the run that raised
   * it, which the store keeps while the Finding is open — rather than opening a
   * duplicate. An open one the run did not reproduce is resolved.
   */
  const reconcileFindings = async (
    repoId: RepoId,
    pair: MergePair,
    found: readonly Finding[],
    cause: EventId,
  ): Promise<Finding['id'][]> => {
    const now = new Date().toISOString();
    const open = (await store.listOpenFindings(repoId)).filter(
      (finding) =>
        finding.kind === 'textual' &&
        makePairKey(finding.attribution.branchA, finding.attribution.branchB) === pair.key,
    );
    const byKey = new Map(open.map((finding) => [textualFindingKey(finding), finding]));

    const ids: Finding['id'][] = [];
    for (const finding of found) {
      const previous = byKey.get(textualFindingKey(finding));
      if (previous !== undefined) {
        byKey.delete(textualFindingKey(finding));
        await store.upsertFinding({
          ...finding,
          id: previous.id,
          runId: previous.runId,
          firstSeenAt: previous.firstSeenAt,
        });
        ids.push(previous.id);
        continue;
      }
      await store.upsertFinding(finding);
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
      await store.upsertFinding({ ...gone, status: 'resolved', resolvedAt: now, updatedAt: now });
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
    return ids;
  };

  return {
    attach(): void {
      subscription ??= bus.on('branch.snapshot', (event) => {
        announced.set(event.branchRefId, {
          treeOid: event.treeOid,
          headSha: event.headSha,
          changeSetId: event.changeSetId,
          at: event.at,
        });
      });
    },

    detach(): void {
      subscription?.unsubscribe();
      subscription = null;
    },

    plan,
    runPair,
  };
}
