import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRunner } from '@interlock/core';
import type { GitRunner, UserRepo } from '@interlock/core';
import { createLogger } from '@interlock/shared';
import type { LogRecord, Repo, RepoId } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COLLECTION_BACKOFF_MAX_MS,
  COLLECTION_BACKOFF_MS,
  createShadowCollector,
  createShadowRegistry,
} from '../src/shadows.js';
import type { ShadowCollector, ShadowRegistry } from '../src/shadows.js';
import { openStore } from '../src/store/index.js';
import type { Store } from '../src/store/index.js';

/**
 * The registry resolves each repository's shadow once. `ensureShadow` fetches
 * on every call, so fetches are what this counts: one per resolution.
 */
describe('shadow registry', () => {
  let base: string;
  let repo: UserRepo;
  let fetches: number;
  let failFetch: boolean;
  const real = createGitRunner();
  const repoId = '01JBQ0000000000000000SHDW' as RepoId;

  const runner: GitRunner = {
    run: (target, args, options) => {
      if (args.includes('fetch')) {
        fetches += 1;
        if (failFetch) return Promise.resolve({ stdout: '', stderr: '', exitCode: 128 });
      }
      return real.run(target, args, options);
    },
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-shadows-')));
    const root = join(base, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
    for (const [key, value] of [
      ['user.name', 'Interlock Test'],
      ['user.email', 'test@example.invalid'],
      ['maintenance.auto', 'false'],
      ['gc.auto', '0'],
    ]) {
      execFileSync('git', ['-C', root, 'config', key!, value!]);
    }
    writeFileSync(join(root, 'a.txt'), 'a\n');
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'one']);
    repo = { kind: 'user', rootPath: root, gitDir: join(root, '.git') };
    fetches = 0;
    failFetch = false;
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('resolves a repository’s shadow once and hands the same one out after', async () => {
    const shadows = createShadowRegistry({ runner, dataDir: join(base, 'data') });

    const first = await shadows.get(repo, repoId);
    const second = await shadows.get(repo, repoId);

    expect(second).toBe(first);
    expect(fetches).toBe(1);
  });

  it('does not remember a failure, so the next caller tries again', async () => {
    const shadows = createShadowRegistry({ runner, dataDir: join(base, 'data') });
    failFetch = true;
    await expect(shadows.get(repo, repoId)).rejects.toThrow();

    failFetch = false;
    await expect(shadows.get(repo, repoId)).resolves.toMatchObject({ kind: 'shadow' });
    expect(fetches).toBe(2);
  });

  it('resolves again once told a shadow failed', async () => {
    const shadows = createShadowRegistry({ runner, dataDir: join(base, 'data') });
    await shadows.get(repo, repoId);

    shadows.forget(repoId);
    await shadows.get(repo, repoId);

    expect(fetches).toBe(2);
  });

  describe('the collection gate', () => {
    /** A promise and the function that settles it, for holding a run open. */
    const deferred = (): { promise: Promise<void>; resolve: () => void } => {
      let resolve!: () => void;
      const promise = new Promise<void>((settle) => {
        resolve = settle;
      });
      return { promise, resolve };
    };

    /** Turns of the event loop, enough for anything unblocked to have moved. */
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    };

    const collectNow = { expireBefore: new Date(), keep: () => Promise.resolve([]) };

    it('holds a collection until every run holding the shadow is done', async () => {
      const shadows = createShadowRegistry({ runner, dataDir: join(base, 'data') });
      const order: string[] = [];
      const holding = deferred();
      const started = deferred();
      const run = shadows.use(repo, repoId, async () => {
        order.push('run started');
        started.resolve();
        await holding.promise;
        order.push('run done');
      });
      await started.promise;

      const collection = shadows.collect(repo, repoId, collectNow).then(() => {
        order.push('collected');
      });
      await settle();
      expect(order).toEqual(['run started']);

      holding.resolve();
      await Promise.all([run, collection]);
      expect(order).toEqual(['run started', 'run done', 'collected']);
    });

    it('holds off a run that asks once the collection wants the shadow, so runs cannot starve it', async () => {
      const order: string[] = [];
      // The collection's end, as its repack and prune finish, whichever runs
      // last: its own promise settles a few turns after the gate is released,
      // and a run woken by that release can log before it.
      const done = new Set<string>();
      const marking: GitRunner = {
        run: async (target, args, options) => {
          const result = await runner.run(target, args, options);
          if (args[0] === 'prune' || args[0] === 'repack') {
            done.add(args[0]);
            if (done.size === 2) order.push('collected');
          }
          return result;
        },
      };
      const shadows = createShadowRegistry({ runner: marking, dataDir: join(base, 'data') });
      const holding = deferred();
      const started = deferred();
      const first = shadows.use(repo, repoId, () => {
        started.resolve();
        return holding.promise;
      });
      await started.promise;
      const wantsIt = deferred();
      const collection = shadows.collect(repo, repoId, {
        ...collectNow,
        quiet: () => {
          wantsIt.resolve();
          return Promise.resolve();
        },
      });

      await wantsIt.promise;
      await settle();

      const second = shadows.use(repo, repoId, () => {
        order.push('second run');
        return Promise.resolve();
      });
      await settle();
      expect(order).toEqual([]);

      holding.resolve();
      await Promise.all([first, collection, second]);
      expect(order).toEqual(['collected', 'second run']);
    });

    it('pins what to keep beside a running check, holding it off only to repack and prune', async () => {
      const shadows = createShadowRegistry({ runner, dataDir: join(base, 'data') });
      const holding = deferred();
      const started = deferred();
      const run = shadows.use(repo, repoId, async () => {
        started.resolve();
        await holding.promise;
      });
      await started.promise;
      const keepRead = deferred();
      const collection = shadows.collect(repo, repoId, {
        expireBefore: new Date(),
        keep: () => {
          keepRead.resolve();
          return Promise.resolve([]);
        },
      });

      // Read while the run still holds the shadow, and another check goes
      // ahead meanwhile: nothing the pin does can take an object from under it.
      await keepRead.promise;
      await expect(shadows.use(repo, repoId, () => Promise.resolve('ran'))).resolves.toBe('ran');

      holding.resolve();
      await Promise.all([run, collection]);
    });

    it('waits for a quiet moment with the checks still running, and says how long each wait was', async () => {
      const shadows = createShadowRegistry({ runner, dataDir: join(base, 'data') });
      const lull = deferred();
      const asked = deferred();
      const collection = shadows.collect(repo, repoId, {
        ...collectNow,
        quiet: () => {
          asked.resolve();
          return lull.promise;
        },
      });
      await asked.promise;
      await expect(shadows.use(repo, repoId, () => Promise.resolve('ran'))).resolves.toBe('ran');
      await new Promise((resolve) => setTimeout(resolve, 50));

      lull.resolve();
      const report = await collection;

      expect(report.quietMs).toBeGreaterThanOrEqual(50);
      expect(report.durationMs).toBeGreaterThanOrEqual(report.quietMs + report.pausedMs);
    });

    it('runs one collection of a repository at a time, pinning included', async () => {
      // Every command, in order: a second collection's refresh begins only
      // once the first has pruned and packed. Overlapped, the second would
      // rewrite the keep refs under the first's walk.
      const seen: string[] = [];
      const recording: GitRunner = {
        run: (target, args, options) => {
          seen.push(args.includes('fetch') ? 'fetch' : args[0]!);
          return runner.run(target, args, options);
        },
      };
      const shadows = createShadowRegistry({ runner: recording, dataDir: join(base, 'data') });
      await shadows.get(repo, repoId);
      seen.length = 0;

      await Promise.all([
        shadows.collect(repo, repoId, collectNow),
        shadows.collect(repo, repoId, collectNow),
      ]);

      const fetches = seen.flatMap((verb, index) => (verb === 'fetch' ? [index] : []));
      expect(fetches).toHaveLength(2);
      const firstDone = Math.max(seen.indexOf('prune'), seen.indexOf('repack'));
      expect(firstDone).toBeGreaterThan(fetches[0]!);
      expect(fetches[1]).toBeGreaterThan(firstDone);
    });

    it('lets a run go on after a collection that failed', async () => {
      const shadows = createShadowRegistry({ runner, dataDir: join(base, 'data') });
      await expect(
        shadows.collect(repo, repoId, {
          expireBefore: new Date(),
          keep: () => Promise.reject(new Error('the store is gone')),
        }),
      ).rejects.toThrow('the store is gone');

      await expect(shadows.use(repo, repoId, () => Promise.resolve('ran'))).resolves.toBe('ran');
    });

    it('refreshes the shadow first, so a ref to a branch the user collected cannot stop it', async () => {
      const git = (...args: string[]): string =>
        execFileSync('git', ['-C', repo.rootPath, ...args], { stdio: 'pipe', encoding: 'utf8' });
      git('checkout', '-qb', 'feature');
      writeFileSync(join(repo.rootPath, 'f.txt'), 'only on feature\n');
      git('add', '-A');
      git('commit', '-qm', 'feature');
      git('checkout', '-q', 'main');
      const shadows = createShadowRegistry({ runner, dataDir: join(base, 'data') });
      await shadows.get(repo, repoId);
      git('branch', '-D', 'feature');
      git('reflog', 'expire', '--expire=now', '--all');
      git('gc', '-q', '--prune=now');

      await expect(shadows.collect(repo, repoId, collectNow)).resolves.toMatchObject({
        unkeepable: [],
      });
      // The refreshed handle is the one handed out after.
      expect(fetches).toBe(2);
      await shadows.get(repo, repoId);
      expect(fetches).toBe(2);
    });
  });

  describe('the collection record', () => {
    const deferred = (): { promise: Promise<void>; resolve: () => void } => {
      let resolve!: () => void;
      const promise = new Promise<void>((settle) => {
        resolve = settle;
      });
      return { promise, resolve };
    };

    /** Turns of the event loop until `probe` holds, for a callback git has yet to reach. */
    const until = async (probe: () => boolean): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (!probe()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    let clock: number;
    const at = (ms: number): string => new Date(ms).toISOString();
    const T0 = Date.parse('2026-10-11T12:00:00.000Z');

    beforeEach(() => {
      clock = T0;
    });

    const registry = (): ShadowRegistry =>
      createShadowRegistry({ runner, dataDir: join(base, 'data'), now: () => clock });

    it('reads as no collection yet before the first, as after a restart', () => {
      expect(registry().state(repoId)).toStrictEqual({
        phase: 'idle',
        since: null,
        last: null,
        failing: null,
      });
    });

    it('names each phase as the collection reaches it, with when it began, and keeps the last one’s measures', async () => {
      const shadows = registry();
      // A loose object the collection packs, so the sizes before and after differ.
      const shadow = await shadows.get(repo, repoId);
      execFileSync('git', ['--git-dir', shadow.gitDir, 'hash-object', '-w', '--stdin'], {
        input: 'loose\n',
      });
      const seen: { phase: string; since: string | null }[] = [];
      const record = (): void => {
        const { phase, since } = shadows.state(repoId);
        seen.push({ phase, since });
      };
      // A check holding the shadow, so the collection's hold has to wait for it.
      const holding = deferred();
      const started = deferred();
      const run = shadows.use(repo, repoId, async () => {
        started.resolve();
        await holding.promise;
      });
      await started.promise;
      const lull = deferred();
      const collection = shadows.collect(repo, repoId, {
        expireBefore: new Date(),
        keep: () => {
          record();
          clock = T0 + 1_000;
          return Promise.resolve([]);
        },
        quiet: () => {
          record();
          return lull.promise;
        },
      });
      await until(() => seen.length === 2);
      clock = T0 + 3_000;
      lull.resolve();
      await until(() => shadows.state(repoId).phase === 'holding');
      record();
      clock = T0 + 7_500;
      holding.resolve();
      const report = await Promise.all([run, collection]).then(([, collected]) => collected);

      expect(seen).toStrictEqual([
        { phase: 'pinning', since: at(T0) },
        { phase: 'waiting-for-quiet', since: at(T0 + 1_000) },
        { phase: 'holding', since: at(T0 + 3_000) },
      ]);
      expect(report).toMatchObject({ quietMs: 2_000, pausedMs: 4_500, durationMs: 7_500 });
      expect(report.before.loose).toBeGreaterThan(report.after.loose);
      expect(shadows.state(repoId)).toStrictEqual({
        phase: 'idle',
        since: null,
        last: {
          endedAt: at(T0 + 7_500),
          pausedMs: 4_500,
          quietMs: 2_000,
          before: report.before,
          after: report.after,
        },
        failing: null,
      });
    });

    it('holds one repository while another reads idle', async () => {
      const shadows = registry();
      const other = '01JBQ0000000000000000OTHR' as RepoId;
      const holding = deferred();
      const started = deferred();
      const run = shadows.use(repo, repoId, async () => {
        started.resolve();
        await holding.promise;
      });
      await started.promise;
      const collection = shadows.collect(repo, repoId, {
        expireBefore: new Date(),
        keep: () => Promise.resolve([]),
      });
      await until(() => shadows.state(repoId).phase === 'holding');

      expect(shadows.state(other)).toMatchObject({ phase: 'idle', since: null, last: null });

      holding.resolve();
      await Promise.all([run, collection]);
      expect(shadows.state(other).last).toBeNull();
      expect(shadows.state(repoId).last).not.toBeNull();
    });

    it('returns to idle when stopped while holding, keeping the last finished collection', async () => {
      const shadows = registry();
      await shadows.collect(repo, repoId, {
        expireBefore: new Date(),
        keep: () => Promise.resolve([]),
      });
      const finished = shadows.state(repoId).last;
      expect(finished).not.toBeNull();

      const holding = deferred();
      const started = deferred();
      const run = shadows.use(repo, repoId, async () => {
        started.resolve();
        await holding.promise;
      });
      await started.promise;
      const controller = new AbortController();
      clock = T0 + 60_000;
      const collection = shadows.collect(repo, repoId, {
        expireBefore: new Date(),
        keep: () => Promise.resolve([]),
        signal: controller.signal,
      });
      await until(() => shadows.state(repoId).phase === 'holding');
      controller.abort();
      holding.resolve();

      await expect(collection).rejects.toThrow();
      await run;
      expect(shadows.state(repoId)).toStrictEqual({
        phase: 'idle',
        since: null,
        last: finished,
        failing: null,
      });
    });

    it('returns to idle when the collection fails before it holds anything', async () => {
      const shadows = registry();
      const failed = shadows.collect(repo, repoId, {
        expireBefore: new Date(),
        keep: () => {
          expect(shadows.state(repoId).phase).toBe('pinning');
          return Promise.reject(new Error('the store is gone'));
        },
      });

      await expect(failed).rejects.toThrow('the store is gone');
      expect(shadows.state(repoId)).toMatchObject({ phase: 'idle', since: null, last: null });
    });

    it('carries a failure the collector reports until it reports one cleared', () => {
      const shadows = registry();
      const failure = { failures: 2, retryAt: at(T0), reason: 'disk full' };

      shadows.reportFailure(repoId, failure);
      expect(shadows.state(repoId)).toMatchObject({ phase: 'idle', failing: failure });

      shadows.reportFailure(repoId, null);
      expect(shadows.state(repoId).failing).toBeNull();
    });
  });

  describe('the collector', () => {
    let store: Store;
    let stored: Repo;
    let logs: LogRecord[];
    let clock: number;
    let prunes: number;
    let failPrune: boolean;
    const HOUR = 60 * 60_000;

    const pruning: GitRunner = {
      run: (target, args, options) => {
        if (args[0] === 'prune') {
          prunes += 1;
          if (failPrune) return Promise.resolve({ stdout: '', stderr: 'disk full', exitCode: 128 });
        }
        return runner.run(target, args, options);
      },
    };

    const collector = (heldTrees: readonly string[] = []): ShadowCollector =>
      createShadowCollector({
        shadows: createShadowRegistry({ runner: pruning, dataDir: join(base, 'data') }),
        store,
        runner: pruning,
        heldTrees: () => heldTrees,
        marginMs: HOUR,
        logger: createLogger('test', { level: 'debug', sink: (record) => logs.push(record) }),
        now: () => clock,
      });

    const messages = (): string[] => logs.filter((l) => l.level !== 'debug').map((l) => l.msg);

    /** Turns of the event loop until `probe` holds, for a callback git has yet to reach. */
    const until = async (probe: () => boolean): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (!probe()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    beforeEach(async () => {
      store = await openStore({ path: join(base, 'interlock.db') });
      stored = await store.upsertRepo({
        id: repoId,
        rootPath: repo.rootPath,
        defaultBranch: 'main',
        shadowPath: join(base, 'data', 'shadows', repoId),
        config: {},
        discoveredAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      });
      logs = [];
      clock = Date.now();
      prunes = 0;
      failPrune = false;
    });

    afterEach(async () => {
      await store.close();
    });

    it('collects each repository with an expiry the margin below the cutoff', async () => {
      const before = new Date(clock - 24 * HOUR).toISOString();

      await collector().pass(before);

      expect(prunes).toBe(1);
      const collected = logs.find((l) => l.msg === 'collected the shadow')!;
      expect(collected).toMatchObject({
        repoId: stored.id,
        expireBefore: new Date(Date.parse(before) - HOUR).toISOString(),
        kept: 0,
        unkeepable: [],
      });
    });

    it('keeps the trees a queued check would merge', async () => {
      const tree = execFileSync('git', ['-C', repo.rootPath, 'rev-parse', 'HEAD^{tree}'], {
        encoding: 'utf8',
      }).trim();

      await collector([tree]).pass(new Date(clock).toISOString());

      expect(logs.find((l) => l.msg === 'collected the shadow')!).toMatchObject({ kept: 1 });
    });

    it('backs off a repository whose collection failed, longer after each failure, and never throws', async () => {
      const collecting = collector();
      failPrune = true;
      await expect(collecting.pass(new Date(clock).toISOString())).resolves.toBeUndefined();
      expect(prunes).toBe(1);
      expect(logs.find((l) => l.msg === 'collecting a shadow failed')!).toMatchObject({
        failures: 1,
        retryAt: new Date(clock + COLLECTION_BACKOFF_MS).toISOString(),
      });

      clock += COLLECTION_BACKOFF_MS - 1;
      await collecting.pass(new Date(clock).toISOString());
      expect(prunes).toBe(1);

      clock += 1;
      await collecting.pass(new Date(clock).toISOString());
      expect(prunes).toBe(2);
      expect(logs.filter((l) => l.msg === 'collecting a shadow failed').at(-1)!).toMatchObject({
        failures: 2,
        retryAt: new Date(clock + 2 * COLLECTION_BACKOFF_MS).toISOString(),
      });

      // Recovered: collected at the next attempt, and the count starts over.
      failPrune = false;
      clock += 2 * COLLECTION_BACKOFF_MS;
      await collecting.pass(new Date(clock).toISOString());
      expect(prunes).toBe(3);
      expect(messages().at(-1)).toBe('collected the shadow');
      failPrune = true;
      await collecting.pass(new Date(clock).toISOString());
      expect(logs.filter((l) => l.msg === 'collecting a shadow failed').at(-1)!).toMatchObject({
        failures: 1,
      });
    });

    it('tells the registry a repository is failing, redacted, and clears it once one succeeds', async () => {
      const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
      let failWith: string | null = `fatal: could not write with ${secret}`;
      const throwing: GitRunner = {
        run: (target, args, options) => {
          if (args[0] === 'prune' && failWith !== null) return Promise.reject(new Error(failWith));
          return pruning.run(target, args, options);
        },
      };
      const shadows = createShadowRegistry({ runner: throwing, dataDir: join(base, 'data') });
      const collecting = createShadowCollector({
        shadows,
        store,
        runner: throwing,
        heldTrees: () => [],
        marginMs: HOUR,
        logger: createLogger('test', { level: 'debug', sink: (record) => logs.push(record) }),
        now: () => clock,
      });

      await collecting.pass(new Date(clock).toISOString());
      clock += COLLECTION_BACKOFF_MS;
      await collecting.pass(new Date(clock).toISOString());

      const { failing } = shadows.state(stored.id);
      expect(failing).toStrictEqual({
        failures: 2,
        retryAt: new Date(clock + 2 * COLLECTION_BACKOFF_MS).toISOString(),
        reason: expect.stringContaining('[redacted]') as unknown,
      });
      expect(failing!.reason).not.toContain(secret);
      expect(shadows.state(stored.id)).toMatchObject({ phase: 'idle', last: null });

      failWith = null;
      clock += 2 * COLLECTION_BACKOFF_MS;
      await collecting.pass(new Date(clock).toISOString());
      expect(shadows.state(stored.id).failing).toBeNull();
      expect(shadows.state(stored.id).last).not.toBeNull();
    });

    it('reports nothing failing for a repository it stopped on request', async () => {
      const controller = new AbortController();
      const shadows = createShadowRegistry({ runner: pruning, dataDir: join(base, 'data') });
      const collecting = createShadowCollector({
        shadows,
        store,
        runner: pruning,
        heldTrees: () => [],
        marginMs: HOUR,
        quiet: () => {
          controller.abort();
          return new Promise(() => undefined);
        },
        logger: createLogger('test', { level: 'debug', sink: (record) => logs.push(record) }),
        now: () => clock,
      });

      await collecting.pass(new Date(clock).toISOString(), controller.signal);

      expect(shadows.state(stored.id)).toStrictEqual({
        phase: 'idle',
        since: null,
        last: null,
        failing: null,
      });
    });

    it('treats a collection stopped on request as no failure, and collects at the next pass', async () => {
      const controller = new AbortController();
      let stopAtPrune = true;
      const stopping: GitRunner = {
        run: (target, args, options) => {
          if (args[0] === 'prune' && stopAtPrune) controller.abort();
          return pruning.run(target, args, options);
        },
      };
      const collecting = createShadowCollector({
        shadows: createShadowRegistry({ runner: stopping, dataDir: join(base, 'data') }),
        store,
        runner: stopping,
        heldTrees: () => [],
        marginMs: HOUR,
        logger: createLogger('test', { level: 'debug', sink: (record) => logs.push(record) }),
        now: () => clock,
      });

      await collecting.pass(new Date(clock).toISOString(), controller.signal);

      expect(messages()).toContain('stopped collecting a shadow');
      expect(messages()).not.toContain('collecting a shadow failed');
      // No backoff: the very next pass, at the same instant, collects.
      stopAtPrune = false;
      await collecting.pass(new Date(clock).toISOString());
      expect(messages().at(-1)).toBe('collected the shadow');
    });

    it('collects no repository once its signal has aborted', async () => {
      await collector().pass(new Date(clock).toISOString(), AbortSignal.abort());

      expect(prunes).toBe(0);
      expect(messages()).toEqual([]);
    });

    it('waits for the checks to go quiet before collecting', async () => {
      let settleQuiet: (() => void) | undefined;
      const collecting = createShadowCollector({
        shadows: createShadowRegistry({ runner: pruning, dataDir: join(base, 'data') }),
        store,
        runner: pruning,
        heldTrees: () => [],
        marginMs: HOUR,
        quiet: () =>
          new Promise((resolve) => {
            settleQuiet = resolve;
          }),
        logger: createLogger('test', { level: 'debug', sink: (record) => logs.push(record) }),
        now: () => clock,
      });

      const passing = collecting.pass(new Date(clock).toISOString());
      await until(() => settleQuiet !== undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(prunes).toBe(0);

      settleQuiet!();
      await passing;
      expect(prunes).toBe(1);
      expect(logs.find((l) => l.msg === 'collected the shadow')!.quietMs).toBeGreaterThanOrEqual(
        50,
      );
    });

    it('collects anyway once the checks have not gone quiet for the whole wait', async () => {
      const collecting = createShadowCollector({
        shadows: createShadowRegistry({ runner: pruning, dataDir: join(base, 'data') }),
        store,
        runner: pruning,
        heldTrees: () => [],
        marginMs: HOUR,
        quiet: () => new Promise(() => undefined),
        quietWaitMs: 50,
        logger: createLogger('test', { level: 'debug', sink: (record) => logs.push(record) }),
        now: () => clock,
      });

      await collecting.pass(new Date(clock).toISOString());

      expect(prunes).toBe(1);
    });

    it('stops waiting for quiet when stopped, and collects nothing', async () => {
      const controller = new AbortController();
      const collecting = createShadowCollector({
        shadows: createShadowRegistry({ runner: pruning, dataDir: join(base, 'data') }),
        store,
        runner: pruning,
        heldTrees: () => [],
        marginMs: HOUR,
        quiet: () => {
          controller.abort();
          return new Promise(() => undefined);
        },
        logger: createLogger('test', { level: 'debug', sink: (record) => logs.push(record) }),
        now: () => clock,
      });

      await collecting.pass(new Date(clock).toISOString(), controller.signal);

      expect(prunes).toBe(0);
      expect(messages()).toContain('stopped collecting a shadow');
    });

    it('waits a day at most between attempts', async () => {
      const collecting = collector();
      failPrune = true;
      for (let i = 0; i < 8; i++) {
        await collecting.pass(new Date(clock).toISOString());
        clock += COLLECTION_BACKOFF_MAX_MS;
      }
      // Every attempt a day after the last was due, and every one made: the
      // eighth failure's doubling would be 128 hours, capped at a day.
      expect(prunes).toBe(8);
      const last = logs.filter((l) => l.msg === 'collecting a shadow failed').at(-1)!;
      expect(last).toMatchObject({ failures: 8, retryAt: new Date(clock).toISOString() });
    });

    it('backs off a repository that is gone, and goes on to the next', async () => {
      const other = join(base, 'other');
      execFileSync('git', ['init', '-q', '-b', 'main', other], { stdio: 'pipe' });
      await store.upsertRepo({
        ...stored,
        id: '01JBQ0000000000000000OTHR' as RepoId,
        rootPath: other,
      });
      rmSync(repo.rootPath, { recursive: true, force: true });

      await collector().pass(new Date(clock).toISOString());

      expect(messages()).toContain('collecting a shadow failed');
      expect(prunes).toBe(1);
    });

    it('warns of a kept object it could not keep, and collects anyway', async () => {
      const missing = 'dead'.repeat(10);
      const collecting = createShadowCollector({
        shadows: createShadowRegistry({ runner: pruning, dataDir: join(base, 'data') }),
        store,
        runner: pruning,
        heldTrees: () => [missing, 'not an object id'],
        marginMs: HOUR,
        logger: createLogger('test', { level: 'debug', sink: (record) => logs.push(record) }),
        now: () => clock,
      });

      await collecting.pass(new Date(clock).toISOString());

      expect(prunes).toBe(1);
      expect(
        logs.find((l) => l.msg === 'could not keep objects a Finding or a queued check names'),
      ).toMatchObject({
        unkeepable: [missing],
      });
    });
  });
});
