import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, makePairKey, ulid } from '@interlock/shared';
import type { BranchRefId, LogRecord, MergePairKey, RepoId } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitRunner } from '../src/git/repo-handle.js';
import type { GitRunner, ShadowRepo, UserRepo } from '../src/git/repo-handle.js';
import { ensureShadow } from '../src/git/shadow.js';
import {
  createWorktreePool,
  DEPENDENCY_FILES,
  dependencyDrift,
  poolPathFor,
} from '../src/git/worktree-pool.js';
import type {
  PoolSlot,
  SlotOutcome,
  SlotRequest,
  WorktreePool,
  WorktreePoolOptions,
} from '../src/git/worktree-pool.js';
import { speculativeMerge } from '../src/merge/speculative-merge.js';
import { rejection } from './support/rejection.js';

/**
 * The pool, against real repositories and a real shadow.
 *
 * What it promises is physical — which files a check rewrites, what survives
 * between checks, what is left on disk after a kill or an eviction — so every
 * case reads the disk rather than the pool's own account of it.
 */
describe('worktree pool', () => {
  let base: string;
  let dir: string;
  let dataDir: string;
  let shadow: ShadowRepo;
  let baseSha: string;
  let records: LogRecord[];
  const repoId = ulid<RepoId>();
  const runner = createGitRunner();

  const gitIn = (where: string, ...args: string[]): string =>
    execFileSync('git', ['-C', where, ...args], { stdio: 'pipe', encoding: 'utf8' });
  const git = (...args: string[]): string => gitIn(dir, ...args);
  const head = (): string => git('rev-parse', 'HEAD').trim();
  const treeOf = (commit: string): string => git('rev-parse', `${commit}^{tree}`).trim();

  const write = (root: string, path: string, content: string): void => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };

  /** A commit on its own branch off `from`, shaped by `edit`. */
  const commitOn = (name: string, from: string, edit: () => void): string => {
    git('checkout', '-q', '-B', name, from);
    edit();
    git('add', '-A');
    git('commit', '-qm', name);
    const sha = head();
    git('checkout', '-q', 'main');
    return sha;
  };

  const newKey = (): MergePairKey => makePairKey(ulid<BranchRefId>(), ulid<BranchRefId>());

  /** The shadow, refreshed so every commit made so far is in it. */
  const refresh = async (): Promise<ShadowRepo> => {
    const repo: UserRepo = { kind: 'user', rootPath: dir, gitDir: join(dir, '.git') };
    shadow = await ensureShadow(repo, { runner, dataDir, repoId });
    return shadow;
  };

  /** A clean pair's slot request, merged for real. */
  const request = async (
    key: MergePairKey,
    commitA: string,
    commitB: string,
    dependencyTreeOid = treeOf(baseSha),
  ): Promise<SlotRequest> => {
    await refresh();
    const mergeBaseSha = git('merge-base', commitA, commitB).trim();
    const merged = await speculativeMerge({ shadow, commitA, commitB, mergeBaseSha }, { runner });
    expect(merged.clean).toBe(true);
    return { key, commitA, commitB, merged, dependencyTreeOid };
  };

  const open = (options: Partial<WorktreePoolOptions> = {}): WorktreePool =>
    createWorktreePool(shadow, {
      runner,
      dataDir,
      repoId,
      logger: createLogger('test', { level: 'debug', sink: (record) => records.push(record) }),
      ...options,
    });

  /** A check that only looks at the slot, returning it. */
  const look = (pool: WorktreePool, slotRequest: SlotRequest): Promise<SlotOutcome<PoolSlot>> =>
    pool.withSlot(slotRequest, (slot) => Promise.resolve(slot));

  const ran = <T>(outcome: SlotOutcome<T>): Extract<SlotOutcome<T>, { kind: 'ran' }> => {
    if (outcome.kind !== 'ran') throw new Error(`expected a run, got ${outcome.kind}`);
    return outcome;
  };

  /**
   * The real runner, announcing each `commit-tree` it completes.
   *
   * A check's `commit-tree` is its last git call before it claims a slot, so
   * once the announcement lands the check is at the claim or past it — which
   * is what a race test has to wait for before its assertions mean anything.
   */
  const announcing = (): { runner: GitRunner; committed: (count: number) => Promise<void> } => {
    let done = 0;
    const waiting: { count: number; resolve: () => void }[] = [];
    return {
      runner: {
        run: async (target, args, options) => {
          const result = await runner.run(target, args, options);
          if (args[0] === 'commit-tree') {
            done += 1;
            for (const waiter of waiting.filter((entry) => entry.count <= done)) waiter.resolve();
          }
          return result;
        },
      },
      committed: (count) =>
        count <= done
          ? Promise.resolve()
          : new Promise((resolve) => {
              waiting.push({ count, resolve });
            }),
    };
  };

  /** Turns of the event loop, for a claim to settle after the call before it. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  const adminDirs = (): string[] => {
    const root = join(shadow.gitDir, 'worktrees');
    return existsSync(root) ? readdirSync(root).sort() : [];
  };

  const poolDir = (): string => poolPathFor(repoId, dataDir);

  const identity = (path: string): { ino: number; mtimeMs: number } => {
    const stat = statSync(path);
    return { ino: stat.ino, mtimeMs: stat.mtimeMs };
  };

  beforeEach(async () => {
    // git answers with fully-resolved paths, and on macOS /var is a symlink to
    // /private/var, so the fixture works in canonical form throughout.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-pool-')));
    dir = join(base, 'user');
    dataDir = join(base, 'data');
    records = [];
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
    git('config', 'user.name', 'Interlock Test');
    git('config', 'user.email', 'test@example.invalid');
    // Since git 2.47 `commit` detaches a maintenance process that holds
    // `objects/maintenance.lock` after the commit returns.
    git('config', 'maintenance.auto', 'false');
    git('config', 'gc.auto', '0');
    for (let i = 0; i < 40; i++)
      write(dir, `src/f${String(i)}.ts`, `export const f${String(i)} = ${String(i)};\n`);
    write(dir, 'package.json', '{"name":"fixture"}\n');
    write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
    write(dir, '.gitignore', 'dist/\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    baseSha = head();
    await refresh();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe('filling and updating', () => {
    it('fills a slot with the merged tree on a detached HEAD, moving no ref', async () => {
      const a = commitOn('one', baseSha, () =>
        write(dir, 'src/f1.ts', 'export const f1 = "one";\n'),
      );
      const b = commitOn('two', baseSha, () =>
        write(dir, 'src/f2.ts', 'export const f2 = "two";\n'),
      );
      const slotRequest = await request(newKey(), a, b);
      const refsBefore = gitIn(shadow.rootPath, 'for-each-ref');

      const outcome = ran(await look(open(), slotRequest));
      const slot = outcome.value;

      expect(outcome.fill).toBe('cold');
      expect(outcome.evicted).toBeNull();
      expect(readFileSync(join(slot.path, 'src/f1.ts'), 'utf8')).toContain('"one"');
      expect(readFileSync(join(slot.path, 'src/f2.ts'), 'utf8')).toContain('"two"');
      expect(gitIn(slot.path, 'rev-parse', 'HEAD').trim()).toBe(slot.commitSha);
      expect(gitIn(slot.path, 'rev-parse', 'HEAD^{tree}').trim()).toBe(slotRequest.merged.treeOid);
      expect(gitIn(slot.path, 'rev-parse', 'HEAD^1', 'HEAD^2').trim().split('\n')).toStrictEqual([
        a,
        b,
      ]);
      expect(() => gitIn(slot.path, 'symbolic-ref', '-q', 'HEAD')).toThrow();
      expect(gitIn(slot.path, 'status', '--porcelain')).toBe('');
      expect(gitIn(shadow.rootPath, 'for-each-ref')).toBe(refsBefore);
    });

    it('hands out a handle rooted at the slot whose git dir is the shadow', async () => {
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', '1\n'));
      const slotRequest = await request(newKey(), a, baseSha);

      const slot = ran(await look(open(), slotRequest)).value;

      expect(slot.repo.kind).toBe('shadow');
      expect(slot.repo.rootPath).toBe(slot.path);
      expect(slot.repo.originPath).toBe(shadow.originPath);
      expect(slot.path.startsWith(realpathSync(poolDir()))).toBe(true);
      const reported = (await runner.run(slot.repo, ['rev-parse', '--git-dir'])).stdout.trim();
      expect(realpathSync(reported)).toBe(realpathSync(slot.repo.gitDir));
    });

    it('rewrites only the files that differ on a second check of the pair', async () => {
      const a1 = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'one v1\n'));
      const b = commitOn('two', baseSha, () => write(dir, 'src/f2.ts', 'two\n'));
      const key = newKey();
      const pool = open();
      const slot = ran(await look(pool, await request(key, a1, b))).value;
      const before = new Map(
        readdirSync(join(slot.path, 'src')).map((name) => [
          name,
          identity(join(slot.path, 'src', name)),
        ]),
      );

      const a2 = commitOn('one', a1, () => {
        write(dir, 'src/f1.ts', 'one v2\n');
        rmSync(join(dir, 'src/f3.ts'));
      });
      const second = ran(await look(pool, await request(key, a2, b)));

      expect(second.fill).toBe('delta');
      expect(readFileSync(join(slot.path, 'src/f1.ts'), 'utf8')).toBe('one v2\n');
      expect(existsSync(join(slot.path, 'src/f3.ts'))).toBe(false);
      for (const [name, was] of before) {
        if (name === 'f1.ts' || name === 'f3.ts') continue;
        expect(identity(join(slot.path, 'src', name)), name).toStrictEqual(was);
      }
      expect(identity(join(slot.path, 'src/f1.ts'))).not.toStrictEqual(before.get('f1.ts'));
    });

    it('keeps untracked and ignored build state across updates', async () => {
      const a1 = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'v1\n'));
      const key = newKey();
      const pool = open();
      const slot = ran(await look(pool, await request(key, a1, baseSha))).value;
      write(slot.path, 'tsconfig.tsbuildinfo', '{"program":{}}');
      write(slot.path, '.turbo/cache/abc.tar.zst', 'cached');
      write(slot.path, 'dist/index.js', 'built');

      const a2 = commitOn('one', a1, () => write(dir, 'src/f1.ts', 'v2\n'));
      ran(await look(pool, await request(key, a2, baseSha)));
      const a3 = commitOn('one', a2, () => write(dir, 'src/f1.ts', 'v3\n'));
      ran(await look(pool, await request(key, a3, baseSha)));

      expect(readFileSync(join(slot.path, 'tsconfig.tsbuildinfo'), 'utf8')).toBe('{"program":{}}');
      expect(readFileSync(join(slot.path, '.turbo/cache/abc.tar.zst'), 'utf8')).toBe('cached');
      expect(readFileSync(join(slot.path, 'dist/index.js'), 'utf8')).toBe('built');
      expect(readFileSync(join(slot.path, 'src/f1.ts'), 'utf8')).toBe('v3\n');
    });

    it('writes a new slot in one process, not in a child of add', async () => {
      // A plain `add` checks out in a child process that keeps writing after
      // `add` is killed; with `--no-checkout` it writes nothing but `.git`,
      // and the reset the runner can kill writes the rest.
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'v1\n'));
      let afterAdd: string[] = [];
      const watching: GitRunner = {
        run: async (target, args, options) => {
          const result = await runner.run(target, args, options);
          if (args[0] === 'worktree' && args[1] === 'add') afterAdd = readdirSync(args.at(-2)!);
          return result;
        },
      };

      ran(await look(open({ runner: watching }), await request(newKey(), a, baseSha)));

      expect(afterAdd).toStrictEqual(['.git']);
    });

    it('keeps no reflog in a slot, so spent commits are not pinned', async () => {
      const a1 = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'v1\n'));
      const key = newKey();
      const pool = open();
      const slot = ran(await look(pool, await request(key, a1, baseSha))).value;
      const a2 = commitOn('one', a1, () => write(dir, 'src/f1.ts', 'v2\n'));
      ran(await look(pool, await request(key, a2, baseSha)));

      expect(existsSync(join(slot.repo.gitDir, 'logs'))).toBe(false);
    });

    it('updates by delta measurably faster than it fills, once settled', async () => {
      const a1 = commitOn('one', baseSha, () => {
        for (let i = 0; i < 1500; i++) write(dir, `many/m${String(i)}.txt`, `${String(i)}\n`);
      });
      const key = newKey();
      const pool = open();
      const cold = ran(await look(pool, await request(key, a1, baseSha)));
      // The first update after a fill re-reads every file written in the same
      // second as the index, which git cannot trust by timestamp; on a small
      // tree that is cheap, on a large one it is a second pass over the tree.
      // The claim is about the updates after it.
      const a2 = commitOn('one', a1, () => write(dir, 'many/m7.txt', 'changed\n'));
      ran(await look(pool, await request(key, a2, baseSha)));
      const a3 = commitOn('one', a2, () => write(dir, 'many/m8.txt', 'changed\n'));
      const delta = ran(await look(pool, await request(key, a3, baseSha)));

      expect(cold.fill).toBe('cold');
      expect(delta.fill).toBe('delta');
      expect(delta.fillMs).toBeLessThan(cold.fillMs);
    });

    it('leaves the slot usable when the check using it throws', async () => {
      const a1 = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'v1\n'));
      const key = newKey();
      const pool = open();
      const failed = pool.withSlot(await request(key, a1, baseSha), () =>
        Promise.reject(new Error('analyzer failed')),
      );
      await expect(failed).rejects.toThrow('analyzer failed');

      const a2 = commitOn('one', a1, () => write(dir, 'src/f1.ts', 'v2\n'));
      const again = ran(await look(pool, await request(key, a2, baseSha)));
      expect(again.fill).toBe('delta');
      expect(readFileSync(join(again.value.path, 'src/f1.ts'), 'utf8')).toBe('v2\n');
    });
  });

  describe('where slots live', () => {
    it('keeps the pool directories owner-only', async () => {
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', '1\n'));
      await look(open(), await request(newKey(), a, baseSha));

      expect(statSync(join(dataDir, 'worktrees')).mode & 0o777).toBe(0o700);
      expect(statSync(poolDir()).mode & 0o777).toBe(0o700);
    });

    it('refuses a data dir inside the checkout before creating anything', async () => {
      dataDir = join(dir, 'interlock-data');
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', '1\n'));
      const slotRequest = await request(newKey(), a, baseSha);
      let used = false;

      const error = await rejection(
        open().withSlot(slotRequest, () => {
          used = true;
          return Promise.resolve();
        }),
      );

      expect(error.code).toBe('SHADOW_UNAVAILABLE');
      expect(used).toBe(false);
      expect(existsSync(join(dataDir, 'worktrees'))).toBe(false);
    });

    it('refuses a pool directory that a symlink leads into the checkout', async () => {
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', '1\n'));
      const slotRequest = await request(newKey(), a, baseSha);
      mkdirSync(join(dir, 'inside'));
      symlinkSync(join(dir, 'inside'), join(dataDir, 'worktrees'));

      const error = await rejection(look(open(), slotRequest));

      expect(error.code).toBe('SHADOW_UNAVAILABLE');
      expect(readdirSync(join(dir, 'inside'))).toStrictEqual([]);
    });

    it('refuses a pool directory inside the main checkout of a linked worktree', async () => {
      // The shadow mirrors the linked worktree, so its origin names neither the
      // main checkout nor its git directory; the alternates file does.
      const linked = join(base, 'linked');
      git('worktree', 'add', '-q', '-b', 'linked', linked, baseSha);
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', '1\n'));
      dataDir = join(dir, 'data');
      shadow = await ensureShadow(
        { kind: 'user', rootPath: linked, gitDir: join(dir, '.git', 'worktrees', 'linked') },
        { runner, dataDir, repoId },
      );
      const merged = await speculativeMerge(
        { shadow, commitA: a, commitB: baseSha, mergeBaseSha: baseSha },
        { runner },
      );

      const error = await rejection(
        look(open(), {
          key: newKey(),
          commitA: a,
          commitB: baseSha,
          merged,
          dependencyTreeOid: treeOf(baseSha),
        }),
      );

      expect(error.code).toBe('SHADOW_UNAVAILABLE');
      expect(existsSync(join(dir, 'data', 'worktrees'))).toBe(false);
    });

    it('refuses a pool directory inside a git dir kept apart from the checkout', async () => {
      const separate = join(base, 'separate');
      const apart = join(base, 'apart.git');
      execFileSync('git', ['init', '-q', '-b', 'main', `--separate-git-dir=${apart}`, separate], {
        stdio: 'pipe',
      });
      gitIn(separate, 'config', 'user.name', 'Interlock Test');
      gitIn(separate, 'config', 'user.email', 'test@example.invalid');
      writeFileSync(join(separate, 'a.txt'), 'a\n');
      gitIn(separate, 'add', '-A');
      gitIn(separate, 'commit', '-qm', 'one');
      const sha = gitIn(separate, 'rev-parse', 'HEAD').trim();
      dataDir = join(apart, 'interlock-data');
      shadow = await ensureShadow(
        { kind: 'user', rootPath: separate, gitDir: apart },
        { runner, dataDir, repoId },
      );
      const merged = await speculativeMerge(
        { shadow, commitA: sha, commitB: sha, mergeBaseSha: sha },
        { runner },
      );
      const tree = gitIn(separate, 'rev-parse', 'HEAD^{tree}').trim();

      const error = await rejection(
        look(open(), {
          key: newKey(),
          commitA: sha,
          commitB: sha,
          merged,
          dependencyTreeOid: tree,
        }),
      );

      expect(error.code).toBe('SHADOW_UNAVAILABLE');
      expect(existsSync(join(dataDir, 'worktrees'))).toBe(false);
    });

    it('tries again after a failed start rather than keeping the failure', async () => {
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', '1\n'));
      const slotRequest = await request(newKey(), a, baseSha);
      writeFileSync(join(dataDir, 'worktrees'), 'not a directory');
      const pool = open();

      expect((await rejection(look(pool, slotRequest))).code).toBe('SHADOW_UNAVAILABLE');
      rmSync(join(dataDir, 'worktrees'));

      expect(ran(await look(pool, slotRequest)).fill).toBe('cold');
    });
  });

  describe('eviction', () => {
    it('gives up the least recently used slot, and says what it cost', async () => {
      const commits = ['one', 'two', 'three'].map((name, i) =>
        commitOn(name, baseSha, () => write(dir, `src/f${String(i)}.ts`, `${name}\n`)),
      );
      const keys = commits.map(() => newKey());
      const pool = open({ size: 2 });
      const first = ran(await look(pool, await request(keys[0]!, commits[0]!, baseSha))).value;
      const second = ran(await look(pool, await request(keys[1]!, commits[1]!, baseSha))).value;
      // Used again, so the second is now the oldest.
      await look(pool, await request(keys[0]!, commits[0]!, baseSha));

      const third = ran(await look(pool, await request(keys[2]!, commits[2]!, baseSha)));

      expect(third.evicted).toMatchObject({ key: keys[1], path: second.path });
      expect(third.evicted!.bytes).toBeGreaterThan(0);
      // Last used after it was filled, so idle for no longer than its build
      // state has existed — and that state is older than the fill that made it.
      expect(third.evicted!.buildStateAgeMs).toBeGreaterThan(0);
      expect(third.evicted!.idleMs).toBeGreaterThanOrEqual(0);
      expect(third.evicted!.idleMs).toBeLessThanOrEqual(third.evicted!.buildStateAgeMs);
      expect(existsSync(second.path)).toBe(false);
      expect(existsSync(first.path)).toBe(true);
      const logged = records.find((record) => record.msg === 'pool slot evicted');
      expect(logged).toMatchObject({ key: keys[1], bytes: third.evicted!.bytes });
      expect(logged).toHaveProperty('buildStateAgeMs');
      // Nothing of the evicted slot is left in the shadow's administration.
      expect(adminDirs()).toHaveLength(2);
      expect(adminDirs()).not.toContain(second.path.split('/').pop());
      const listed = gitIn(shadow.rootPath, 'worktree', 'list', '--porcelain');
      expect(listed).not.toContain(second.path);
    });

    it('can still evict a pair after checking it again', async () => {
      const one = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'one\n'));
      const two = commitOn('two', baseSha, () => write(dir, 'src/f2.ts', 'two\n'));
      const pool = open({ size: 1 });
      const hot = await request(newKey(), one, baseSha);
      await look(pool, hot);
      const slot = ran(await look(pool, hot)).value;

      const other = ran(await look(pool, await request(newKey(), two, baseSha)));

      expect(other.evicted?.path).toBe(slot.path);
    });

    it('evicts an idle slot rather than an older one in use', async () => {
      const commits = ['one', 'two', 'three'].map((name, i) =>
        commitOn(name, baseSha, () => write(dir, `src/f${String(i)}.ts`, `${name}\n`)),
      );
      const [busy, idle, incoming] = await Promise.all(
        commits.map((commit) => request(newKey(), commit, baseSha)),
      );
      const pool = open({ size: 2 });
      await look(pool, busy!);
      await look(pool, idle!);
      let evicted: SlotOutcome<PoolSlot> | undefined;

      const holding = pool.withSlot(busy!, async (slot) => {
        // Used after the busy slot was claimed, so the busy one is now the
        // least recently used — and still held.
        await look(pool, idle!);
        evicted = await look(pool, incoming!);
        return slot.path;
      });

      const busyPath = ran(await holding).value;
      expect(ran(evicted!).evicted?.key).toBe(idle!.key);
      expect(existsSync(busyPath)).toBe(true);
    });

    it('frees the place of a check whose slot never reached the disk', async () => {
      const one = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'one\n'));
      const two = commitOn('two', baseSha, () => write(dir, 'src/f2.ts', 'two\n'));
      let hollow = true;
      const flaky: GitRunner = {
        run: (target, args, options) =>
          hollow && args[0] === 'worktree' && args[1] === 'add'
            ? Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
            : runner.run(target, args, options),
      };
      const pool = open({ size: 1, runner: flaky });
      await rejection(look(pool, await request(newKey(), one, baseSha)));
      hollow = false;

      const next = ran(await look(pool, await request(newKey(), two, baseSha)));

      expect(next.evicted).toBeNull();
    });

    it('never evicts a slot a check is still using', async () => {
      const one = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'one\n'));
      const two = commitOn('two', baseSha, () => write(dir, 'src/f2.ts', 'two\n'));
      const { runner: watched, committed } = announcing();
      const pool = open({ size: 1, runner: watched });
      const firstRequest = await request(newKey(), one, baseSha);
      const secondRequest = await request(newKey(), two, baseSha);
      let secondStarted = false;
      let waiting: Promise<SlotOutcome<PoolSlot>> | undefined;

      const holding = pool.withSlot(firstRequest, async (slot) => {
        waiting = pool.withSlot(secondRequest, (other) => {
          secondStarted = true;
          return Promise.resolve(other);
        });
        // The second check has committed and reached the claim, with the only
        // slot held here.
        await committed(2);
        await settle();
        return { path: slot.path, intact: existsSync(join(slot.path, 'src/f1.ts')), secondStarted };
      });

      const first = ran(await holding).value;
      expect(first).toStrictEqual({ path: first.path, intact: true, secondStarted: false });
      const second = ran(await waiting!);
      expect(secondStarted).toBe(true);
      expect(second.evicted?.path).toBe(first.path);
      expect(existsSync(first.path)).toBe(false);
    });

    it('trims slots a larger pool left behind, keeping the most recently used', async () => {
      const commits = ['one', 'two'].map((name, i) =>
        commitOn(name, baseSha, () => write(dir, `src/f${String(i)}.ts`, `${name}\n`)),
      );
      const keys = commits.map(() => newKey());
      const wide = open({ size: 2 });
      const earlier = ran(await look(wide, await request(keys[0]!, commits[0]!, baseSha))).value;
      const later = ran(await look(wide, await request(keys[1]!, commits[1]!, baseSha))).value;
      // Recency survives a restart only through the disk. The slot filled
      // later is made the one used least recently, so an order read from
      // creation rather than from use keeps the wrong one.
      execFileSync('touch', ['-t', '202001010000', join(later.repo.gitDir, 'index')]);

      const narrow = open({ size: 1 });
      const again = ran(await look(narrow, await request(keys[0]!, commits[0]!, baseSha)));

      expect(again.fill).toBe('delta');
      expect(existsSync(later.path)).toBe(false);
      expect(existsSync(earlier.path)).toBe(true);
      expect(adminDirs()).toHaveLength(1);
    });
  });

  describe('surviving a restart', () => {
    it('adopts the slots a previous pool left, build state and all', async () => {
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'v1\n'));
      const key = newKey();
      const slot = ran(await look(open(), await request(key, a, baseSha))).value;
      write(slot.path, 'tsconfig.tsbuildinfo', 'state');

      const again = ran(await look(open(), await request(key, a, baseSha)));

      expect(again.fill).toBe('delta');
      expect(again.value.path).toBe(slot.path);
      expect(readFileSync(join(slot.path, 'tsconfig.tsbuildinfo'), 'utf8')).toBe('state');
    });

    it('forgets a slot whose directory was removed by hand', async () => {
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'v1\n'));
      const gone = ran(await look(open(), await request(newKey(), a, baseSha))).value;
      rmSync(gone.path, { recursive: true, force: true });

      await look(open(), await request(newKey(), a, baseSha));

      expect(adminDirs()).not.toContain(gone.path.split('/').pop());
      expect(adminDirs()).toHaveLength(1);
    });

    it('forgets a registration an interrupted add left without a checkout', async () => {
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'v1\n'));
      const gone = ran(await look(open(), await request(newKey(), a, baseSha))).value;
      rmSync(gone.path, { recursive: true, force: true });
      rmSync(join(gone.repo.gitDir, 'gitdir'));

      await look(open(), await request(newKey(), a, baseSha));

      expect(adminDirs()).not.toContain(gone.path.split('/').pop());
    });

    it('opens once, however many checks it serves', async () => {
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'v1\n'));
      const pool = open();
      const slotRequest = await request(newKey(), a, baseSha);
      await look(pool, slotRequest);
      // Opening clears anything in the pool directory that is not a slot, so
      // a stray that survives a second check is proof it did not open again.
      writeFileSync(join(poolDir(), 'stray'), 'x');

      await look(pool, slotRequest);

      expect(readdirSync(poolDir())).toContain('stray');
    });

    it('leaves a worktree of the shadow that is not a slot alone', async () => {
      // Orphaned registrations are removed by name, not by `worktree prune`,
      // which would reconcile every worktree the shadow has.
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'v1\n'));
      await refresh();
      gitIn(shadow.rootPath, 'worktree', 'add', '--detach', join(base, 'elsewhere'), baseSha);
      rmSync(join(base, 'elsewhere'), { recursive: true, force: true });

      await look(open(), await request(newKey(), a, baseSha));

      expect(adminDirs()).toContain('elsewhere');
    });

    it('leaves a slot-shaped worktree of the shadow outside the pool alone', async () => {
      // git names a registration after its checkout's basename, so a
      // worktree elsewhere can carry a name the pool would give a slot.
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'v1\n'));
      await refresh();
      const name = `${ulid()}-${ulid()}`;
      gitIn(shadow.rootPath, 'worktree', 'add', '--detach', join(base, name), baseSha);

      await look(open(), await request(newKey(), a, baseSha));

      expect(adminDirs()).toContain(name);
    });

    it('refills a slot whose shadow was rebuilt from under it', async () => {
      // A rebuild deletes the shadow, and with it every slot's registration,
      // so a slot cannot outlive it: the checkout points at nothing, is
      // discarded and filled again from the new shadow.
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'v1\n'));
      const key = newKey();
      const first = ran(await look(open(), await request(key, a, baseSha)));
      expect(first.fill).toBe('cold');
      rmSync(shadow.rootPath, { recursive: true, force: true });
      await refresh();

      const again = ran(await look(open(), await request(key, a, baseSha)));

      expect(again.fill).toBe('cold');
      expect(readFileSync(join(again.value.path, 'src', 'f1.ts'), 'utf8')).toBe('v1\n');
      expect(adminDirs()).toEqual([again.value.path.split('/').pop()]);
    });

    it('clears out anything in the pool directory that is not a slot', async () => {
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'v1\n'));
      const slotRequest = await request(newKey(), a, baseSha);
      mkdirSync(join(poolDir(), 'stray'), { recursive: true });
      writeFileSync(join(poolDir(), 'stray', 'file'), 'x');
      writeFileSync(join(poolDir(), '.DS_Store'), 'x');

      ran(await look(open(), slotRequest));

      expect(readdirSync(poolDir())).toHaveLength(1);
    });
  });

  describe('recovery', () => {
    /** A pair whose two states differ in thousands of files, so a reset takes long enough to kill. */
    const heavyPair = async (): Promise<{
      key: MergePairKey;
      pool: WorktreePool;
      slot: PoolSlot;
      next: SlotRequest;
    }> => {
      const a1 = commitOn('one', baseSha, () => {
        for (let i = 0; i < 2000; i++) write(dir, `bulk/b${String(i)}.txt`, `v1 ${String(i)}\n`);
      });
      const key = newKey();
      const pool = open();
      const slot = ran(await look(pool, await request(key, a1, baseSha))).value;
      write(slot.path, 'tsconfig.tsbuildinfo', 'state');
      const a2 = commitOn('one', a1, () => {
        for (let i = 0; i < 2000; i++) write(dir, `bulk/b${String(i)}.txt`, `v2 ${String(i)}\n`);
      });
      return { key, pool, slot, next: await request(key, a2, baseSha) };
    };

    const assertRepaired = (slot: PoolSlot, outcome: SlotOutcome<PoolSlot>): void => {
      const repaired = ran(outcome);
      expect(repaired.fill).toBe('delta');
      expect(gitIn(slot.path, 'rev-parse', 'HEAD').trim()).toBe(repaired.value.commitSha);
      expect(gitIn(slot.path, 'status', '--porcelain', '--untracked-files=no')).toBe('');
      expect(readFileSync(join(slot.path, 'bulk/b1999.txt'), 'utf8')).toBe('v2 1999\n');
      expect(readFileSync(join(slot.path, 'tsconfig.tsbuildinfo'), 'utf8')).toBe('state');
    };

    it('repairs a slot whose reset was killed outright, lock and all', async () => {
      const { pool, slot, next } = await heavyPair();
      const target = gitIn(
        shadow.rootPath,
        'commit-tree',
        '-p',
        next.commitA,
        '-m',
        'x',
        next.merged.treeOid,
      ).trim();
      const lock = join(slot.repo.gitDir, 'index.lock');

      const child = spawn('git', ['-C', slot.path, 'reset', '--hard', '--quiet', target], {
        stdio: 'ignore',
      });
      let exited = false;
      child.on('exit', () => {
        exited = true;
      });
      while (!existsSync(lock)) {
        if (exited) throw new Error('the reset finished before it could be killed');
        await new Promise((resolve) => setImmediate(resolve));
      }
      child.kill('SIGKILL');
      await new Promise((resolve) => child.on('exit', resolve));
      expect(existsSync(lock)).toBe(true);
      // `reset` locks `HEAD` too, and a kill between the two leaves that one.
      writeFileSync(join(slot.repo.gitDir, 'HEAD.lock'), '');

      assertRepaired(slot, await look(pool, next));
      expect(existsSync(join(slot.repo.gitDir, 'HEAD.lock'))).toBe(false);
      expect(existsSync(lock)).toBe(false);
      expect(records.some((record) => record.msg === 'stale lock removed from pool slot')).toBe(
        true,
      );
    });

    it('repairs a slot half-written by a reset the runner timed out', async () => {
      const { key, slot, next } = await heavyPair();
      const impatient: GitRunner = {
        run: (target, args, options) =>
          runner.run(target, args, args[0] === 'reset' ? { ...options, timeoutMs: 15 } : options),
      };

      const error = await rejection(look(open({ runner: impatient }), next));
      expect(error.message).toContain('did not finish');

      assertRepaired(slot, await look(open(), next));
      expect(key).toBe(next.key);
    });

    it('fills again a slot whose administrative directory is gone', async () => {
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'v1\n'));
      const key = newKey();
      const pool = open();
      const slot = ran(await look(pool, await request(key, a, baseSha))).value;
      rmSync(slot.repo.gitDir, { recursive: true, force: true });

      const again = ran(await look(pool, await request(key, a, baseSha)));

      expect(again.fill).toBe('cold');
      expect(gitIn(slot.path, 'rev-parse', 'HEAD').trim()).toBe(again.value.commitSha);
      expect(adminDirs()).toHaveLength(1);
    });

    it('fills again a slot git and the pool disagree about', async () => {
      const corruptions: [string, (slot: PoolSlot) => void][] = [
        [
          'a checkout naming another git dir',
          (slot) => writeFileSync(join(slot.path, '.git'), `gitdir: ${join(base, 'elsewhere')}\n`),
        ],
        [
          'an administrative dir naming another checkout',
          (slot) =>
            writeFileSync(join(slot.repo.gitDir, 'gitdir'), `${join(base, 'elsewhere', '.git')}\n`),
        ],
        ['an administrative dir with no HEAD', (slot) => rmSync(join(slot.repo.gitDir, 'HEAD'))],
      ];
      mkdirSync(join(base, 'elsewhere'));
      for (const [label, corrupt] of corruptions) {
        const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', `${label}\n`));
        const key = newKey();
        const pool = open();
        const slot = ran(await look(pool, await request(key, a, baseSha))).value;
        corrupt(slot);

        const again = ran(await look(pool, await request(key, a, baseSha)));

        expect(again.fill, label).toBe('cold');
        expect(gitIn(slot.path, 'status', '--porcelain'), label).toBe('');
      }
    });

    it('fills again a slot whose add was interrupted', async () => {
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'v1\n'));
      const key = newKey();
      const pool = open();
      const slot = ran(await look(pool, await request(key, a, baseSha))).value;
      // What `worktree add` leaves when it dies before finishing, and what
      // makes `worktree remove` refuse without a second `--force`.
      writeFileSync(join(slot.repo.gitDir, 'locked'), 'initializing');

      const again = ran(await look(pool, await request(key, a, baseSha)));

      expect(again.fill).toBe('cold');
      expect(existsSync(join(slot.repo.gitDir, 'locked'))).toBe(false);
      expect(gitIn(slot.path, 'status', '--porcelain')).toBe('');
    });
  });

  describe('dependencies', () => {
    it('skips a pair whose merged tree changes a manifest, touching no slot', async () => {
      const held = commitOn('held', baseSha, () => write(dir, 'src/f9.ts', 'held\n'));
      const one = commitOn('one', baseSha, () => {
        write(dir, 'package.json', '{"name":"fixture","dependencies":{"left-pad":"1"}}\n');
        write(dir, 'packages/inner/pnpm-lock.yaml', 'lockfileVersion: 9\n');
      });
      const two = commitOn('two', baseSha, () => write(dir, 'src/f2.ts', 'two\n'));
      const pool = open({ size: 1 });
      const heldSlot = ran(await look(pool, await request(newKey(), held, baseSha))).value;
      let used = false;

      const outcome = await pool.withSlot(await request(newKey(), one, two), () => {
        used = true;
        return Promise.resolve();
      });

      expect(outcome).toStrictEqual({
        kind: 'skipped',
        reason: 'deps-dirty',
        paths: ['package.json', 'packages/inner/pnpm-lock.yaml'],
      });
      expect(used).toBe(false);
      expect(existsSync(heldSlot.path)).toBe(true);
      expect(readdirSync(poolDir())).toHaveLength(1);
    });

    it('checks a pair whose merged manifests match the installed checkout', async () => {
      // The dependency was added in the checkout it was installed from, and
      // the other side never touched a manifest: the merged tree agrees with
      // what is installed, so the pair is checkable.
      const one = commitOn('one', baseSha, () =>
        write(dir, 'package.json', '{"name":"fixture","dependencies":{"left-pad":"1"}}\n'),
      );
      const two = commitOn('two', baseSha, () => write(dir, 'src/f2.ts', 'two\n'));

      const outcome = await look(open(), await request(newKey(), one, two, treeOf(one)));

      expect(ran(outcome).fill).toBe('cold');
    });

    it('does not mistake a file that merely contains a manifest name for one', async () => {
      const one = commitOn('one', baseSha, () => write(dir, 'docs/package.json.md', 'about\n'));

      const outcome = await look(open(), await request(newKey(), one, baseSha));

      expect(outcome.kind).toBe('ran');
    });

    it('counts every file that changes what an install resolves, at any depth', async () => {
      // Each name on its own commit, nested, against the base: a set missing
      // one lets a pair be typechecked against the wrong dependency tree.
      const names = [...DEPENDENCY_FILES].sort();
      // Branches by index: git refuses a branch name ending in `.lock`.
      const commits = names.map((name, index) =>
        commitOn(`dep-${String(index)}`, baseSha, () =>
          write(dir, `packages/inner/${name}`, 'x\n'),
        ),
      );
      await refresh();

      for (const [index, name] of names.entries()) {
        const drift = await dependencyDrift(
          shadow,
          runner,
          treeOf(baseSha),
          treeOf(commits[index]!),
        );
        expect(drift, name).toEqual([`packages/inner/${name}`]);
      }
      expect(names).toEqual(expect.arrayContaining(['.yarnrc', 'bunfig.toml']));
    });

    it('calls a dependency tree the shadow cannot read stale', async () => {
      await refresh();
      const missing = '0123456789abcdef0123456789abcdef01234567';

      const error = await rejection(dependencyDrift(shadow, runner, missing, treeOf(baseSha)));

      expect(error.code).toBe('SNAPSHOT_STALE');
    });
  });

  describe('concurrency', () => {
    it('runs two checks of one pair one after the other', async () => {
      const a1 = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'v1\n'));
      const a2 = commitOn('one', a1, () => write(dir, 'src/f1.ts', 'v2\n'));
      const key = newKey();
      const { runner: watched, committed } = announcing();
      const pool = open({ runner: watched });
      const [first, second] = [await request(key, a1, baseSha), await request(key, a2, baseSha)];
      const events: string[] = [];
      const check = (label: string, expected: string) => async (slot: PoolSlot) => {
        events.push(`${label} in`);
        const seen = readFileSync(join(slot.path, 'src/f1.ts'), 'utf8');
        // Both checks have committed and are at the slot or in it, so without
        // the lock the other would be inside by now.
        await committed(2);
        await settle();
        const still = readFileSync(join(slot.path, 'src/f1.ts'), 'utf8');
        events.push(`${label} out`);
        return seen === expected && still === expected;
      };

      const outcomes = await Promise.all([
        pool.withSlot(first, check('first', 'v1\n')),
        pool.withSlot(second, check('second', 'v2\n')),
      ]);

      expect(outcomes.map((outcome) => ran(outcome).value)).toStrictEqual([true, true]);
      // Whichever claimed first, neither entered while the other was inside.
      expect(events.map((event) => event.split(' ')[1])).toStrictEqual(['in', 'out', 'in', 'out']);
      expect(events[0]!.split(' ')[0]).toBe(events[1]!.split(' ')[0]);
      expect(adminDirs()).toHaveLength(1);
    });

    it('gives distinct pairs distinct slots when checked at once', async () => {
      const one = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'one\n'));
      const two = commitOn('two', baseSha, () => write(dir, 'src/f2.ts', 'two\n'));
      const pool = open({ size: 2 });
      const requests = [
        await request(newKey(), one, baseSha),
        await request(newKey(), two, baseSha),
      ];

      const outcomes = await Promise.all(requests.map((slotRequest) => look(pool, slotRequest)));

      const paths = outcomes.map((outcome) => ran(outcome).value.path);
      expect(new Set(paths).size).toBe(2);
      expect(outcomes.every((outcome) => ran(outcome).evicted === null)).toBe(true);
      expect(adminDirs()).toHaveLength(2);
    });
  });

  describe('refusals', () => {
    it('refuses a conflicted merge', async () => {
      const one = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'one\n'));
      const two = commitOn('two', baseSha, () => write(dir, 'src/f1.ts', 'two\n'));
      await refresh();
      const merged = await speculativeMerge(
        { shadow, commitA: one, commitB: two, mergeBaseSha: baseSha },
        { runner },
      );
      expect(merged.clean).toBe(false);

      const error = await rejection(
        look(open(), {
          key: newKey(),
          commitA: one,
          commitB: two,
          merged,
          dependencyTreeOid: treeOf(baseSha),
        }),
      );

      expect(error.code).toBe('GIT_COMMAND_REFUSED');
      expect(existsSync(poolDir())).toBe(false);
    });

    it('refuses a key that is not a pair key, which would become a path', async () => {
      const one = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'one\n'));
      const slotRequest = await request(newKey(), one, baseSha);

      const error = await rejection(
        look(open(), { ...slotRequest, key: '../../escape' as MergePairKey }),
      );

      expect(error.code).toBe('GIT_COMMAND_REFUSED');
      expect(existsSync(poolDir())).toBe(false);
    });

    it('refuses an id that is not an object id before creating anything', async () => {
      const one = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'one\n'));
      const slotRequest = await request(newKey(), one, baseSha);
      const flag = '--output=/tmp/x';
      const malformed: SlotRequest[] = [
        { ...slotRequest, commitA: flag },
        { ...slotRequest, commitB: flag },
        { ...slotRequest, dependencyTreeOid: flag },
        { ...slotRequest, merged: { ...slotRequest.merged, treeOid: flag } },
      ];

      for (const bad of malformed) {
        expect((await rejection(look(open(), bad))).code).toBe('GIT_COMMAND_REFUSED');
      }
      expect(existsSync(poolDir())).toBe(false);
      expect((await rejection(dependencyDrift(shadow, runner, flag, treeOf(baseSha)))).code).toBe(
        'GIT_COMMAND_REFUSED',
      );
    });

    it('will only open over the shadow ensureShadow put at this data dir', async () => {
      const one = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'one\n'));
      const slot = ran(await look(open(), await request(newKey(), one, baseSha))).value;

      const asShadow = (): WorktreePool =>
        createWorktreePool(slot.repo, { runner, dataDir, repoId });
      const elsewhere = (): WorktreePool =>
        createWorktreePool(shadow, { runner, dataDir: join(base, 'other'), repoId });
      const forged = (): WorktreePool =>
        createWorktreePool({ ...shadow, kind: 'user' } as unknown as ShadowRepo, {
          runner,
          dataDir,
          repoId,
        });

      const notBare = (): WorktreePool =>
        createWorktreePool(
          { ...shadow, gitDir: join(shadow.gitDir, 'worktrees', 'x') },
          { runner, dataDir, repoId },
        );

      for (const attempt of [asShadow, elsewhere, forged, notBare]) {
        expect(attempt).toThrow(expect.objectContaining({ code: 'GIT_COMMAND_REFUSED' }));
      }
    });

    it('refuses a repository id that is not a ULID, before it becomes a path', async () => {
      // A path-safe id that is not a ULID, with a real shadow made for it, so
      // the id is the only thing wrong. `..` is what this stops: the pool
      // would be the data dir itself, cleared of everything that is not a slot.
      const odd = 'not-a-ulid' as RepoId;
      const oddShadow = await ensureShadow(
        { kind: 'user', rootPath: dir, gitDir: join(dir, '.git') },
        { runner, dataDir, repoId: odd },
      );

      expect(() => createWorktreePool(oddShadow, { runner, dataDir, repoId: odd })).toThrow(
        expect.objectContaining({ code: 'GIT_COMMAND_REFUSED' }),
      );
    });

    it('does not take git at its word when an add registers no slot', async () => {
      const one = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', 'one\n'));
      const slotRequest = await request(newKey(), one, baseSha);
      // A git answering success for an `add` that left nothing behind would
      // otherwise send every later check back through a cold fill, unseen.
      const hollow: GitRunner = {
        run: (target, args, options) =>
          args[0] === 'worktree' && args[1] === 'add'
            ? Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
            : runner.run(target, args, options),
      };

      const error = await rejection(look(open({ runner: hollow }), slotRequest));

      expect(error.code).toBe('SHADOW_UNAVAILABLE');
      expect(error.infra).toBe(true);
    });

    it('still protects the checkout when the shadow names no store it borrows', async () => {
      dataDir = join(dir, 'interlock-data');
      const a = commitOn('one', baseSha, () => write(dir, 'src/f1.ts', '1\n'));
      const slotRequest = await request(newKey(), a, baseSha);
      rmSync(join(shadow.gitDir, 'objects', 'info', 'alternates'));

      const error = await rejection(look(open(), slotRequest));

      expect(error.code).toBe('SHADOW_UNAVAILABLE');
      expect(existsSync(join(dataDir, 'worktrees'))).toBe(false);
    });

    it('refuses a pool with no room in it', async () => {
      await refresh();
      for (const size of [0, 1.5, -1]) {
        expect(() => open({ size })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
      }
    });
  });
});
