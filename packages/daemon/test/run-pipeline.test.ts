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
    });

    it('is a duplicate at the same content, and merges nothing', async () => {
      await run();
      const before = published('run.started').length;

      const again = await run();

      expect(again.kind).toBe('duplicate');
      expect(published('run.started')).toHaveLength(before);
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

    it('merges a branch with no worktree at its head', async () => {
      git(root, 'branch', 'bare', 'main');
      writeFileSync(join(base, 'a', 'total.ts'), body('1'));
      await observe();
      const [a, bare] = [await branchNamed('a'), await branchNamed('bare')];
      const { candidates } = await pipeline.plan(a.repoId, a.id);
      const candidate = candidates.find((c) => c.pair.a === bare.id || c.pair.b === bare.id)!;
      expect(candidate.overlap.tier).toBe('unknown');

      const result = await pipeline.runPair(request(candidate), new AbortController().signal);

      expect(result).toMatchObject({ kind: 'analysed', clean: true });
    });

    it('captures a side again when the tree it was told of is not in the shadow', async () => {
      writeFileSync(join(base, 'a', 'total.ts'), body('1'));
      writeFileSync(join(base, 'b', 'total.ts'), body('2'));
      await observe();
      const a = await branchNamed('a');
      await bus.publish({
        type: 'branch.snapshot',
        repoId: a.repoId,
        at: new Date().toISOString(),
        branchRefId: a.id,
        treeOid: 'f'.repeat(40),
        headSha: a.headSha,
        changeSetId: null,
        fileCount: 1,
      });

      expect(await run()).toMatchObject({ kind: 'analysed', clean: false });
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
