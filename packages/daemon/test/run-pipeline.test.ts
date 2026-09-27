import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRunner } from '@interlock/core';
import type { GitRunner } from '@interlock/core';
import { makePairKey, silentLogger, ulid } from '@interlock/shared';
import type { BranchRef, EventId, EventRecord, Repo, SpanEvidence } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/bus/index.js';
import type { PairCandidate, PairRunRequest, PairRunResult } from '../src/scheduler/index.js';
import { createRunPipeline } from '../src/scheduler/run-pipeline.js';
import type { RunPipeline } from '../src/scheduler/run-pipeline.js';
import { createShadowRegistry } from '../src/shadows.js';
import type { ShadowRegistry } from '../src/shadows.js';
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

  const build = (with_: GitRunner = runner): RunPipeline => {
    const made = createRunPipeline({ store, bus, runner: with_, shadows, logger: silentLogger });
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

      expect((await run()).kind).toBe('analysed');
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
});
