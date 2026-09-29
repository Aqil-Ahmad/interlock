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
import type { ShadowCollector } from '../src/shadows.js';
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

    it('holds off a run that asks while a collection waits, so runs cannot starve it', async () => {
      const shadows = createShadowRegistry({ runner, dataDir: join(base, 'data') });
      const order: string[] = [];
      const holding = deferred();
      const started = deferred();
      const first = shadows.use(repo, repoId, () => {
        started.resolve();
        return holding.promise;
      });
      await started.promise;
      const collection = shadows.collect(repo, repoId, collectNow).then(() => {
        order.push('collected');
      });
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

    it('reads what to keep once the runs are done, not when it was asked', async () => {
      const shadows = createShadowRegistry({ runner, dataDir: join(base, 'data') });
      const holding = deferred();
      let done = false;
      const started = deferred();
      const run = shadows.use(repo, repoId, async () => {
        started.resolve();
        await holding.promise;
        done = true;
      });
      await started.promise;
      let readAfterRun: boolean | null = null;
      const collection = shadows.collect(repo, repoId, {
        expireBefore: new Date(),
        keep: () => {
          readAfterRun = done;
          return Promise.resolve([]);
        },
      });
      await settle();
      holding.resolve();
      await Promise.all([run, collection]);
      expect(readAfterRun).toBe(true);
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
