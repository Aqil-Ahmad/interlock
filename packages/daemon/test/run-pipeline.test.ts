import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createGitRunner, textualAnalyzer } from '@interlock/core';
import type { GitResult, GitRunner, UserRepo } from '@interlock/core';
import { createLogger, makePairKey, silentLogger, ulid } from '@interlock/shared';
import type {
  BranchRef,
  BranchRefId,
  ChangeSetId,
  EventId,
  EventRecord,
  Finding,
  LogRecord,
  Repo,
  RepoId,
  SpanEvidence,
} from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/bus/index.js';
import type { PairCandidate, PairRunRequest, PairRunResult } from '../src/scheduler/index.js';
import { createRunPipeline, SNAPSHOT_COMMIT_REUSE_MS } from '../src/scheduler/run-pipeline.js';
import type { RunPipeline } from '../src/scheduler/run-pipeline.js';
import { createShadowCollector, createShadowRegistry } from '../src/shadows.js';
import type { ShadowCollector, ShadowRegistry } from '../src/shadows.js';
import { openStore } from '../src/store/index.js';
import type { Store } from '../src/store/index.js';
import { createSweep } from '../src/watcher/sweep.js';
import type { Sweep } from '../src/watcher/sweep.js';

/**
 * The run pipeline against real repositories: the watcher's sweep captures
 * and announces each branch, and the pipeline plans and runs pairs from what it
 * heard — the way the daemon composes them, minus the scheduler's timing.
 */
describe('run pipeline', () => {
  let base: string;
  let root: string;
  let store: Store;
  let bus: EventBus;
  let records: EventRecord[];
  let shadows: ShadowRegistry;
  let sweep: Sweep;
  let pipeline: RunPipeline;
  const runner = createGitRunner();

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' });

  const lines = (...content: string[]): string => `${content.join('\n')}\n`;
  const body = (value: string): string =>
    lines('export function total(items) {', `  return ${value};`, '}');

  /** What the pipeline warned about: the only trace a swallowed failure leaves. */
  let warnings: LogRecord[];

  const build = (with_: GitRunner = runner): RunPipeline => {
    const logger = createLogger('test', { level: 'warn', sink: (record) => warnings.push(record) });
    const made = createRunPipeline({ store, bus, runner: with_, shadows, logger });
    made.attach();
    return made;
  };

  /** Mark every worktree changed and reconcile, as a filesystem signal would. */
  const observe = async (): Promise<void> => {
    for (const path of [root, join(base, 'a'), join(base, 'b')]) sweep.markChanged(path);
    await sweep.reconcile(root);
  };

  const repo = async (): Promise<Repo> => (await store.listRepos())[0]!;
  const branchNamed = async (name: string): Promise<BranchRef> =>
    (await store.listBranchRefs((await repo()).id)).find((branch) => branch.name === name)!;

  let lastKey: string | null;
  const request = (candidate: PairCandidate, cause: EventId = ulid<EventId>()): PairRunRequest => ({
    candidate,
    priority: 30,
    cause,
    isNew: (key) => key !== lastKey,
  });

  /** Plan from `a`, and run the pair it forms with `other`. */
  const runWith = async (
    other: string,
    signal: AbortSignal = new AbortController().signal,
    using: RunPipeline = pipeline,
  ): Promise<PairRunResult> => {
    const [a, b] = [await branchNamed('a'), await branchNamed(other)];
    const { candidates } = await using.plan(a.repoId, a.id);
    const candidate = candidates.find((c) => c.pair.a === b.id || c.pair.b === b.id)!;
    const result = await using.runPair(request(candidate), signal);
    if (result.kind === 'analysed') lastKey = result.contentKey;
    return result;
  };
  const run = (signal?: AbortSignal, using?: RunPipeline): Promise<PairRunResult> =>
    runWith('b', signal, using);

  interface BranchSnapshotPayload {
    readonly type: 'branch.snapshot';
    readonly repoId: RepoId;
    readonly at: string;
    readonly branchRefId: BranchRefId;
    readonly treeOid: string;
    readonly headSha: string;
    readonly changeSetId: ChangeSetId;
    readonly fileCount: number;
  }

  const published = (type: EventRecord['type']): EventRecord[] =>
    records.filter((record) => record.type === type);

  /** The run's `run.finished`, checked to follow from its `run.started`. */
  const endOf = (runId: string): Record<string, unknown> => {
    const started = published('run.started').find(
      (record) => (record.payload as { runId: string }).runId === runId,
    )!;
    const ends = published('run.finished').filter(
      (record) => (record.payload as { runId: string }).runId === runId,
    );
    expect(ends).toHaveLength(1);
    expect(ends[0]!.causedBy).toBe(started.id);
    return ends[0]!.payload as unknown as Record<string, unknown>;
  };

  /** The snapshot id the watcher's latest change set for a branch records. */
  const watcherSnapshotOf = async (branchRefId: string): Promise<string | null> => {
    const last = published('branch.snapshot')
      .map((record) => record.payload as { branchRefId: string; changeSetId: string | null })
      .filter((payload) => payload.branchRefId === branchRefId)
      .at(-1);
    if (last?.changeSetId == null) return null;
    return (await store.getChangeSet(last.changeSetId as never))?.snapshotId ?? null;
  };

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-pipeline-')));
    root = join(base, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
    git(root, 'config', 'user.name', 'Interlock Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'maintenance.auto', 'false');
    git(root, 'config', 'gc.auto', '0');
    writeFileSync(join(root, 'total.ts'), body('items.length'));
    writeFileSync(join(root, 'other.ts'), lines('other'));
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    git(root, 'worktree', 'add', '-q', '-b', 'a', join(base, 'a'));
    git(root, 'worktree', 'add', '-q', '-b', 'b', join(base, 'b'));

    store = await openStore({ path: join(base, 'interlock.db') });
    records = [];
    bus = new EventBus({ logger: silentLogger, onRecord: (record) => records.push(record) });
    shadows = createShadowRegistry({ runner, dataDir: join(base, 'data') });
    sweep = createSweep({ store, bus, runner, dataDir: join(base, 'data'), shadows });
    warnings = [];
    pipeline = build();
    lastKey = null;
  });

  afterEach(async () => {
    pipeline.detach();
    await store.close();
    rmSync(base, { recursive: true, force: true });
  });

  describe('planning', () => {
    it('pairs a branch with every branch it overlaps and with the default branch', async () => {
      writeFileSync(join(base, 'a', 'total.ts'), body('1'));
      writeFileSync(join(base, 'b', 'total.ts'), body('2'));
      await observe();
      const a = await branchNamed('a');

      const { candidates, declined } = await pipeline.plan(a.repoId, a.id);

      expect(declined).toBe(0);
      const byOther = new Map(
        candidates.map((c) => [c.pair.a === a.id ? c.pair.b : c.pair.a, c] as const),
      );
      const b = await branchNamed('b');
      const main = await branchNamed('main');
      expect(byOther.get(b.id)).toMatchObject({
        overlap: { tier: 'file', commonFiles: ['total.ts'] },
        target: false,
      });
      expect(byOther.get(main.id)).toMatchObject({ target: true });
      // Stored, and stale until a run completes.
      const stored = await store.listMergePairs(a.repoId);
      expect(stored.every((pair) => pair.stale)).toBe(true);
      expect(stored.map((pair) => pair.key).sort()).toEqual(
        candidates.map((c) => c.pair.key).sort(),
      );
    });

    it('declines a pair with nothing in common before asking git anything about it', async () => {
      writeFileSync(join(base, 'a', 'total.ts'), body('1'));
      writeFileSync(join(base, 'b', 'other.ts'), lines('changed'));
      await observe();
      const a = await branchNamed('a');

      const { candidates, declined } = await pipeline.plan(a.repoId, a.id);

      expect(declined).toBe(1);
      expect(candidates.map((c) => c.target)).toEqual([true]);
    });

    it('leaves out a branch with no history in common', async () => {
      git(root, 'checkout', '-q', '--orphan', 'lonely');
      git(root, 'commit', '-qm', 'alone', '--allow-empty');
      git(root, 'checkout', '-q', 'main');
      await observe();
      const lonely = await branchNamed('lonely');

      const { candidates } = await pipeline.plan(lonely.repoId, lonely.id);

      expect(candidates).toEqual([]);
    });

    it('plans nothing for a repository or a branch it does not know', async () => {
      await observe();
      const a = await branchNamed('a');
      expect(await pipeline.plan(ulid(), a.id)).toEqual({ candidates: [], declined: 0 });
      expect(await pipeline.plan(a.repoId, ulid())).toEqual({ candidates: [], declined: 0 });
    });
  });

  describe('a conflicting pair', () => {
    beforeEach(async () => {
      writeFileSync(join(base, 'a', 'total.ts'), body('1'));
      writeFileSync(join(base, 'b', 'total.ts'), body('2'));
      await observe();
    });

    it('is merged from the watcher’s own trees, and its Finding persisted with its events', async () => {
      const [a, b] = [await branchNamed('a'), await branchNamed('b')];
      const { candidates } = await pipeline.plan(a.repoId, a.id);
      const candidate = candidates.find((c) => c.overlap.tier === 'file')!;
      const cause = ulid<EventId>();

      const result = await pipeline.runPair(
        request(candidate, cause),
        new AbortController().signal,
      );

      expect(result).toMatchObject({ kind: 'analysed', clean: false, findingCount: 1 });
      const [finding] = await store.listOpenFindings(a.repoId);
      expect(finding).toMatchObject({ kind: 'textual', rule: 'overlapping-edit' });
      const spans = finding!.evidence.filter((e): e is SpanEvidence => e.type === 'span');
      expect(new Set(spans.map((span) => span.branchRefId))).toEqual(new Set([a.id, b.id]));

      const stored = await store.getRun(finding!.runId);
      expect(stored).toMatchObject({
        status: 'complete',
        mergeOutcome: { clean: false, conflictedPaths: ['total.ts'] },
        findingIds: [finding!.id],
      });
      expect(stored!.analyzerResults).toMatchObject([
        { analyzer: 'textual', verdict: 'findings', cached: false },
      ]);
      const [pair] = (await store.listMergePairs(a.repoId)).filter(
        (p) => p.key === candidate.pair.key,
      );
      expect(pair).toMatchObject({ stale: false, priority: 30 });
      expect(pair!.lastRunAt).not.toBeNull();

      const byType = (type: EventRecord['type']): EventRecord => published(type).at(-1)!;
      expect(byType('run.started').causedBy).toBe(cause);
      expect(byType('run.merge-completed').causedBy).toBe(byType('run.started').id);
      expect(byType('run.analyzer-completed').causedBy).toBe(byType('run.merge-completed').id);
      expect(byType('finding.raised').causedBy).toBe(byType('run.analyzer-completed').id);
      expect(byType('run.finished').causedBy).toBe(byType('run.started').id);
      expect(result.kind === 'analysed' && result.finished).toBe(byType('run.finished').id);
      expect(endOf(stored!.id)).toMatchObject({ status: 'complete', findingCount: 1 });
      // The watcher's own snapshots, so the run traces to the content it merged.
      const snapshotA = await watcherSnapshotOf(candidate.pair.a);
      expect(snapshotA).not.toBeNull();
      expect(stored!.snapshotA).toBe(snapshotA);
      expect(stored!.snapshotB).toBe(await watcherSnapshotOf(candidate.pair.b));
    });

    it('is a duplicate at the same content, and merges nothing', async () => {
      await run();
      const before = published('run.started').length;

      const again = await run();

      expect(again.kind).toBe('duplicate');
      expect(published('run.started')).toHaveLength(before);
      // Planning marked it stale; content already analysed leaves it current.
      const a = await branchNamed('a');
      const b = await branchNamed('b');
      const [pair] = (await store.listMergePairs(a.repoId)).filter(
        (p) => p.key === makePairKey(a.id, b.id),
      );
      expect(pair!.stale).toBe(false);
    });

    it('listens once however often it is attached', () => {
      const before = bus.handlerCount;
      pipeline.attach();
      expect(bus.handlerCount).toBe(before);
      pipeline.detach();
      expect(bus.handlerCount).toBe(before - 2);
    });

    it('resolves a gone branch’s Findings before its rows go, and says why', async () => {
      // A second pair's Finding, which the branch going does not touch.
      writeFileSync(join(root, 'total.ts'), body('on main'));
      await observe();
      await runWith('main');
      lastKey = null;
      await run();
      const b = await branchNamed('b');
      const finding = (await store.listOpenFindings((await repo()).id)).find((f) =>
        [f.attribution.branchA, f.attribution.branchB].includes(b.id),
      );
      const resolvedDuringDelete: string[] = [];
      bus.on('finding.resolved', async (event) => {
        const stored = await store.getFinding(event.findingId);
        resolvedDuringDelete.push(stored!.status);
      });

      git(root, 'worktree', 'remove', '--force', join(base, 'b'));
      git(root, 'branch', '-D', 'b');
      await observe().catch(() => undefined);

      const resolved = published('finding.resolved').at(-1)!;
      expect(resolved.payload).toMatchObject({ findingId: finding!.id, reason: 'branch-gone' });
      const disappeared = published('branch.disappeared').at(-1)!;
      expect(disappeared.payload).toMatchObject({ branchRefId: b.id });
      expect(resolved.causedBy).toBe(disappeared.id);
      expect(resolvedDuringDelete).toEqual(['resolved']);
      const main = await branchNamed('main');
      const open = await store.listOpenFindings((await repo()).id);
      expect(open.map((f) => [f.attribution.branchA, f.attribution.branchB].sort())).toEqual([
        [(await branchNamed('a')).id, main.id].sort(),
      ]);
    });

    it('is new content at the same trees on a different merge base', async () => {
      await run();
      // Both branches re-parented onto a newer main with their trees untouched:
      // the trees match, the base does not, and the merge is a different one.
      writeFileSync(join(root, 'other.ts'), lines('main moved'));
      git(root, 'commit', '-qam', 'main moves');
      const newBase = git(root, 'rev-parse', 'HEAD').trim();
      for (const side of ['a', 'b']) {
        const cwd = join(base, side);
        git(cwd, 'add', '-A');
        git(cwd, 'commit', '-qm', `${side} work`);
        const tree = git(cwd, 'rev-parse', 'HEAD^{tree}').trim();
        const moved = git(cwd, 'commit-tree', tree, '-p', newBase, '-m', 'rebased').trim();
        git(cwd, 'reset', '-q', '--hard', moved);
      }
      await observe();

      // And no verdict answers it: the same trees merged from another base.
      expect(await run()).toMatchObject({ kind: 'analysed', cached: false });
    });

    it('keeps one Finding across runs while the conflict stands, and resolves it when it goes', async () => {
      await run();
      const [first] = await store.listOpenFindings((await repo()).id);

      // An edit elsewhere changes the content, not the conflict.
      writeFileSync(join(base, 'a', 'other.ts'), lines('moved on'));
      await observe();
      expect((await run()).kind).toBe('analysed');
      const [second] = await store.listOpenFindings((await repo()).id);
      expect(second!.id).toBe(first!.id);
      expect(second!.firstSeenAt).toBe(first!.firstSeenAt);
      expect(second!.runId).toBe(first!.runId);
      expect(second!.updatedAt >= first!.updatedAt).toBe(true);
      expect(published('finding.raised')).toHaveLength(1);

      writeFileSync(join(base, 'b', 'total.ts'), body('items.length'));
      await observe();
      expect(await run()).toMatchObject({ kind: 'analysed', clean: true });
      expect(await store.listOpenFindings((await repo()).id)).toEqual([]);
      expect(await store.getFinding(first!.id)).toMatchObject({ status: 'resolved' });
      expect(published('finding.resolved')[0]!.payload).toMatchObject({
        findingId: first!.id,
        reason: 'no-longer-reproduces',
      });
    });

    it('records a run superseded while it ran, and persists nothing it found', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await run(controller.signal);

      expect(result.kind).toBe('superseded');
      expect(await store.listOpenFindings((await repo()).id)).toEqual([]);
      const started = published('run.started')[0]!.payload as { runId: string };
      expect(await store.getRun(started.runId as never)).toMatchObject({ status: 'superseded' });
      expect(endOf(started.runId)).toMatchObject({ status: 'superseded', findingCount: 0 });
      // Discarded, so the same content is not a duplicate next time.
      expect((await run()).kind).toBe('analysed');
    });

    it('discards a result whose pair was invalidated while the merge ran', async () => {
      const controller = new AbortController();
      const invalidating: GitRunner = {
        run: (target, args, options) => {
          if (args.includes('merge-tree')) controller.abort();
          return runner.run(target, args, options);
        },
      };
      const other = build(invalidating);

      const result = await run(controller.signal, other);
      other.detach();

      expect(result.kind).toBe('superseded');
      expect(published('run.merge-completed')).toHaveLength(1);
      expect(await store.listOpenFindings((await repo()).id)).toEqual([]);
      const started = published('run.started')[0]!.payload as { runId: string };
      expect(await store.getRun(started.runId as never)).toMatchObject({ status: 'superseded' });
    });

    it('commits a side’s tree once, however many pairs it is merged in', async () => {
      let commits = 0;
      const counting: GitRunner = {
        run: (target, args, options) => {
          if (args.includes('commit-tree')) commits += 1;
          return runner.run(target, args, options);
        },
      };
      const other = build(counting);
      await run(new AbortController().signal, other);
      expect(commits).toBe(2);

      writeFileSync(join(base, 'b', 'total.ts'), body('3'));
      await observe();
      await run(new AbortController().signal, other);
      other.detach();

      expect(commits).toBe(3);
    });

    it('leaves another pair’s Findings alone when it resolves its own', async () => {
      writeFileSync(join(root, 'total.ts'), body('on main'));
      await observe();
      await run();
      lastKey = null;
      await runWith('main');
      const main = await branchNamed('main');
      const b = await branchNamed('b');
      const before = await store.listOpenFindings((await repo()).id);
      expect(before).toHaveLength(2);

      writeFileSync(join(root, 'total.ts'), body('items.length'));
      await observe();
      await runWith('main');

      const open = await store.listOpenFindings((await repo()).id);
      expect(open).toHaveLength(1);
      const [survivor] = open;
      expect([survivor!.attribution.branchA, survivor!.attribution.branchB]).toContain(b.id);
      expect([survivor!.attribution.branchA, survivor!.attribution.branchB]).not.toContain(main.id);
    });

    it('reports an analyzer that could not read the merge as infrastructure', async () => {
      // `ls-tree -l` is the classifier's own read; the merge never asks for sizes.
      const failing: GitRunner = {
        run: (target, args, options) =>
          args[0] === 'ls-tree' && args.includes('-l')
            ? Promise.resolve({ stdout: '', stderr: '', exitCode: 128 })
            : runner.run(target, args, options),
      };
      const other = build(failing);

      const result = await run(new AbortController().signal, other);
      other.detach();

      expect(result).toMatchObject({ kind: 'infra-failure', component: 'analyzer:textual' });
      const started = published('run.started')[0]!.payload as { runId: string };
      expect(await store.getRun(started.runId as never)).toMatchObject({ status: 'failed' });
      expect(endOf(started.runId)).toMatchObject({ status: 'failed' });
      expect(await store.listOpenFindings((await repo()).id)).toEqual([]);
    });

    it('records a run that threw as failed, and throws', async () => {
      const failing: GitRunner = {
        run: (target, args, options) =>
          args.includes('merge-tree')
            ? Promise.resolve({ stdout: '', stderr: '', exitCode: 2 })
            : runner.run(target, args, options),
      };
      const other = build(failing);

      await expect(run(new AbortController().signal, other)).rejects.toMatchObject({
        code: 'MERGE_FAILED',
      });
      other.detach();
      const started = published('run.started')[0]!.payload as { runId: string };
      expect(await store.getRun(started.runId as never)).toMatchObject({ status: 'failed' });
      expect(endOf(started.runId)).toMatchObject({ status: 'failed' });
    });
  });

  describe('the verdict cache', () => {
    /** The real runner, keeping the argv of every command it is asked to run. */
    const recording = (
      answering: (args: readonly string[]) => GitResult | null = () => null,
    ): { runner: GitRunner; calls: string[][] } => {
      const calls: string[][] = [];
      return {
        calls,
        runner: {
          run: (target, args, options) => {
            calls.push([...args]);
            const answer = answering(args);
            return answer === null ? runner.run(target, args, options) : Promise.resolve(answer);
          },
        },
      };
    };

    /** The a/b pair, planned, then run with the calls made by the run alone. */
    const runAlone = async (
      using: RunPipeline,
      calls: string[][],
      [from, to]: readonly [string, string] = ['a', 'b'],
    ): Promise<{ result: PairRunResult; git: string[][] }> => {
      const [a, b] = [await branchNamed(from), await branchNamed(to)];
      const { candidates } = await using.plan(a.repoId, a.id);
      const candidate = candidates.find((c) => c.pair.a === b.id || c.pair.b === b.id)!;
      calls.length = 0;
      const result = await using.runPair(request(candidate), new AbortController().signal);
      if (result.kind === 'analysed') lastKey = result.contentKey;
      return { result, git: [...calls] };
    };

    const edit = async (side: 'a' | 'b', value: string): Promise<void> => {
      writeFileSync(join(base, side, 'total.ts'), body(value));
      await observe();
    };

    const merges = (git: string[][]): number =>
      git.filter((argv) => argv.includes('merge-tree')).length;

    /** A new file on each side in one directory: an overlap that merges cleanly. */
    const besideEachOther = (): void => {
      for (const side of ['a', 'b']) {
        mkdirSync(join(base, side, 'lib'), { recursive: true });
        writeFileSync(join(base, side, 'lib', `${side}.ts`), lines(side));
      }
    };

    const openFinding = async () => (await store.listOpenFindings((await repo()).id))[0]!;

    beforeEach(async () => {
      await edit('a', '1');
      await edit('b', '2');
    });

    it('answers content it has judged before without running any git', async () => {
      const { runner: watched, calls } = recording();
      const using = build(watched);

      const first = await runAlone(using, calls);
      const found = await openFinding();
      await edit('a', '5');
      const elsewhere = await runAlone(using, calls);
      await edit('a', '1');
      const again = await runAlone(using, calls);
      using.detach();

      expect(first.result).toMatchObject({ kind: 'analysed', cached: false });
      expect(merges(first.git)).toBe(1);
      expect(elsewhere.result).toMatchObject({ kind: 'analysed', cached: false });
      expect(again.result).toMatchObject({ kind: 'analysed', cached: true, clean: false });
      // No capture, no commit, no merge, no analyzer: nothing at all.
      expect(again.git).toEqual([]);
      // One Finding throughout, keeping its identity, with the evidence of the
      // content the verdict is about rather than the last run's.
      const reaffirmed = await openFinding();
      expect(reaffirmed.id).toBe(found.id);
      expect(reaffirmed.firstSeenAt).toBe(found.firstSeenAt);
      expect(reaffirmed.updatedAt > found.updatedAt).toBe(true);
      expect(reaffirmed.evidence).toEqual(found.evidence);
      expect(await store.listOpenFindings((await repo()).id)).toHaveLength(1);
    });

    it('answers a branch with no worktree from its head without asking git again', async () => {
      const scratch = join(base, 'scratch-bare');
      git(root, 'worktree', 'add', '-q', '-b', 'bare', scratch);
      writeFileSync(join(scratch, 'total.ts'), body('committed'));
      git(scratch, 'commit', '-qam', 'bare work');
      git(root, 'worktree', 'remove', '--force', scratch);
      await observe();
      const { runner: watched, calls } = recording();
      const using = build(watched);

      await runAlone(using, calls, ['a', 'bare']);
      await edit('a', '5');
      await runAlone(using, calls, ['a', 'bare']);
      await edit('a', '1');
      const again = await runAlone(using, calls, ['a', 'bare']);
      using.detach();

      expect(again.result).toMatchObject({ kind: 'analysed', cached: true });
      expect(again.git).toEqual([]);
    });

    it('keys a side captured again on what it captured, not what it was told', async () => {
      // b's head moves off a's, so a head announced wrongly is another base.
      git(join(base, 'b'), 'commit', '-qam', 'b work');
      await observe();
      const a = await branchNamed('a');
      const b = await branchNamed('b');
      const real = published('branch.snapshot')
        .map((record) => record.payload as BranchSnapshotPayload)
        .filter((payload) => payload.branchRefId === a.id)
        .at(-1)!;
      // A tree the shadow never had, on a head that is not a's: both are what
      // the run has to discover again.
      await bus.publish({
        ...real,
        at: new Date().toISOString(),
        treeOid: 'f'.repeat(40),
        headSha: b.headSha,
      });

      const recaptured = await run();

      // Merged against a's real base, where the conflict is.
      expect(recaptured).toMatchObject({ kind: 'analysed', cached: false, clean: false });
      if (recaptured.kind !== 'analysed') throw new Error('not analysed');
      expect(recaptured.contentKey).toContain(real.treeOid);
      await bus.publish({ ...real, at: new Date().toISOString() });
      lastKey = null;
      expect(await run()).toMatchObject({ kind: 'analysed', cached: true });
    });

    it('records a hit as a run of its own that names the run it reused', async () => {
      const firstRun = await run();
      await edit('a', '5');
      await run();
      await edit('a', '1');

      const hit = await run();

      if (firstRun.kind !== 'analysed' || hit.kind !== 'analysed') throw new Error('not analysed');
      // Planning marked the pair stale; the hit describes it again.
      const [pair] = await store.listMergePairs((await repo()).id);
      expect(pair).toMatchObject({ stale: false });
      expect(pair!.lastRunAt).not.toBeNull();
      const stored = await store.getRun(hit.runId);
      expect(stored).toMatchObject({
        status: 'complete',
        mergeOutcome: { clean: false, conflictedPaths: ['total.ts'] },
      });
      expect(stored!.analyzerResults).toMatchObject([
        { analyzer: 'textual', verdict: 'findings', cached: true },
      ]);
      const analyzed = published('run.analyzer-completed').at(-1)!;
      const started = published('run.started').at(-1)!;
      expect(analyzed.payload).toMatchObject({ runId: hit.runId, cachedFrom: firstRun.runId });
      expect(analyzed.causedBy).toBe(started.id);
      expect(
        published('run.merge-completed').map((e) => (e.payload as { runId: string }).runId),
      ).not.toContain(hit.runId);
      expect(endOf(hit.runId)).toMatchObject({ status: 'complete', findingCount: 1 });
    });

    it('raises a conflict again, from the hit, after it went away and came back', async () => {
      await run();
      const gone = await openFinding();
      await edit('b', 'items.length');
      await run();
      expect(await store.listOpenFindings((await repo()).id)).toEqual([]);
      await edit('b', '2');

      const hit = await run();

      // What a run would do: the resolved Finding stays resolved, and the
      // conflict is raised afresh by this run, traced to its verdict.
      expect(hit).toMatchObject({ kind: 'analysed', cached: true });
      const raised = await openFinding();
      expect(raised.id).not.toBe(gone.id);
      expect(raised.firstSeenAt > gone.firstSeenAt).toBe(true);
      expect((await store.getFinding(gone.id))?.status).toBe('resolved');
      expect(raised.runId).toBe(hit.kind === 'analysed' && hit.runId);
      const event = published('finding.raised').at(-1)!;
      expect(event.payload).toMatchObject({ findingId: raised.id });
      expect(event.causedBy).toBe(published('run.analyzer-completed').at(-1)!.id);
    });

    it('resolves the pair’s open Findings the verdict does not hold', async () => {
      // Judged clean first, then a conflict, then back to clean from the cache.
      // A file each in one directory keeps the pair planned throughout.
      besideEachOther();
      await edit('b', 'items.length');
      await run();
      await edit('b', '2');
      await run();
      expect(await store.listOpenFindings((await repo()).id)).toHaveLength(1);
      await edit('b', 'items.length');

      const hit = await run();

      expect(hit).toMatchObject({ kind: 'analysed', cached: true, clean: true });
      expect(await store.listOpenFindings((await repo()).id)).toEqual([]);
      expect(published('finding.resolved').at(-1)!.causedBy).toBe(
        published('run.analyzer-completed').at(-1)!.id,
      );
    });

    it('carries a clean merge’s cleanliness through a hit, for escalation', async () => {
      besideEachOther();
      await edit('b', 'items.length');
      await run();
      await edit('a', '7');
      await run();
      await edit('a', '1');

      expect(await run()).toMatchObject({ kind: 'analysed', cached: true, clean: true });
    });

    it('answers a restart from the store without capturing, committing or merging', async () => {
      // Heads that differ, so the order planning asks for their merge base in
      // is not the order the run does.
      git(join(base, 'b'), 'commit', '-qam', 'b work');
      await observe();
      await run();
      pipeline.detach();
      // A new daemon: a fresh watcher announces every worktree, and a fresh
      // pipeline knows nothing but what is stored.
      sweep = createSweep({ store, bus, runner, dataDir: join(base, 'data'), shadows });
      const { runner: watched, calls } = recording();
      pipeline = build(watched);
      await observe();
      lastKey = null;

      // Planned from the side whose id sorts last, so planning asks for the
      // merge base with the heads the other way round from the run.
      const [a, b] = [await branchNamed('a'), await branchNamed('b')];
      const order = a.id > b.id ? (['a', 'b'] as const) : (['b', 'a'] as const);
      const { result, git: asked } = await runAlone(pipeline, calls, order);

      expect(result).toMatchObject({ kind: 'analysed', cached: true });
      // Planning already asked for the heads' merge base, so the one fact a
      // fresh pipeline lacks is the git version its verdicts are keyed under.
      expect(asked).toEqual([['version']]);
    });

    it('misses when the same trees sit on the other branches', async () => {
      await run();
      await edit('a', '2');
      await edit('b', '1');
      const { runner: watched, calls } = recording();
      const using = build(watched);

      const { result, git } = await runAlone(using, calls);
      using.detach();

      expect(result).toMatchObject({ kind: 'analysed', cached: false });
      expect(merges(git)).toBe(1);
    });

    it('misses under another git', async () => {
      await run();
      const { runner: newer, calls } = recording((args) =>
        args[0] === 'version' ? { stdout: 'git version 9.9.9\n', stderr: '', exitCode: 0 } : null,
      );
      const using = build(newer);
      lastKey = null;

      const { result, git } = await runAlone(using, calls);
      using.detach();

      expect(result).toMatchObject({ kind: 'analysed', cached: false });
      expect(merges(git)).toBe(1);
    });

    it('misses once the analyzer’s logic has changed', async () => {
      await run();
      const analyzer = textualAnalyzer as { version: number };
      analyzer.version += 1;
      try {
        lastKey = null;
        expect(await run()).toMatchObject({ kind: 'analysed', cached: false });
      } finally {
        analyzer.version -= 1;
      }
    });

    it('misses under another build of the code that merges and classifies', async () => {
      await run();
      const { runner: watched, calls } = recording();
      const other = createRunPipeline({
        store,
        bus,
        runner: watched,
        shadows,
        logger: silentLogger,
        build: 'another build',
      });
      lastKey = null;

      const { result, git: asked } = await runAlone(other, calls);

      expect(result).toMatchObject({ kind: 'analysed', cached: false });
      expect(merges(asked)).toBe(1);
    });

    it('misses once the shadow is rebuilt, whose commits its evidence named', async () => {
      await run();
      const handle = { kind: 'user' as const, rootPath: root, gitDir: join(root, '.git') };
      const before = await shadows.get(handle, (await repo()).id);
      rmSync(before.rootPath, { recursive: true, force: true });
      shadows.forget((await repo()).id);
      await observe();
      lastKey = null;

      const result = await run();

      expect(result).toMatchObject({ kind: 'analysed', cached: false });
      const rebuilt = await shadows.get(handle, (await repo()).id);
      expect(rebuilt.generation).not.toBe(before.generation);
      // Evidence from this clone, naming commits it holds.
      const evidence = (await openFinding()).evidence.find((e) => e.type === 'merge-conflict');
      if (evidence?.type !== 'merge-conflict') throw new Error('no merge evidence');
      for (const commit of [evidence.commitA, evidence.commitB]) {
        expect(git(rebuilt.rootPath, 'cat-file', '-t', commit).trim()).toBe('commit');
      }
    });

    it('discards a hit whose pair moved while it was being recorded', async () => {
      await run();
      await edit('a', '5');
      await run();
      const elsewhere = await openFinding();
      await edit('a', '1');
      const moved = new AbortController();
      const listening = bus.on('run.analyzer-completed', (event) => {
        if (event.cachedFrom !== undefined) moved.abort();
      });

      const result = await run(moved.signal);
      listening.unsubscribe();

      expect(result).toEqual({ kind: 'superseded' });
      const started = published('run.started').at(-1)!.payload as { runId: string };
      expect(endOf(started.runId)).toMatchObject({ status: 'superseded' });
      // Nothing written: the Finding still says what the last completed run found.
      expect(await openFinding()).toEqual(elsewhere);
    });

    it('is not a duplicate at unchanged content once the shadow is rebuilt', async () => {
      const first = await run();
      const handle = { kind: 'user' as const, rootPath: root, gitDir: join(root, '.git') };
      rmSync((await shadows.get(handle, (await repo()).id)).rootPath, {
        recursive: true,
        force: true,
      });
      shadows.forget((await repo()).id);
      await observe();

      // The scheduler still remembers the last analysis: nothing resets it.
      const again = await run();

      expect(first).toMatchObject({ kind: 'analysed' });
      expect(again).toMatchObject({ kind: 'analysed', cached: false });
    });

    it('leaves a completed run complete when its verdict cannot be cached', async () => {
      // A real failure of the write, and only of the write: the lookup before
      // it still reads the table.
      const db = new DatabaseSync(join(base, 'interlock.db'));
      db.exec(`CREATE TRIGGER refuse_verdicts BEFORE INSERT ON analyzer_cache
        BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
      db.close();

      const result = await run();

      expect(result).toMatchObject({ kind: 'analysed', cached: false, findingCount: 1 });
      if (result.kind !== 'analysed') throw new Error('not analysed');
      expect(await store.getRun(result.runId)).toMatchObject({ status: 'complete' });
      const ends = published('run.finished').filter(
        (record) => (record.payload as { runId: string }).runId === result.runId,
      );
      expect(ends).toHaveLength(1);
      expect(ends[0]!.payload).toMatchObject({ status: 'complete' });
      expect(warnings.map((record) => record.msg)).toContain('could not cache a verdict');
    });

    it('keeps nothing from an analyzer that could not run', async () => {
      const failing: GitRunner = {
        run: (target, args, options) =>
          args[0] === 'ls-tree' && args.includes('-l')
            ? Promise.resolve({ stdout: '', stderr: '', exitCode: 128 })
            : runner.run(target, args, options),
      };
      const other = build(failing);
      expect(await run(new AbortController().signal, other)).toMatchObject({
        kind: 'infra-failure',
      });
      other.detach();

      expect(await run()).toMatchObject({ kind: 'analysed', cached: false });
    });

    it('keeps nothing from a run whose snapshot went stale', async () => {
      const stale: GitRunner = {
        run: (target, args, options) =>
          args.includes('merge-tree')
            ? Promise.reject(Object.assign(new Error('gone'), { code: 'SNAPSHOT_STALE' }))
            : runner.run(target, args, options),
      };
      const staleRun = build(stale);
      await expect(run(new AbortController().signal, staleRun)).rejects.toThrow();
      staleRun.detach();

      expect(await run()).toMatchObject({ kind: 'analysed', cached: false });
    });

    it('keeps nothing from a run superseded while it ran', async () => {
      const aborted = new AbortController();
      aborted.abort();
      expect(await run(aborted.signal)).toMatchObject({ kind: 'superseded' });

      expect(await run()).toMatchObject({ kind: 'analysed', cached: false });
    });

    it('records a hit superseded before it wrote anything as superseded', async () => {
      await run();
      await edit('a', '5');
      await run();
      await edit('a', '1');
      const aborted = new AbortController();
      aborted.abort();

      expect(await run(aborted.signal)).toEqual({ kind: 'superseded' });
      const started = published('run.started').at(-1)!.payload as { runId: string };
      expect(endOf(started.runId)).toMatchObject({ status: 'superseded' });
    });
  });

  describe('sides', () => {
    it('writes the watcher’s captures into the shadow, never the user’s store', async () => {
      writeFileSync(join(base, 'a', 'total.ts'), body('captured'));
      await observe();
      const a = await branchNamed('a');
      const announced = published('branch.snapshot')
        .map((record) => record.payload as { branchRefId: string; treeOid: string })
        .filter((payload) => payload.branchRefId === a.id);
      const tree = announced.at(-1)!.treeOid;
      const shadow = await shadows.get(
        { kind: 'user', rootPath: root, gitDir: join(root, '.git') },
        (await repo()).id,
      );

      expect(() => git(root, 'cat-file', '-e', tree)).toThrow();
      expect(git(shadow.rootPath, 'cat-file', '-t', tree).trim()).toBe('tree');
    });

    /** A branch with one commit changing `path`, and no worktree left holding it. */
    const bareBranch = (name: string, path: string, content: string): void => {
      const scratch = join(base, `scratch-${name}`);
      git(root, 'worktree', 'add', '-q', '-b', name, scratch);
      writeFileSync(join(scratch, path), content);
      git(scratch, 'commit', '-qam', `${name} work`);
      git(root, 'worktree', 'remove', '--force', scratch);
    };

    it('merges a branch with no worktree at its head, ranked by what it committed', async () => {
      bareBranch('bare', 'total.ts', body('committed'));
      writeFileSync(join(base, 'a', 'total.ts'), body('1'));
      await observe();
      const [a, bare] = [await branchNamed('a'), await branchNamed('bare')];
      expect(bare.worktreePath).toBeNull();
      const { candidates } = await pipeline.plan(a.repoId, a.id);
      const candidate = candidates.find((c) => c.pair.a === bare.id || c.pair.b === bare.id)!;
      expect(candidate.overlap).toEqual({ tier: 'file', commonFiles: ['total.ts'] });

      const result = await pipeline.runPair(request(candidate), new AbortController().signal);

      expect(result).toMatchObject({ kind: 'analysed', clean: false });
    });

    it('diffs a branch no worktree holds once per head, however often it is planned', async () => {
      bareBranch('bare', 'total.ts', body('committed'));
      writeFileSync(join(base, 'a', 'total.ts'), body('1'));
      await observe();
      let diffs = 0;
      const counting: GitRunner = {
        run: (target, args, options) => {
          if (args[0] === 'diff' && args.includes('--name-status')) diffs += 1;
          return runner.run(target, args, options);
        },
      };
      const other = build(counting);
      const a = await branchNamed('a');

      await other.plan(a.repoId, a.id);
      await other.plan(a.repoId, a.id);
      other.detach();

      expect(diffs).toBe(1);
    });

    it('reads a branch no worktree holds as unknown when the default branch does not resolve', async () => {
      bareBranch('bare', 'total.ts', body('committed'));
      await observe();
      const [a, bare] = [await branchNamed('a'), await branchNamed('bare')];
      const failing: GitRunner = {
        run: (target, args, options) =>
          args[0] === 'merge-base' && args.includes('main')
            ? Promise.resolve({ stdout: '', stderr: '', exitCode: 128 })
            : runner.run(target, args, options),
      };
      const other = build(failing);

      const { candidates } = await other.plan(a.repoId, a.id);
      other.detach();

      const candidate = candidates.find((c) => c.pair.a === bare.id || c.pair.b === bare.id);
      expect(candidate?.overlap.tier).toBe('unknown');
    });

    it('lets any other failure diffing a branch no worktree holds through', async () => {
      bareBranch('bare', 'total.ts', body('committed'));
      await observe();
      const a = await branchNamed('a');
      const broken: GitRunner = {
        run: (target, args, options) =>
          args[0] === 'merge-base' && args.includes('main')
            ? Promise.reject(new TypeError('a bug'))
            : runner.run(target, args, options),
      };
      const other = build(broken);

      await expect(other.plan(a.repoId, a.id)).rejects.toThrow('a bug');
      other.detach();
    });

    it('refuses a stored head that is not an object id rather than merge what it names now', async () => {
      bareBranch('bare', 'total.ts', body('committed'));
      writeFileSync(join(base, 'a', 'total.ts'), body('1'));
      await observe();
      const [a, bare] = [await branchNamed('a'), await branchNamed('bare')];
      const { candidates } = await pipeline.plan(a.repoId, a.id);
      const candidate = candidates.find((c) => c.pair.a === bare.id || c.pair.b === bare.id)!;
      // A ref name is a revision `mergeBase` accepts; the merge takes object ids only.
      await store.upsertBranchRef({ ...bare, headSha: 'main' });

      await expect(
        pipeline.runPair(request(candidate), new AbortController().signal),
      ).rejects.toMatchObject({ code: 'GIT_COMMAND_REFUSED' });
    });

    it('treats a head git names no tree for as infrastructure', async () => {
      bareBranch('bare', 'total.ts', body('committed'));
      writeFileSync(join(base, 'a', 'total.ts'), body('1'));
      await observe();
      const [a, bare] = [await branchNamed('a'), await branchNamed('bare')];
      const garbled: GitRunner = {
        // The bare branch's head alone: the other side's commit asks for trees too.
        run: (target, args, options) =>
          args[0] === 'rev-parse' && args.at(-1) === `${bare.headSha}^{tree}`
            ? Promise.resolve({ stdout: 'not a tree\n', stderr: '', exitCode: 0 })
            : runner.run(target, args, options),
      };
      const other = build(garbled);
      const { candidates } = await other.plan(a.repoId, a.id);
      const candidate = candidates.find((c) => c.pair.a === bare.id || c.pair.b === bare.id)!;

      await expect(
        other.runPair(request(candidate), new AbortController().signal),
      ).rejects.toMatchObject({ code: 'GIT_COMMAND_FAILED', infra: true });
      other.detach();
    });

    it('declines old branches no worktree holds when they have nothing in common', async () => {
      for (let n = 0; n < 10; n++) git(root, 'branch', `old${String(n)}`, 'main');
      bareBranch('elsewhere', 'other.ts', lines('unrelated'));
      writeFileSync(join(base, 'a', 'total.ts'), body('1'));
      await observe();
      const a = await branchNamed('a');

      const { candidates, declined } = await pipeline.plan(a.repoId, a.id);

      expect(declined).toBe(12);
      const names = new Map(
        (await store.listBranchRefs(a.repoId)).map((branch) => [branch.id, branch.name]),
      );
      const others = candidates.map((c) => names.get(c.pair.a === a.id ? c.pair.b : c.pair.a));
      expect(others).toEqual(['main']);
    });

    it('captures a side again when the tree it was told of is not in the shadow', async () => {
      writeFileSync(join(base, 'a', 'total.ts'), body('1'));
      writeFileSync(join(base, 'b', 'total.ts'), body('2'));
      await observe();
      const a = await branchNamed('a');
      const real = published('branch.snapshot')
        .map((record) => record.payload as { branchRefId: string; changeSetId: string })
        .filter((payload) => payload.branchRefId === a.id)
        .at(-1)!;
      await bus.publish({
        type: 'branch.snapshot',
        repoId: a.repoId,
        at: new Date().toISOString(),
        branchRefId: a.id,
        treeOid: 'f'.repeat(40),
        headSha: a.headSha,
        changeSetId: real.changeSetId as never,
        fileCount: 1,
      });

      const result = await run();

      expect(result).toMatchObject({ kind: 'analysed', clean: false });
      // Captured here, so the watcher's snapshot — of another tree — is not its id.
      const stored = await store.getRun((result as { runId: string }).runId as never);
      const watcher = (await store.getChangeSet(real.changeSetId as never))!.snapshotId;
      const b = await branchNamed('b');
      const ownSide = a.id < b.id ? stored!.snapshotA : stored!.snapshotB;
      expect(ownSide).not.toBe(watcher);
    });

    it('captures a side the watcher never announced', async () => {
      writeFileSync(join(base, 'a', 'total.ts'), body('1'));
      writeFileSync(join(base, 'b', 'total.ts'), body('2'));
      await observe();
      pipeline.detach();
      const fresh = build();

      expect(await run(new AbortController().signal, fresh)).toMatchObject({
        kind: 'analysed',
        clean: false,
      });
      fresh.detach();
    });

    it('follows a new branch that carried uncommitted work off another with checkout -b', async () => {
      writeFileSync(join(base, 'a', 'total.ts'), body('1'));
      writeFileSync(join(base, 'b', 'total.ts'), body('2'));
      await observe();

      // The work moves with the worktree; the branch it left keeps only commits.
      git(join(base, 'a'), 'checkout', '-q', '-b', 'a2');
      await observe();
      const [left, moved, b] = [
        await branchNamed('a'),
        await branchNamed('a2'),
        await branchNamed('b'),
      ];
      expect(left.worktreePath).toBeNull();
      expect(moved.worktreePath).toBe(join(base, 'a'));

      const { candidates } = await pipeline.plan(moved.repoId, moved.id);
      const candidate = candidates.find((c) => c.pair.a === b.id || c.pair.b === b.id)!;
      expect(candidate.overlap.tier).toBe('file');
      expect(
        await pipeline.runPair(request(candidate), new AbortController().signal),
      ).toMatchObject({ kind: 'analysed', clean: false });
      const [finding] = await store.listOpenFindings(moved.repoId);
      const spans = finding!.evidence.filter((e): e is SpanEvidence => e.type === 'span');
      expect(new Set(spans.map((span) => span.branchRefId))).toEqual(new Set([moved.id, b.id]));

      // The branch left behind changed nothing, so it pairs with nobody but main.
      const fromLeft = await pipeline.plan(left.repoId, left.id);
      expect(fromLeft.candidates.map((c) => c.target)).toEqual([true]);
    });

    it('works on a repository whose history is borrowed from another', async () => {
      // `clone --shared` holds no objects of its own: every commit is read from
      // upstream through the clone's alternates, and the shadow borrows the
      // clone — so the change set, the merge base and the merge all read
      // through two stores.
      const upstream = join(base, 'upstream');
      execFileSync('git', ['init', '-q', '-b', 'main', upstream], { stdio: 'pipe' });
      for (const [key, value] of [
        ['user.name', 'Interlock Test'],
        ['user.email', 'test@example.invalid'],
      ]) {
        git(upstream, 'config', key!, value!);
      }
      writeFileSync(join(upstream, 'total.ts'), body('items.length'));
      git(upstream, 'add', '-A');
      git(upstream, 'commit', '-qm', 'base');
      const borrower = join(base, 'borrower');
      execFileSync('git', ['clone', '-q', '--shared', upstream, borrower], { stdio: 'pipe' });
      for (const [key, value] of [
        ['user.name', 'Interlock Test'],
        ['user.email', 'test@example.invalid'],
        ['maintenance.auto', 'false'],
        ['gc.auto', '0'],
      ]) {
        git(borrower, 'config', key!, value!);
      }
      expect(git(borrower, 'count-objects').trim()).toMatch(/^0 objects/u);
      git(borrower, 'worktree', 'add', '-q', '-b', 'x', join(base, 'x'));
      git(borrower, 'worktree', 'add', '-q', '-b', 'y', join(base, 'y'));
      writeFileSync(join(base, 'x', 'total.ts'), body('1'));
      writeFileSync(join(base, 'y', 'total.ts'), body('2'));
      for (const path of [borrower, join(base, 'x'), join(base, 'y')]) sweep.markChanged(path);
      await sweep.reconcile(borrower);

      const theirs = (await store.listRepos()).find((r) => r.rootPath === borrower)!;
      const branches = await store.listBranchRefs(theirs.id);
      const [x, y] = ['x', 'y'].map((name) => branches.find((branch) => branch.name === name)!);
      const { candidates } = await pipeline.plan(theirs.id, x!.id);
      const candidate = candidates.find((c) => c.pair.a === y!.id || c.pair.b === y!.id)!;
      expect(candidate.overlap.tier).toBe('file');

      const result = await pipeline.runPair(request(candidate), new AbortController().signal);

      expect(result).toMatchObject({ kind: 'analysed', clean: false, findingCount: 1 });
      expect(git(borrower, 'count-objects').trim()).toMatch(/^0 objects/u);
    });

    it('skips a side whose worktree could not be read', async () => {
      await observe();
      const a = await branchNamed('a');
      await bus.publish({
        type: 'branch.snapshot',
        repoId: a.repoId,
        at: new Date().toISOString(),
        branchRefId: a.id,
        treeOid: null,
        headSha: null,
        changeSetId: null,
        fileCount: 0,
      });

      expect(await run()).toEqual({ kind: 'skipped', reason: 'unreadable' });
    });

    it('skips a pair whose histories stopped sharing an ancestor after it was planned', async () => {
      git(root, 'checkout', '-q', '--orphan', 'lonely');
      git(root, 'commit', '-qm', 'alone', '--allow-empty');
      git(root, 'checkout', '-q', 'main');
      await observe();
      const [a, lonely] = [await branchNamed('a'), await branchNamed('lonely')];
      const [x, y] = a.id < lonely.id ? [a.id, lonely.id] : [lonely.id, a.id];
      const candidate: PairCandidate = {
        pair: {
          id: ulid(),
          repoId: a.repoId,
          a: x,
          b: y,
          key: makePairKey(x, y),
          mergeBaseSha: 'e'.repeat(40),
          priority: 0,
          lastRunAt: null,
          stale: true,
        },
        overlap: { tier: 'unknown', commonFiles: [] },
        target: false,
        openFindings: false,
      };

      expect(await pipeline.runPair(request(candidate), new AbortController().signal)).toEqual({
        kind: 'skipped',
        reason: 'unrelated',
      });
    });

    it('recovers a side whose files never changed after the shadow is rebuilt', async () => {
      writeFileSync(join(base, 'a', 'total.ts'), body('1'));
      writeFileSync(join(base, 'b', 'total.ts'), body('2'));
      await observe();
      expect((await run()).kind).toBe('analysed');
      const handle = { kind: 'user' as const, rootPath: root, gitDir: join(root, '.git') };
      rmSync((await shadows.get(handle, (await repo()).id)).rootPath, {
        recursive: true,
        force: true,
      });
      // The watcher notices on its next capture, gives the shadow up, and the
      // one after rebuilds it; nothing on disk changed in between.
      await observe().catch(() => undefined);
      await observe().catch(() => undefined);

      for (let attempt = 0; attempt < 3; attempt++) {
        lastKey = null;
        expect((await run()).kind).toBe('analysed');
      }
    });

    it('gives up a shadow a merge could not find its commits in', async () => {
      writeFileSync(join(base, 'a', 'total.ts'), body('1'));
      writeFileSync(join(base, 'b', 'total.ts'), body('2'));
      await observe();
      await run();
      const handle = { kind: 'user' as const, rootPath: root, gitDir: join(root, '.git') };
      const before = await shadows.get(handle, (await repo()).id);
      // Content no run has judged, or its verdict would answer without a merge.
      writeFileSync(join(base, 'b', 'total.ts'), body('3'));
      await observe();
      // The merge fails, and the check that follows finds a commit missing.
      let merged = false;
      const stale: GitRunner = {
        run: (target, args, options) => {
          if (args.includes('merge-tree')) {
            merged = true;
            return Promise.resolve({ stdout: '', stderr: '', exitCode: 2 });
          }
          if (merged && args[0] === 'cat-file' && args[1] === '-e') {
            return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 });
          }
          return runner.run(target, args, options);
        },
      };
      const other = build(stale);
      lastKey = null;

      await expect(run(new AbortController().signal, other)).rejects.toMatchObject({
        code: 'SNAPSHOT_STALE',
      });
      other.detach();

      expect(await shadows.get(handle, (await repo()).id)).not.toBe(before);
    });

    it('recovers when the shadow is removed from under it', async () => {
      writeFileSync(join(base, 'a', 'total.ts'), body('1'));
      writeFileSync(join(base, 'b', 'total.ts'), body('2'));
      await observe();
      const handle = { kind: 'user' as const, rootPath: root, gitDir: join(root, '.git') };
      const shadow = await shadows.get(handle, (await repo()).id);
      rmSync(shadow.rootPath, { recursive: true, force: true });

      // The first capture after the removal fails, and gives the shadow up.
      writeFileSync(join(base, 'a', 'total.ts'), body('10'));
      writeFileSync(join(base, 'b', 'total.ts'), body('20'));
      await observe().catch(() => undefined);
      await observe().catch(() => undefined);

      expect(await run()).toMatchObject({ kind: 'analysed', clean: false });
    });

    it('skips a pair whose branch has gone', async () => {
      await observe();
      const a = await branchNamed('a');
      const { candidates } = await pipeline.plan(a.repoId, a.id);
      await store.deleteBranchRef(a.id);

      expect(await pipeline.runPair(request(candidates[0]!), new AbortController().signal)).toEqual(
        {
          kind: 'skipped',
          reason: 'branch-gone',
        },
      );
    });
  });

  describe('shadow collection', () => {
    const HOUR = 60 * 60_000;

    const collector = (): ShadowCollector =>
      createShadowCollector({
        shadows,
        store,
        runner,
        heldTrees: (repoId) => pipeline.heldTrees(repoId),
        marginMs: SNAPSHOT_COMMIT_REUSE_MS,
        logger: createLogger('test', { level: 'warn', sink: (record) => warnings.push(record) }),
      });

    const shadowPath = async (): Promise<string> =>
      (
        await shadows.get(
          { kind: 'user', rootPath: root, gitDir: join(root, '.git') },
          (await repo()).id,
        )
      ).rootPath;

    /** Everything the shadow wrote so far, last written `ms` ago: a day passing, for `prune`. */
    const age = async (ms: number): Promise<void> => {
      const objects = join(await shadowPath(), 'objects');
      const at = new Date(Date.now() - ms);
      for (const dir of readdirSync(objects).filter((name) => /^[0-9a-f]{2}$/u.test(name))) {
        for (const file of readdirSync(join(objects, dir)))
          utimesSync(join(objects, dir, file), at, at);
      }
    };

    const readable = async (oid: string): Promise<boolean> => {
      try {
        git(await shadowPath(), 'cat-file', '-e', oid);
        return true;
      } catch {
        return false;
      }
    };

    const branchSnapshot = async (name: string): Promise<BranchSnapshotPayload> => {
      const branch = await branchNamed(name);
      return published('branch.snapshot')
        .map((record) => record.payload as unknown as BranchSnapshotPayload)
        .filter((payload) => payload.branchRefId === branch.id)
        .at(-1)!;
    };

    const evidenceCommits = (finding: Finding): string[] =>
      finding.evidence.flatMap((evidence) =>
        evidence.type === 'merge-conflict' ? [evidence.commitA, evidence.commitB] : [],
      );

    beforeEach(async () => {
      writeFileSync(join(base, 'a', 'total.ts'), body('1'));
      writeFileSync(join(base, 'b', 'total.ts'), body('2'));
      await observe();
    });

    /**
     * The real runner, stopping at the first `verb` until released: what is
     * running then is mid-write to the shadow.
     */
    const pausing = (
      verb: string,
    ): { runner: GitRunner; reached: Promise<void>; release: () => void } => {
      let reach!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        reach = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let paused = false;
      return {
        reached,
        release,
        runner: {
          run: async (target, args, options): Promise<GitResult> => {
            // `includes`: a merge runs as `git --attr-source=<commit> merge-tree`.
            if (args.includes(verb) && !paused) {
              paused = true;
              reach();
              await released;
            }
            return runner.run(target, args, options);
          },
        },
      };
    };

    const handle = (): UserRepo => ({ kind: 'user', rootPath: root, gitDir: join(root, '.git') });

    it('waits for a run writing to the shadow before collecting it', async () => {
      const pause = pausing('merge-tree');
      const using = build(pause.runner);
      const order: string[] = [];
      const running = runWith('b', undefined, using).then(() => order.push('run'));
      await pause.reached;

      const collecting = shadows
        .collect(handle(), (await repo()).id, {
          // An hour back, as a real expiry is at least: what the paused writer
          // wrote is fresh, and only the gate is under test.
          expireBefore: new Date(Date.now() - HOUR),
          keep: () => Promise.resolve([]),
        })
        .then(() => order.push('collected'));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(order).toEqual([]);

      pause.release();
      await Promise.all([running, collecting]);
      using.detach();
      expect(order).toEqual(['run', 'collected']);
    });

    it('waits for a capture writing to the shadow before collecting it', async () => {
      const pause = pausing('write-tree');
      const capturing = createSweep({
        store,
        bus,
        runner: pause.runner,
        dataDir: join(base, 'data'),
        shadows,
      });
      writeFileSync(join(base, 'a', 'total.ts'), body('4'));
      capturing.markChanged(join(base, 'a'));
      const order: string[] = [];
      const reconciling = capturing.reconcile(root).then(() => order.push('captured'));
      await pause.reached;

      const collecting = shadows
        .collect(handle(), (await repo()).id, {
          // An hour back, as a real expiry is at least: what the paused writer
          // wrote is fresh, and only the gate is under test.
          expireBefore: new Date(Date.now() - HOUR),
          keep: () => Promise.resolve([]),
        })
        .then(() => order.push('collected'));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(order).toEqual([]);

      pause.release();
      await Promise.all([reconciling, collecting]);
      // Either order after that: the change set is a second hold of its own,
      // and a waiting collection goes ahead of it.
      expect([...order].sort()).toEqual(['captured', 'collected']);
    });

    it('keeps an open Finding’s commits however old, and lets them go once it resolves', async () => {
      await run();
      const [finding] = await store.listOpenFindings((await repo()).id);
      const commits = evidenceCommits(finding!);
      // Snapshot commits, made in the shadow: nothing but a keep ref holds them.
      expect(commits).toHaveLength(2);
      await age(30 * 24 * HOUR);

      await collector().pass(new Date().toISOString());

      for (const commit of commits) expect(await readable(commit)).toBe(true);
      expect(warnings).toEqual([]);

      writeFileSync(join(base, 'b', 'total.ts'), body('items.length'));
      await observe();
      expect(await run()).toMatchObject({ kind: 'analysed', clean: true });
      expect(await store.getFinding(finding!.id)).toMatchObject({ status: 'resolved' });
      await age(30 * 24 * HOUR);

      await collector().pass(new Date().toISOString());

      for (const commit of commits) expect(await readable(commit)).toBe(false);
    });

    it('keeps a stale Finding’s commits, which a re-verification may still confirm', async () => {
      await run();
      const [finding] = await store.listOpenFindings((await repo()).id);
      await store.upsertFinding({ ...finding!, status: 'stale' });
      await age(30 * 24 * HOUR);

      await collector().pass(new Date().toISOString());

      for (const commit of evidenceCommits(finding!)) expect(await readable(commit)).toBe(true);
    });

    it('keeps the trees an idle branch was last seen at, which its next check merges', async () => {
      const trees = published('branch.snapshot').map(
        (record) => (record.payload as unknown as BranchSnapshotPayload).treeOid,
      );
      await age(30 * 24 * HOUR);

      await collector().pass(new Date().toISOString());

      for (const tree of trees) expect(await readable(tree)).toBe(true);
      // And the check runs on them, rather than failing on a tree that is gone.
      expect(await run()).toMatchObject({ kind: 'analysed', clean: false });
    });

    it('holds each repository’s trees for that repository alone', async () => {
      const own = (await branchSnapshot('a')).treeOid;
      const elsewhere = 'beef'.repeat(10);
      await bus.publish({
        type: 'branch.snapshot',
        repoId: ulid<RepoId>(),
        at: new Date().toISOString(),
        branchRefId: ulid<BranchRefId>(),
        treeOid: elsewhere,
        headSha: 'cafe'.repeat(10),
        changeSetId: null,
        fileCount: 1,
      });

      const held = pipeline.heldTrees((await repo()).id);

      // Another repository's tree is not in this shadow, and asking to keep
      // it would only report it unkeepable on every pass.
      expect(held).toContain(own);
      expect(held).not.toContain(elsewhere);
    });

    it('makes a new snapshot commit for a tree once the one it had is past its reuse bound', async () => {
      /** The tree of every commit made, in order. */
      const committed: string[] = [];
      const counting: GitRunner = {
        run: (target, args, options): Promise<GitResult> => {
          if (args[0] === 'commit-tree') committed.push(args.at(-1)!);
          return runner.run(target, args, options);
        },
      };
      const using = build(counting);
      const treeOfA = (await branchSnapshot('a')).treeOid;
      const madeForA = (): number => committed.filter((tree) => tree === treeOfA).length;
      await runWith('b', undefined, using);
      expect(madeForA()).toBe(1);

      // The same side of `a` against another branch: its commit is reused.
      await runWith('main', undefined, using);
      expect(madeForA()).toBe(1);

      const realNow = Date.now;
      const later = realNow() + SNAPSHOT_COMMIT_REUSE_MS + 1;
      Date.now = () => later;
      try {
        // New content on the other side, so the pair is merged rather than
        // answered from the verdict cache.
        writeFileSync(join(root, 'other.ts'), lines('main moved'));
        await observe();
        await runWith('main', undefined, using);
      } finally {
        Date.now = realNow;
        using.detach();
      }
      // `a` did not change, and still got a fresh commit: one as old as its
      // first run would be older than a verdict written now by more than the
      // margin collection leaves.
      expect(madeForA()).toBe(2);
    });
  });
});
