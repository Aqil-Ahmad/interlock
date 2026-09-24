import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInterlockError, ulid } from '@interlock/shared';
import type { SnapshotId } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureDirtyState,
  commitSnapshotInShadow,
  createGitRunner,
  describeRepo,
  extractChangeSet,
  listBranchRefs,
  mergeBase,
  openUserRepo,
  touchedPaths,
  speculativeMerge,
} from '../src/index.js';
import type { GitRunner, UserRepo } from '../src/index.js';
import { ensureShadow } from '../src/git/shadow.js';
import { captureState, describeDiff, diffState, isClean } from './support/repo-state.js';
import type { RepoState } from './support/repo-state.js';

/**
 * A full run leaves a watched repository byte-identical.
 *
 * Interlock watches repositories people are actively working in, so a stray
 * checkout or a touched index destroys uncommitted work that exists nowhere
 * else. This is the backstop for that promise, and it is never skipped and
 * never weakened: a failure here means Interlock corrupted someone's work, and
 * that starts a different conversation than a red test.
 *
 * Every git-invoking function is called directly against every awkward state a
 * repository can be in. That is the entire git surface — the daemon runs no git
 * of its own, it composes these — so this is where a new git code path gets
 * exercised. The composition is proven separately, by a test that runs the real
 * daemon.
 *
 * The one thing allowed to change is the object store: a snapshot writes a tree
 * there, and objects are append-only. An object that changed or vanished still
 * fails.
 */

describe('user repositories are never modified', () => {
  let base: string;
  let dataDir: string;
  let runner: GitRunner;

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  const init = (path: string): void => {
    execFileSync('git', ['init', '-q', '-b', 'main', path], { stdio: 'pipe' });
    git(path, 'config', 'user.name', 'Interlock Test');
    git(path, 'config', 'user.email', 'test@example.invalid');
    // Loose refs, not packed, until a fixture packs them on purpose.
    git(path, 'config', 'core.logAllRefUpdates', 'true');
    // The fixture must have no background writer of its own. Since git 2.47,
    // `commit` spawns `maintenance run --auto --detach`, and that child holds
    // `objects/maintenance.lock` for a moment after `commit` has returned — so
    // a capture taken right after a commit can see the lock, and the next one
    // cannot, and the diff reports a removal Interlock never made. Interlock
    // runs nothing that triggers maintenance; the fixture's git does.
    git(path, 'config', 'maintenance.auto', 'false');
    git(path, 'config', 'gc.auto', '0');
  };

  const commit = (path: string, file: string, content: string, message: string): void => {
    writeFileSync(join(path, file), content);
    git(path, 'add', '-A');
    git(path, 'commit', '-qm', message);
  };

  /**
   * Everything the git-invoking code does, in the order the daemon does it.
   *
   * Both capture paths are taken: a scoped capture seeds from the tree the
   * whole-tree capture produced, and both write objects. The change set runs
   * against the snapshot as well as against the head.
   */
  const cycle = async (root: string): Promise<{ diffed: number; excused: number }> => {
    const handle: UserRepo = await openUserRepo(root, { runner });
    const repo = await describeRepo(handle, { runner, dataDir });
    // Reads the user repository over git's own local transport, which is the
    // one path here where git runs a second process inside it.
    const shadow = await ensureShadow(handle, { runner, dataDir, repoId: repo.id });
    const branches = await listBranchRefs(handle, repo.id, { runner });
    expect(branches.length).toBeGreaterThan(0);
    let diffed = 0;
    let excused = 0;

    for (const branch of branches) {
      let snapshot: { id: SnapshotId; treeOid: string } | undefined;
      let snapshotCommit: string | undefined;
      if (branch.worktreePath !== null && branch.dirty !== null) {
        const whole = await captureDirtyState(branch.worktreePath, handle, { runner });
        const paths = [
          ...branch.dirty.stagedFiles,
          ...branch.dirty.unstagedFiles,
          ...branch.dirty.untrackedFiles,
        ];
        const scoped = await captureDirtyState(branch.worktreePath, handle, {
          runner,
          scope: { kind: 'scoped', paths, baseTreeOid: whole.treeOid },
        });
        expect(scoped.treeOid).toBe(whole.treeOid);

        // Into the shadow as well, the way anything merged is captured, and on
        // to a commit there. Both write; the hasher below is what shows neither
        // writes here. The same content, so the same tree, whichever store.
        const intoShadow = await captureDirtyState(branch.worktreePath, handle, {
          runner,
          objectStore: shadow,
        });
        expect(intoShadow.treeOid).toBe(whole.treeOid);
        snapshotCommit = (await commitSnapshotInShadow(shadow, intoShadow, { runner })).commitSha;

        snapshot = { id: ulid<SnapshotId>(), treeOid: whole.treeOid };
      }

      let mergeBaseSha: string | null;
      try {
        mergeBaseSha = await mergeBase(handle, branch.headSha, repo.defaultBranch, { runner });
      } catch (error) {
        // Only the one failure the pipeline itself excuses: a default branch
        // that does not resolve, which `mergeBase` raises as a failed command
        // that is not infrastructure. A timeout or a missing git rejects from
        // the runner with `infra` set, and swallowing that here would leave the
        // rest of this loop unexercised while the suite stayed green.
        if (!isInterlockError(error) || error.code !== 'GIT_COMMAND_FAILED' || error.infra) {
          throw error;
        }
        excused += 1;
        mergeBaseSha = null;
      }
      if (mergeBaseSha === null) continue;

      await extractChangeSet(handle, branch, mergeBaseSha, { runner });
      await touchedPaths(handle, branch, mergeBaseSha, { runner });
      if (snapshot !== undefined) {
        await extractChangeSet(handle, branch, mergeBaseSha, { runner, snapshot });
      }

      // The pair a scheduler merges: this branch — its uncommitted work, where
      // it has any — against the branch it will land on. The merged tree is
      // written into the shadow; the hasher below is what shows nothing lands
      // here.
      const target = await runner.run(handle, [
        'rev-parse',
        '--verify',
        '--quiet',
        `${repo.defaultBranch}^{commit}`,
      ]);
      await speculativeMerge(
        {
          shadow,
          commitA: snapshotCommit ?? branch.headSha,
          commitB: target.stdout.trim(),
          mergeBaseSha,
        },
        { runner },
      );

      diffed += 1;
    }

    return { diffed, excused };
  };

  /** Capture, run, capture, and fail with the diagnosis rather than a boolean. */
  const assertUntouched = async (roots: readonly string[]): Promise<void> => {
    const before = new Map<string, RepoState>(roots.map((root) => [root, captureState(root)]));
    const outcome = await cycle(roots[0]!);
    // Every fixture here has a default branch that resolves, so a cycle that
    // diffed nothing exercised half the surface it claims to and must not pass.
    expect(outcome.diffed).toBeGreaterThan(0);
    for (const root of roots) {
      const after = captureState(root);
      const diff = diffState(before.get(root)!, after);
      expect(isClean(diff), `${root}\n${describeDiff(diff, before.get(root)!, after)}`).toBe(true);
    }
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-untouched-')));
    dataDir = join(base, 'data');
    mkdirSync(dataDir);
    runner = createGitRunner();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe('the harness itself', () => {
    // A checker that can only pass is not a check. Each of these is a write
    // the suite exists to catch, done by hand, and the diff has to name it.
    let root: string;

    beforeEach(() => {
      root = join(base, 'repo');
      init(root);
      commit(root, 'a.txt', 'a\n', 'one');
    });

    it('names a moved ref and the reflog entry that moved with it', () => {
      const before = captureState(root);
      git(root, 'branch', 'sneaky');
      const diff = diffState(before, captureState(root));
      expect(diff.added).toContain(join('.git', 'refs', 'heads', 'sneaky'));
      expect(diff.added).toContain(join('.git', 'logs', 'refs', 'heads', 'sneaky'));
    });

    it('names a touched index', () => {
      writeFileSync(join(root, 'a.txt'), 'edited\n');
      const before = captureState(root);
      git(root, 'add', 'a.txt');
      const diff = diffState(before, captureState(root));
      expect(diff.changed).toContain(join('.git', 'index'));
    });

    it('names an edited worktree file, by content rather than only by time', () => {
      const before = captureState(root);
      writeFileSync(join(root, 'a.txt'), 'edited\n');
      const after = captureState(root);
      const diff = diffState(before, after);
      expect(diff.changed).toStrictEqual(['a.txt']);
      expect(describeDiff(diff, before, after)).toContain('content');
    });

    it('names a lock file left behind', () => {
      const before = captureState(root);
      writeFileSync(join(root, '.git', 'index.lock'), '');
      const diff = diffState(before, captureState(root));
      expect(diff.added).toStrictEqual([join('.git', 'index.lock')]);
    });

    it('allows a new object and a freshened one, and nothing else about objects', () => {
      const before = captureState(root);
      // A new blob, which is what a snapshot legitimately leaves behind.
      execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'new\n' });
      // The same blob again, which freshens the existing file's mtime.
      execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'new\n' });
      const after = captureState(root);
      const diff = diffState(before, after);
      expect(isClean(diff), describeDiff(diff, before, after)).toBe(true);
    });

    it('names an object that vanished, whatever is allowed to appear there', () => {
      // The allowance under `objects/` is for additions and freshening only.
      // A removal there is what a lock file left by a fixture's own git looked
      // like from the far side of a capture, and it has to be reported.
      const before = captureState(root);
      const object = [...before.keys()].find((path) => /objects[/\\][0-9a-f]{2}[/\\]/u.test(path));
      expect(object).toBeDefined();
      rmSync(join(root, object!));
      const diff = diffState(before, captureState(root));
      expect(diff.removed).toStrictEqual([object]);
    });

    it('allows nothing under objects but loose objects and packs', () => {
      // `alternates` redirects where git reads objects from, and is exactly
      // the file a subtle corruption bug would produce. The allowance is for
      // what a snapshot writes, not for the directory.
      const before = captureState(root);
      mkdirSync(join(root, '.git', 'objects', 'info'), { recursive: true });
      writeFileSync(join(root, '.git', 'objects', 'info', 'alternates'), '/elsewhere\n');
      writeFileSync(join(root, '.git', 'objects', 'tmp_obj_abc'), '');
      writeFileSync(join(root, '.git', 'objects', 'maintenance.lock'), '');
      const diff = diffState(before, captureState(root));
      expect(diff.added).toStrictEqual([
        join('.git', 'objects', 'info', 'alternates'),
        join('.git', 'objects', 'maintenance.lock'),
        join('.git', 'objects', 'tmp_obj_abc'),
      ]);
    });

    it('names an object whose content changed, which is corruption', () => {
      const before = captureState(root);
      const object = [...before.keys()].find((path) => /objects[/\\][0-9a-f]{2}[/\\]/u.test(path));
      expect(object).toBeDefined();
      // Loose objects are written read-only, which is itself a small defence.
      chmodSync(join(root, object!), 0o644);
      writeFileSync(join(root, object!), 'not an object any more');
      const diff = diffState(before, captureState(root));
      expect(diff.changed).toStrictEqual([object]);
    });

    it('names a touched file whose content did not change', () => {
      // An mtime is user state too: build tools and editors read it, and a
      // freshen is only allowed on an object.
      const before = captureState(root);
      const later = new Date(Date.now() + 5_000);
      utimesSync(join(root, 'a.txt'), later, later);
      const diff = diffState(before, captureState(root));
      expect(diff.changed).toStrictEqual(['a.txt']);
    });

    it('names a content change even when size and mtime were put back', () => {
      // The one signal that cannot be restored: the bytes themselves. The
      // mtime is pinned to a whole second on both sides, since `utimes` takes
      // milliseconds and the filesystem keeps more, and a restored time that
      // differs in the sub-millisecond part would be caught for the wrong
      // reason.
      const path = join(root, 'a.txt');
      const pinned = new Date(1_700_000_000_000);
      utimesSync(path, pinned, pinned);
      const before = captureState(root);
      writeFileSync(path, 'b\n');
      utimesSync(path, pinned, pinned);
      const after = captureState(root);
      expect(after.get('a.txt')?.mtimeMs).toBe(before.get('a.txt')?.mtimeMs);
      expect(after.get('a.txt')?.size).toBe(before.get('a.txt')?.size);
      expect(diffState(before, after).changed).toStrictEqual(['a.txt']);
    });

    it('names a removed ref', () => {
      git(root, 'branch', 'doomed');
      const before = captureState(root);
      git(root, 'branch', '-D', 'doomed');
      const diff = diffState(before, captureState(root));
      expect(diff.removed).toContain(join('.git', 'refs', 'heads', 'doomed'));
    });

    it('does not mistake a worktree directory called objects for the object store', () => {
      mkdirSync(join(root, 'objects'));
      writeFileSync(join(root, 'objects', 'one.txt'), '1\n');
      const before = captureState(root);
      writeFileSync(join(root, 'objects', 'two.txt'), '2\n');
      const diff = diffState(before, captureState(root));
      expect(diff.added).toStrictEqual([join('objects', 'two.txt')]);
    });

    it('records a dangling symlink rather than following it into nothing', () => {
      // Worktrees hold these all the time — `node_modules/.bin` after a
      // package is removed — and a walk that read through the link would throw
      // on the first one and capture nothing at all.
      symlinkSync('does-not-exist', join(root, 'dangling'));
      const state = captureState(root);
      expect(state.has('dangling')).toBe(true);
      const before = state;
      rmSync(join(root, 'dangling'));
      symlinkSync('still-does-not-exist', join(root, 'dangling'));
      // Retargeted, and the target is the only thing about it that changed.
      const diff = diffState(before, captureState(root));
      expect(diff.changed).toStrictEqual(['dangling']);
    });

    it('records a symlink as a link, so replacing it with its target is a change', () => {
      symlinkSync('a.txt', join(root, 'link'));
      const before = captureState(root);
      rmSync(join(root, 'link'));
      writeFileSync(join(root, 'link'), 'a\n');
      const diff = diffState(before, captureState(root));
      expect(diff.changed).toContain('link');
    });

    it('names a changed mode', () => {
      const before = captureState(root);
      execFileSync('chmod', ['755', join(root, 'a.txt')]);
      const diff = diffState(before, captureState(root));
      expect(diff.changed).toStrictEqual(['a.txt']);
    });
  });

  it('leaves file contents, modes and mtimes unchanged after a full run', async () => {
    const root = join(base, 'repo');
    init(root);
    commit(root, 'a.txt', 'a\n', 'one');
    commit(root, 'b.txt', 'b\n', 'two');
    // Every kind of uncommitted work at once: staged, unstaged, untracked, an
    // executable, and a path with a space in it.
    writeFileSync(join(root, 'a.txt'), 'staged\n');
    git(root, 'add', 'a.txt');
    writeFileSync(join(root, 'b.txt'), 'unstaged\n');
    writeFileSync(join(root, 'new file.txt'), 'untracked\n');
    writeFileSync(join(root, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    // Names that are pathspec magic or look like flags. These reach the scoped
    // capture through the dirty-state lists exactly as the watcher's paths do,
    // and a capture that read `:(exclude)` as magic would drop the file and
    // produce a tree that is wrong rather than merely stale — which the
    // whole-tree comparison inside the cycle is there to catch.
    writeFileSync(join(root, ':(exclude)a.txt'), 'magic\n');
    writeFileSync(join(root, '-dash.txt'), 'flag\n');

    await assertUntouched([root]);
  });

  it('leaves .git/index, HEAD, refs, config and packed-refs unchanged', async () => {
    const root = join(base, 'repo');
    init(root);
    commit(root, 'a.txt', 'a\n', 'one');
    git(root, 'branch', 'feature');
    git(root, 'tag', 'v1');
    // Half packed and half loose, so both storage forms are under the hash.
    git(root, 'pack-refs', '--all');
    git(root, 'branch', 'loose');
    // `ORIG_HEAD` and `FETCH_HEAD`, from the commands that write them.
    git(root, 'reset', '--soft', 'HEAD');
    git(root, 'fetch', '-q', root, 'main');
    writeFileSync(join(root, 'a.txt'), 'dirty\n');

    await assertUntouched([root]);
  });

  it('leaves the stash and reflog unchanged', async () => {
    const root = join(base, 'repo');
    init(root);
    commit(root, 'a.txt', 'a\n', 'one');
    writeFileSync(join(root, 'a.txt'), 'stashed\n');
    git(root, 'stash', 'push', '-q', '-m', 'work in progress');
    // Something left in the worktree too, so a snapshot has work to capture
    // while a stash is present.
    writeFileSync(join(root, 'a.txt'), 'dirty after stash\n');

    await assertUntouched([root]);
  });

  it('does not create branches, tags or worktrees in the user repo', async () => {
    // A linked worktree, whose `refs/` live in the main checkout's git dir and
    // whose handle names neither it nor the main checkout — so the shared
    // directory is hashed through the main root, and the linked worktree
    // through its own.
    const root = join(base, 'repo');
    const linked = join(base, 'feature');
    init(root);
    commit(root, 'a.txt', 'a\n', 'one');
    git(root, 'worktree', 'add', '-q', '-b', 'feature', linked);
    writeFileSync(join(linked, 'a.txt'), 'edited in the linked worktree\n');
    writeFileSync(join(linked, 'extra.txt'), 'untracked there\n');

    // A submodule: its git dir lives under `.git/modules/` and is hashed with
    // the rest.
    const sub = join(base, 'sub');
    init(sub);
    commit(sub, 's.txt', 's\n', 'sub');
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub');
    git(root, 'commit', '-qm', 'add submodule');

    await assertUntouched([root, linked]);
  });

  it('excuses exactly a default branch that does not resolve, and nothing else', async () => {
    // A repository whose `origin/HEAD` names a branch nobody fetched, or a
    // detached head with no `main`: the pipeline publishes without a diff, and
    // the cycle takes the same path. Reached on purpose, because a catch that
    // no fixture reaches is a comment about behaviour rather than a test of it.
    // Detached with no `origin`, so the default falls back to a literal `main`
    // that is gone; the detached worktree is skipped, and the bare `topic` ref
    // is what gets compared against a branch that does not exist.
    const root = join(base, 'repo');
    init(root);
    commit(root, 'a.txt', 'a\n', 'one');
    git(root, 'branch', 'topic');
    git(root, 'checkout', '-q', '--detach', 'HEAD');
    git(root, 'branch', '-D', 'main');
    writeFileSync(join(root, 'a.txt'), 'dirty\n');

    const before = captureState(root);
    const outcome = await cycle(root);
    const after = captureState(root);
    const diff = diffState(before, after);
    expect(isClean(diff), describeDiff(diff, before, after)).toBe(true);
    expect(outcome).toStrictEqual({ diffed: 0, excused: 1 });
  });

  it('holds no lock files in the user repo after the run', async () => {
    // Three states that each hold their own files in the git dir: a detached
    // head, a rebase stopped on a conflict, and a merge stopped on one. Each
    // is a repository someone is in the middle of something in, and each is
    // where a stray write is most expensive.
    const detached = join(base, 'detached');
    init(detached);
    commit(detached, 'a.txt', 'a\n', 'one');
    commit(detached, 'a.txt', 'b\n', 'two');
    git(detached, 'checkout', '-q', 'HEAD~1');
    writeFileSync(join(detached, 'a.txt'), 'dirty on a detached head\n');

    const rebasing = join(base, 'rebasing');
    init(rebasing);
    commit(rebasing, 'a.txt', 'base\n', 'base');
    git(rebasing, 'checkout', '-q', '-b', 'topic');
    commit(rebasing, 'a.txt', 'topic\n', 'topic');
    git(rebasing, 'checkout', '-q', 'main');
    commit(rebasing, 'a.txt', 'main\n', 'main');
    git(rebasing, 'checkout', '-q', 'topic');
    expect(() => git(rebasing, 'rebase', 'main')).toThrow();

    const merging = join(base, 'merging');
    init(merging);
    commit(merging, 'a.txt', 'base\n', 'base');
    git(merging, 'checkout', '-q', '-b', 'topic');
    commit(merging, 'a.txt', 'topic\n', 'topic');
    git(merging, 'checkout', '-q', 'main');
    commit(merging, 'a.txt', 'main\n', 'main');
    expect(() => git(merging, 'merge', 'topic')).toThrow();

    for (const root of [detached, rebasing, merging]) {
      await assertUntouched([root]);
      // No `index.lock`, no `HEAD.lock`, nothing `.lock` anywhere under the
      // git dir once the run is over.
      const locks = [...captureState(root).keys()].filter((path) => path.endsWith('.lock'));
      expect(locks, root).toStrictEqual([]);
    }
  });
});
