import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePairKey, ulid } from '@interlock/shared';
import type { BranchRefId, RepoId } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitRunner } from '../src/git/repo-handle.js';
import type { GitResult, GitRunner, ShadowRepo, UserRepo } from '../src/git/repo-handle.js';
import { collectShadow, ensureShadow, KEEP_REFS_PREFIX } from '../src/git/shadow.js';
import { createWorktreePool } from '../src/git/worktree-pool.js';
import { captureDirtyState, commitSnapshotInShadow } from '../src/git/worktree.js';
import { speculativeMerge } from '../src/merge/speculative-merge.js';
import { rejection } from './support/rejection.js';

/**
 * Collection, against a real repository and its real shadow.
 *
 * Every case ages objects on disk rather than waiting: `prune` decides by each
 * loose object's mtime, so setting it is the same thing as a day passing. What
 * is asserted is what the shadow can still read afterwards, never the report
 * alone.
 */
describe('collectShadow', () => {
  let base: string;
  let dir: string;
  let dataDir: string;
  let repo: UserRepo;
  let shadow: ShadowRepo;
  const repoId = ulid<RepoId>();
  const runner = createGitRunner();
  const HOUR = 60 * 60_000;

  const gitIn = (where: string, ...args: string[]): string =>
    execFileSync('git', ['-C', where, ...args], { stdio: 'pipe', encoding: 'utf8' });
  const git = (...args: string[]): string => gitIn(dir, ...args);
  const head = (): string => git('rev-parse', 'HEAD').trim();

  const write = (path: string, content: string): void => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  };

  /** A commit on its own branch off `main`, leaving `main` checked out. */
  const commitOn = (name: string, path: string, content: string): string => {
    git('checkout', '-q', '-B', name, 'main');
    write(path, content);
    git('add', '-A');
    git('commit', '-qm', name);
    const sha = head();
    git('checkout', '-q', 'main');
    return sha;
  };

  const refresh = async (): Promise<ShadowRepo> => {
    shadow = await ensureShadow(repo, { runner, dataDir, repoId });
    return shadow;
  };

  /** Whether the shadow can read an object, from its own store or the user's. */
  const readable = (oid: string): boolean => {
    try {
      gitIn(shadow.rootPath, 'cat-file', '-e', oid);
      return true;
    } catch {
      return false;
    }
  };

  /** Every loose object file in a store, by path. */
  const looseFiles = (objectsDir: string): string[] =>
    readdirSync(objectsDir)
      .filter((name) => /^[0-9a-f]{2}$/u.test(name))
      .flatMap((name) =>
        readdirSync(join(objectsDir, name)).map((file) => join(objectsDir, name, file)),
      );

  /** Everything the shadow wrote so far, last written `ms` ago. */
  const age = (ms: number): void => {
    const at = new Date(Date.now() - ms);
    for (const file of looseFiles(join(shadow.gitDir, 'objects'))) utimesSync(file, at, at);
  };

  /**
   * Every pack the shadow holds, last written `ms` ago. A cruft pack records
   * each object's own time, so this ages only what a pack's time speaks for:
   * objects that were reachable when it was written.
   */
  const agePacks = (ms: number): void => {
    const pack = join(shadow.gitDir, 'objects', 'pack');
    const at = new Date(Date.now() - ms);
    for (const file of readdirSync(pack)) utimesSync(join(pack, file), at, at);
  };

  /** Uncommitted work in the main checkout, captured into the shadow and committed there. */
  const snapshot = async (content: string): Promise<{ commitSha: string; treeOid: string }> => {
    write('a.txt', content);
    const captured = await captureDirtyState(dir, repo, { runner, objectStore: shadow });
    git('checkout', '-q', '--', 'a.txt');
    return commitSnapshotInShadow(shadow, captured, { runner });
  };

  const keepRefs = (): string[] =>
    gitIn(shadow.rootPath, 'for-each-ref', '--format=%(refname)', KEEP_REFS_PREFIX)
      .split('\n')
      .filter(Boolean);

  const anHourAgo = (): Date => new Date(Date.now() - HOUR);
  const twoHoursAgo = (): Date => new Date(Date.now() - 2 * HOUR);

  beforeEach(async () => {
    // git answers with fully-resolved paths, and on macOS /var is a symlink to
    // /private/var, so the fixture works in canonical form throughout.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-collect-')));
    dir = join(base, 'user');
    dataDir = join(base, 'data');
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
    git('config', 'user.name', 'Interlock Test');
    git('config', 'user.email', 'test@example.invalid');
    // Since git 2.47 `commit` detaches a maintenance process that holds
    // `objects/maintenance.lock` after the commit returns.
    git('config', 'maintenance.auto', 'false');
    git('config', 'gc.auto', '0');
    write('a.txt', 'one\n');
    write('package.json', '{"name":"fixture"}\n');
    git('add', '-A');
    git('commit', '-qm', 'one');
    repo = { kind: 'user', rootPath: dir, gitDir: join(dir, '.git') };
    await refresh();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('removes a spent snapshot older than the expiry and keeps a capture made since', async () => {
    const spent = await snapshot('spent\n');
    age(2 * HOUR);
    const fresh = await snapshot('fresh\n');

    const report = await collectShadow(shadow, { runner, expireBefore: anHourAgo(), keep: [] });

    expect(readable(spent.commitSha)).toBe(false);
    expect(readable(spent.treeOid)).toBe(false);
    expect(readable(fresh.commitSha)).toBe(true);
    expect(readable(fresh.treeOid)).toBe(true);
    // Each snapshot is a commit, its tree and the blob of the edited file:
    // the spent one gone, the fresh one packed, and nothing left loose.
    expect(report.before).toMatchObject({ loose: 6, packed: 0 });
    expect(report.after).toMatchObject({ loose: 0, packed: 3 });
  });

  it('packs only its own objects, never one borrowed from the user', async () => {
    commitOn('side', 'side.txt', 'side\n');
    await refresh();
    await snapshot('own\n');

    const report = await collectShadow(shadow, { runner, expireBefore: anHourAgo(), keep: [] });

    // Without `-l` the repack would copy in every object the user's history
    // reaches: the shadow would hold its own copy of the repository.
    expect(report.after.packed).toBe(3);
  });

  it('ages out an object once packed, on a later pass', async () => {
    const spent = await snapshot('spent\n');
    // Packed at an age inside the first expiry and past the second: the cruft
    // pack records each object's own time, which is all that can age it now.
    age(90 * 60_000);
    await collectShadow(shadow, { runner, expireBefore: twoHoursAgo(), keep: [] });
    expect(readable(spent.commitSha)).toBe(true);

    const report = await collectShadow(shadow, { runner, expireBefore: anHourAgo(), keep: [] });

    expect(readable(spent.commitSha)).toBe(false);
    expect(report.before).toMatchObject({ loose: 0, packed: 3 });
    expect(report.after).toMatchObject({ loose: 0, packed: 0 });
  });

  it('keeps an old packed object written again since', async () => {
    // A capture of content seen long ago — an edit reverted — writes objects
    // that exist only in the cruft pack. git leaves a fresh loose copy, and a
    // prune ahead of the repack would delete it for being packed.
    const reverted = await snapshot('reverted\n');
    age(90 * 60_000);
    await collectShadow(shadow, { runner, expireBefore: twoHoursAgo(), keep: [] });
    write('a.txt', 'reverted\n');
    const again = await captureDirtyState(dir, repo, { runner, objectStore: shadow });
    git('checkout', '-q', '--', 'a.txt');
    expect(again.treeOid).toBe(reverted.treeOid);

    await collectShadow(shadow, { runner, expireBefore: anHourAgo(), keep: [] });

    expect(readable(reverted.treeOid)).toBe(true);
    expect(readable(`${reverted.treeOid}:a.txt`)).toBe(true);
    expect(readable(reverted.commitSha)).toBe(false);
  });

  it('keeps an old tree a commit made since still names', async () => {
    // A snapshot commit made afresh for a tree captured long ago — an idle
    // branch's — is what a recent verdict names, and it is all that holds the
    // tree: prune keeps what a recent object reaches.
    write('a.txt', 'idle\n');
    const captured = await captureDirtyState(dir, repo, { runner, objectStore: shadow });
    git('checkout', '-q', '--', 'a.txt');
    age(30 * 24 * HOUR);
    const recent = await commitSnapshotInShadow(shadow, captured, { runner });

    await collectShadow(shadow, { runner, expireBefore: anHourAgo(), keep: [] });

    expect(readable(recent.commitSha)).toBe(true);
    expect(readable(captured.treeOid)).toBe(true);
  });

  it('keeps a kept commit and everything it reaches however old, and a kept tree', async () => {
    const commit = await snapshot('kept commit\n');
    const tree = (await snapshot('kept tree\n')).treeOid;
    const dropped = await snapshot('dropped\n');
    age(30 * 24 * HOUR);

    const report = await collectShadow(shadow, {
      runner,
      expireBefore: anHourAgo(),
      keep: [commit.commitSha, tree, commit.commitSha],
    });

    expect(readable(commit.commitSha)).toBe(true);
    expect(readable(commit.treeOid)).toBe(true);
    expect(readable(tree)).toBe(true);
    expect(readable(dropped.commitSha)).toBe(false);
    expect(report).toMatchObject({ kept: 2, unkeepable: [] });
    expect(keepRefs().sort()).toEqual(
      [commit.commitSha, tree].map((oid) => `${KEEP_REFS_PREFIX}${oid}`).sort(),
    );
  });

  it('rewrites the keep refs each pass, so an object no longer kept is collected', async () => {
    const once = await snapshot('once kept\n');
    await collectShadow(shadow, { runner, expireBefore: anHourAgo(), keep: [once.commitSha] });
    // Kept, it was packed with everything reachable, and once released it is
    // aged from that pack's time: the last pass that kept it.
    agePacks(2 * HOUR);

    await collectShadow(shadow, { runner, expireBefore: anHourAgo(), keep: [] });

    expect(keepRefs()).toEqual([]);
    expect(readable(once.commitSha)).toBe(false);
  });

  it('gives an object released since the last pass a full expiry from then', async () => {
    const once = await snapshot('once kept\n');
    await collectShadow(shadow, { runner, expireBefore: anHourAgo(), keep: [once.commitSha] });
    agePacks(30 * 60_000);

    await collectShadow(shadow, { runner, expireBefore: anHourAgo(), keep: [] });

    expect(readable(once.commitSha)).toBe(true);
  });

  it("keeps a pool slot's current commit and collects the one it replaced", async () => {
    const baseTree = git('rev-parse', 'HEAD^{tree}').trim();
    const a1 = commitOn('a1', 'b.txt', 'a one\n');
    const a2 = commitOn('a2', 'b.txt', 'a two\n');
    const b = commitOn('b', 'c.txt', 'b\n');
    await refresh();
    const pool = createWorktreePool(shadow, { runner, dataDir, repoId });
    const key = makePairKey(ulid<BranchRefId>(), ulid<BranchRefId>());
    const check = async (commitA: string): Promise<string> => {
      const mergeBaseSha = git('merge-base', commitA, b).trim();
      const merged = await speculativeMerge(
        { shadow, commitA, commitB: b, mergeBaseSha },
        { runner },
      );
      const outcome = await pool.withSlot(
        { key, commitA, commitB: b, merged, dependencyTreeOid: baseTree },
        (slot) => Promise.resolve(slot.commitSha),
      );
      if (outcome.kind !== 'ran') throw new Error(`expected a run, got ${outcome.kind}`);
      return outcome.value;
    };
    const previous = await check(a1);
    const current = await check(a2);
    age(2 * HOUR);

    await collectShadow(shadow, { runner, expireBefore: anHourAgo(), keep: [] });

    expect(readable(current)).toBe(true);
    expect(readable(previous)).toBe(false);
  });

  describe('when the user collects what a shadow names', () => {
    /** A snapshot on a branch the user then deletes and collects out from under it. */
    const orphaned = async (): Promise<string> => {
      git('checkout', '-q', '-b', 'feature');
      write('f.txt', 'only on feature\n');
      git('add', '-A');
      git('commit', '-qm', 'feature');
      await refresh();
      const kept = await snapshot('on feature\n');
      git('checkout', '-q', 'main');
      git('branch', '-D', 'feature');
      git('reflog', 'expire', '--expire=now', '--all');
      git('gc', '-q', '--prune=now');
      return kept.commitSha;
    };

    it('fails on a shadow not refreshed since, which is why a refresh comes first', async () => {
      await orphaned();

      const error = await rejection(
        collectShadow(shadow, { runner, expireBefore: anHourAgo(), keep: [] }),
      );

      expect(error.code).toBe('GIT_COMMAND_FAILED');
    });

    it('collects once refreshed, leaving out a kept commit whose parent is gone', async () => {
      const kept = await orphaned();
      const other = await snapshot('still whole\n');
      await refresh();

      const report = await collectShadow(shadow, {
        runner,
        expireBefore: anHourAgo(),
        keep: [kept, other.commitSha],
      });

      expect(report).toMatchObject({ kept: 1, unkeepable: [kept] });
      expect(keepRefs()).toEqual([`${KEEP_REFS_PREFIX}${other.commitSha}`]);
    });

    it('drops a keep ref an earlier pass left naming an object since lost', async () => {
      await refresh();
      // Refs are files: the one an earlier pass wrote, for an object now gone.
      const lost = 'dead'.repeat(10);
      const refDir = join(shadow.gitDir, ...KEEP_REFS_PREFIX.split('/').filter(Boolean));
      mkdirSync(refDir, { recursive: true });
      writeFileSync(join(refDir, lost), `${lost}\n`);

      const report = await collectShadow(shadow, { runner, expireBefore: anHourAgo(), keep: [] });

      expect(report.kept).toBe(0);
      expect(existsSync(join(refDir, lost))).toBe(false);
    });
  });

  it("leaves the user's object store exactly as it was", async () => {
    await snapshot('two\n');
    commitOn('side', 'side.txt', 'side\n');
    git('branch', '-D', 'side');
    git('reflog', 'expire', '--expire=now', '--all');
    const userObjects = join(dir, '.git', 'objects');
    // The user's own unreachable objects, old enough for any `prune` to take.
    const past = new Date(Date.now() - 30 * 24 * HOUR);
    for (const file of looseFiles(userObjects)) utimesSync(file, past, past);
    const before = looseFiles(userObjects).sort();
    age(2 * HOUR);

    await collectShadow(shadow, { runner, expireBefore: new Date(Date.now() + HOUR), keep: [] });

    expect(looseFiles(userObjects).sort()).toEqual(before);
  });

  it('stops at its signal, prune included, and the next collection finishes the job', async () => {
    const spent = await snapshot('spent\n');
    age(2 * HOUR);
    const controller = new AbortController();
    const stopping: GitRunner = {
      run: (target, args, options) => {
        // Aborted as prune is asked for, so the signal reaches that command:
        // the runner's own tests show one already running is killed.
        if (args[0] === 'prune') controller.abort();
        return runner.run(target, args, options);
      },
    };

    const error = await rejection(
      collectShadow(shadow, {
        runner: stopping,
        expireBefore: anHourAgo(),
        keep: [],
        signal: controller.signal,
      }),
    );
    expect(error.details.stopped).toBe(true);

    await collectShadow(shadow, { runner, expireBefore: anHourAgo(), keep: [] });
    expect(readable(spent.commitSha)).toBe(false);
  });

  describe('refuses input before running anything', () => {
    const recording = (): { runner: GitRunner; calls: string[][] } => {
      const calls: string[][] = [];
      return {
        calls,
        runner: {
          run: (target, args, options): Promise<GitResult> => {
            calls.push([...args]);
            return runner.run(target, args, options);
          },
        },
      };
    };

    it('an expiry that is no date', async () => {
      const spy = recording();
      const error = await rejection(
        collectShadow(shadow, { runner: spy.runner, expireBefore: new Date(Number.NaN), keep: [] }),
      );
      expect(error.code).toBe('CONFIG_INVALID');
      expect(spy.calls).toEqual([]);
    });

    it('a keep entry that is no object id', async () => {
      const spy = recording();
      const error = await rejection(
        collectShadow(shadow, {
          runner: spy.runner,
          expireBefore: anHourAgo(),
          keep: ['--all'],
        }),
      );
      expect(error.code).toBe('GIT_COMMAND_REFUSED');
      expect(spy.calls).toEqual([]);
    });
  });
});
