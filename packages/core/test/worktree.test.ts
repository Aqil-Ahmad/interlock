import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitRunner } from '../src/git/repo-handle.js';
import type { GitResult, GitRunner, UserRepo } from '../src/git/repo-handle.js';
import { captureDirtyState, chunkPaths, MAX_PATHSPEC_BYTES } from '../src/git/worktree.js';
import { rejection } from './support/rejection.js';

/**
 * Snapshotting a worktree someone is working in.
 *
 * Every test asserts the user's repository afterwards, not only the tree: the
 * failure this code exists to prevent is a write to state that was never
 * committed and cannot be recovered, and a tree can be correct while the index
 * behind it has been destroyed.
 */
describe('captureDirtyState', () => {
  let dir: string;
  let repo: UserRepo;
  const runner = createGitRunner();

  /** Wraps the real runner and records the subcommand of each invocation. */
  const recording = (): { runner: GitRunner; verbs: string[] } => {
    const verbs: string[] = [];
    return {
      verbs,
      runner: {
        run: (target, args, options): Promise<GitResult> => {
          verbs.push(args[0] ?? '');
          return runner.run(target, args, options);
        },
      },
    };
  };

  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  /**
   * Everything a capture must leave alone, read through git.
   *
   * Reading it moves `.git/index`: `git status` rewrites the file to refresh
   * its stat cache, keeping the contents byte-identical while the mtime
   * changes. The index is therefore measured separately, and after this — with
   * the two interleaved, the observation would be what fails the assertion.
   */
  const observable = (): Record<string, string> => ({
    status: git('status', '--porcelain'),
    refs: git('for-each-ref', '--format=%(refname) %(objectname)'),
    stash: git('stash', 'list'),
    config: readFileSync(join(dir, '.git', 'config'), 'utf8'),
  });

  const indexPath = (): string => join(dir, '.git', 'index');
  const indexBytes = (path = indexPath()): string => readFileSync(path).toString('base64');
  const indexMtime = (path = indexPath()): number => statSync(path).mtimeMs;
  const gitDirEntries = (): string[] => readdirSync(join(dir, '.git')).sort();

  /**
   * Snapshot the user's repository, run a capture, and assert nothing moved.
   *
   * Both the contents and the mtime of the index: contents are what the task
   * cannot afford to lose, and the mtime is what the user's own git reads to
   * decide whether its cache is still valid.
   */
  const leavingUserStateIntact = async <T>(capture: () => Promise<T>): Promise<T> => {
    const before = observable();
    const bytes = indexBytes();
    const mtime = indexMtime();
    // Listed after `observable()` for the same reason the index is: the user's
    // own git writes while it reads, and with `core.splitIndex` set that status
    // call leaves a `sharedindex.*` behind that this would blame on the capture.
    const entries = gitDirEntries();

    const result = await capture();

    expect(indexBytes()).toBe(bytes);
    expect(indexMtime()).toBe(mtime);
    expect(gitDirEntries()).toEqual(entries);
    expect(observable()).toEqual(before);
    return result;
  };

  /**
   * Paths in a tree, read NUL-separated.
   *
   * Without `-z` git quotes and escapes any name holding a newline or a quote,
   * so the assertion would compare a rendering of the path rather than the path.
   */
  const treePaths = (oid: string): string[] =>
    git('ls-tree', '-r', '--name-only', '-z', oid).split('\0').filter(Boolean);

  beforeEach(() => {
    // git answers with fully-resolved paths, and on macOS /var is a symlink to
    // /private/var, so the fixture works in canonical form throughout.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-wt-')));
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
    git('config', 'user.name', 'Interlock Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(dir, 'tracked.txt'), 'committed\n');
    git('add', '-A');
    git('commit', '-qm', 'one');

    repo = { kind: 'user', rootPath: dir, gitDir: join(dir, '.git') };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('a whole-tree capture', () => {
    it('records staged, unstaged and untracked work but not ignored files', async () => {
      writeFileSync(join(dir, 'staged.txt'), 'staged\n');
      git('add', 'staged.txt');
      writeFileSync(join(dir, 'tracked.txt'), 'modified\n');
      writeFileSync(join(dir, 'untracked.txt'), 'untracked\n');
      writeFileSync(join(dir, 'ignored.txt'), 'secret\n');
      const snapshot = await leavingUserStateIntact(() => captureDirtyState(dir, repo, { runner }));

      expect(treePaths(snapshot.treeOid)).toEqual([
        '.gitignore',
        'staged.txt',
        'tracked.txt',
        'untracked.txt',
      ]);
      expect(git('show', `${snapshot.treeOid}:tracked.txt`)).toBe('modified\n');
      expect(snapshot.clean).toBe(false);
    });

    it('records a deleted file as absent', async () => {
      rmSync(join(dir, 'tracked.txt'));
      const snapshot = await leavingUserStateIntact(() => captureDirtyState(dir, repo, { runner }));

      expect(treePaths(snapshot.treeOid)).toEqual(['.gitignore']);
    });

    it('keeps a tracked file that also matches gitignore', async () => {
      // git honours the index over the ignore rules for a file already tracked,
      // so a snapshot rebuilt from the worktree alone would silently drop it.
      writeFileSync(join(dir, 'ignored.txt'), 'now tracked\n');
      git('add', '-f', 'ignored.txt');
      git('commit', '-qm', 'track an ignored path');
      const snapshot = await leavingUserStateIntact(() => captureDirtyState(dir, repo, { runner }));

      expect(treePaths(snapshot.treeOid)).toContain('ignored.txt');
    });

    it('reports a clean worktree as the tree HEAD already records', async () => {
      const snapshot = await leavingUserStateIntact(() => captureDirtyState(dir, repo, { runner }));

      expect(snapshot.clean).toBe(true);
      expect(snapshot.treeOid).toBe(git('rev-parse', 'HEAD^{tree}').trim());
    });

    it('captures a repository with nothing committed', async () => {
      const unborn = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-unborn-')));
      execFileSync('git', ['init', '-q', '-b', 'main', unborn], { stdio: 'pipe' });
      writeFileSync(join(unborn, 'first.txt'), 'first\n');

      try {
        const snapshot = await captureDirtyState(
          unborn,
          { kind: 'user', rootPath: unborn, gitDir: join(unborn, '.git') },
          { runner },
        );

        expect(
          execFileSync('git', ['-C', unborn, 'ls-tree', '-r', '--name-only', snapshot.treeOid], {
            encoding: 'utf8',
          }).trim(),
        ).toBe('first.txt');
        // Nothing is committed, so there is no state for the worktree to match.
        expect(snapshot.clean).toBe(false);
      } finally {
        rmSync(unborn, { recursive: true, force: true });
      }
    });
  });

  describe('a scoped capture', () => {
    it('keeps uncommitted work outside the reported paths', async () => {
      // Seeded from HEAD this is the corrupt case: `earlier.txt` would snapshot
      // as its committed contents while the worktree holds something else.
      writeFileSync(join(dir, 'earlier.txt'), 'first round\n');
      const base = await captureDirtyState(dir, repo, { runner });

      writeFileSync(join(dir, 'earlier.txt'), 'edited between snapshots\n');
      writeFileSync(join(dir, 'reported.txt'), 'this round\n');
      const snapshot = await leavingUserStateIntact(() =>
        captureDirtyState(dir, repo, {
          runner,
          scope: { kind: 'scoped', paths: ['reported.txt'], baseTreeOid: base.treeOid },
        }),
      );

      expect(snapshot.takenAs).toBe('scoped');
      expect(git('show', `${snapshot.treeOid}:reported.txt`)).toBe('this round\n');
      // Carried from the base tree, not re-read from HEAD.
      expect(git('show', `${snapshot.treeOid}:earlier.txt`)).toBe('first round\n');
    });

    it('reuses the base tree when nothing reported turned out to be a change', async () => {
      const base = await captureDirtyState(dir, repo, { runner });

      const snapshot = await captureDirtyState(dir, repo, {
        runner,
        scope: { kind: 'scoped', paths: ['tracked.txt'], baseTreeOid: base.treeOid },
      });

      expect(snapshot.treeOid).toBe(base.treeOid);
      expect(snapshot.takenAs).toBe('scoped');
    });

    it.each([
      ['a path that is ignored', 'ignored.txt'],
      ['a path that no longer exists and never was tracked', 'vanished.txt'],
    ])('survives %s being reported', async (_name, path) => {
      // Both are ordinary watcher output that `git add` refuses.
      writeFileSync(join(dir, 'ignored.txt'), 'secret\n');
      const base = await captureDirtyState(dir, repo, { runner });
      writeFileSync(join(dir, 'real.txt'), 'real\n');
      const snapshot = await leavingUserStateIntact(() =>
        captureDirtyState(dir, repo, {
          runner,
          scope: { kind: 'scoped', paths: [path, 'real.txt'], baseTreeOid: base.treeOid },
        }),
      );

      expect(treePaths(snapshot.treeOid)).toContain('real.txt');
      expect(treePaths(snapshot.treeOid)).not.toContain('ignored.txt');
    });

    it.each([
      ['a space', 'has space.txt'],
      ['a newline', 'has\nnewline.txt'],
      ['a quote', 'has"quote.txt'],
    ])('handles a path containing %s', async (_name, name) => {
      // The status output is NUL-separated for exactly this: splitting it on
      // newlines would cut the second name in half and stage two paths that do
      // not exist.
      const base = await captureDirtyState(dir, repo, { runner });
      writeFileSync(join(dir, name), 'awkward\n');

      const snapshot = await leavingUserStateIntact(() =>
        captureDirtyState(dir, repo, {
          runner,
          scope: { kind: 'scoped', paths: [name], baseTreeOid: base.treeOid },
        }),
      );

      expect(treePaths(snapshot.treeOid)).toContain(name);
    });

    it('records a rename when both of its paths are reported', async () => {
      // A pathspec narrows rename detection too: scoped to the destination
      // alone git reports `A renamed.txt` with no source, so the source has to
      // arrive on its own account. A watcher sees both, because both moved.
      const base = await captureDirtyState(dir, repo, { runner });
      git('mv', 'tracked.txt', 'renamed.txt');
      const snapshot = await leavingUserStateIntact(() =>
        captureDirtyState(dir, repo, {
          runner,
          scope: {
            kind: 'scoped',
            paths: ['renamed.txt', 'tracked.txt'],
            baseTreeOid: base.treeOid,
          },
        }),
      );

      const paths = treePaths(snapshot.treeOid);
      expect(paths).toContain('renamed.txt');
      // Restaged too, or the tree keeps a file that is no longer there.
      expect(paths).not.toContain('tracked.txt');
    });

    it.each([
      [
        'a file the user reverted',
        (): void => {
          writeFileSync(join(dir, 'tracked.txt'), 'committed\n');
        },
      ],
      [
        'a staged new file that was unstaged and deleted',
        (): void => {
          git('rm', '--cached', '-q', 'added.txt');
          rmSync(join(dir, 'added.txt'));
        },
      ],
      [
        'a further edit',
        (): void => {
          writeFileSync(join(dir, 'tracked.txt'), 'EDITED AGAIN\n');
        },
      ],
      [
        'a deletion',
        (): void => {
          rmSync(join(dir, 'tracked.txt'));
        },
      ],
      [
        'a new untracked file',
        (): void => {
          writeFileSync(join(dir, 'appeared.txt'), 'new\n');
        },
      ],
      [
        'a mode change',
        (): void => {
          chmodSync(join(dir, 'tracked.txt'), 0o755);
        },
      ],
    ])('describes the same worktree as a whole-tree capture after %s', async (_name, change) => {
      // The strongest invariant this function has: two routes to one worktree
      // must agree. Asserting agreement rather than a literal tree is what
      // keeps it from drifting into whatever the implementation happens to do.
      writeFileSync(join(dir, 'tracked.txt'), 'EDITED\n');
      writeFileSync(join(dir, 'added.txt'), 'x\n');
      git('add', 'added.txt');
      const base = await captureDirtyState(dir, repo, { runner });

      change();
      const paths = ['tracked.txt', 'added.txt', 'appeared.txt'];
      const scoped = await leavingUserStateIntact(() =>
        captureDirtyState(dir, repo, {
          runner,
          scope: { kind: 'scoped', paths, baseTreeOid: base.treeOid },
        }),
      );
      const whole = await captureDirtyState(dir, repo, { runner });

      expect(scoped.treeOid).toBe(whole.treeOid);
      expect(scoped.clean).toBe(whole.clean);
    });

    it.each([
      ['an empty path', ''],
      ['a path naming the worktree root', '.'],
      ['a path naming the root the long way', 'sub/..'],
    ])('refuses %s, which would widen the capture to everything', async (_name, path) => {
      // git reads all three as the worktree root, so a scoped capture would
      // quietly become a whole-tree one and report itself as scoped.
      const base = await captureDirtyState(dir, repo, { runner });

      const error = await rejection(
        captureDirtyState(dir, repo, {
          runner,
          scope: { kind: 'scoped', paths: [path], baseTreeOid: base.treeOid },
        }),
      );

      expect(error.code).toBe('GIT_COMMAND_REFUSED');
      expect(error.infra).toBe(false);
    });

    it.each([
      ['an absolute path', '/etc/hosts'],
      ['a path climbing out of the worktree', '../escape.txt'],
    ])('refuses %s rather than failing the capture with a git error', async (_name, path) => {
      const base = await captureDirtyState(dir, repo, { runner });

      const error = await rejection(
        captureDirtyState(dir, repo, {
          runner,
          scope: { kind: 'scoped', paths: [path], baseTreeOid: base.treeOid },
        }),
      );

      expect(error.code).toBe('GIT_COMMAND_REFUSED');
      expect(error.message).toContain('relative to the worktree');
      expect(error.details.path).toBe(path);
      expect(error.infra).toBe(false);
    });

    it('survives a path being reported again after its change was absorbed', async () => {
      // The index column keeps reporting a deletion the base tree already
      // holds; `changedPaths` explains why that path must not be restaged.
      rmSync(join(dir, 'tracked.txt'));
      const first = await captureDirtyState(dir, repo, {
        runner,
        scope: {
          kind: 'scoped',
          paths: ['tracked.txt'],
          baseTreeOid: git('rev-parse', 'HEAD^{tree}').trim(),
        },
      });

      const second = await leavingUserStateIntact(() =>
        captureDirtyState(dir, repo, {
          runner,
          scope: { kind: 'scoped', paths: ['tracked.txt'], baseTreeOid: first.treeOid },
        }),
      );

      expect(second.treeOid).toBe(first.treeOid);
      expect(treePaths(second.treeOid)).not.toContain('tracked.txt');
    });

    it('treats a reported path as a literal name, not a pathspec expression', async () => {
      // A leading `:` makes git read the argument as magic: `:(exclude)a.txt`
      // would drop the file from the capture and report success. What prevents
      // it is `GIT_LITERAL_PATHSPECS` in the runner's environment, so a failure
      // here points there rather than at this file.
      writeFileSync(join(dir, 'tracked.txt'), 'edited\n');
      const base = git('rev-parse', 'HEAD^{tree}').trim();

      const snapshot = await leavingUserStateIntact(() =>
        captureDirtyState(dir, repo, {
          runner,
          scope: {
            kind: 'scoped',
            paths: [':(exclude)tracked.txt', 'tracked.txt'],
            baseTreeOid: base,
          },
        }),
      );

      expect(git('show', `${snapshot.treeOid}:tracked.txt`)).toBe('edited\n');
    });

    it('falls back to a whole-tree capture when the base tree has been collected', async () => {
      // A user running `git gc --prune=now` can collect a tree Interlock holds,
      // because nothing references it. That is a reason to re-read, not to fail.
      writeFileSync(join(dir, 'present.txt'), 'present\n');
      const collected = '0000000000000000000000000000000000000001';
      const snapshot = await leavingUserStateIntact(() =>
        captureDirtyState(dir, repo, {
          runner,
          scope: { kind: 'scoped', paths: ['present.txt'], baseTreeOid: collected },
        }),
      );

      expect(snapshot.takenAs).toBe('whole-tree');
      expect(treePaths(snapshot.treeOid)).toContain('present.txt');
    });

    it('splits a path list too long for one command line', async () => {
      // Arguments and environment share a fixed budget, and the runner closes
      // stdin, so a long list has to be split across invocations. Names are
      // long rather than numerous so the ceiling is crossed with fewer files:
      // it is the byte total that decides, not the count.
      const filler = 'n'.repeat(100);
      const many = Array.from(
        { length: 1_000 },
        (_, i) => `${filler}-${String(i).padStart(4, '0')}.txt`,
      );
      const budget = many.reduce((total, path) => total + Buffer.byteLength(path) + 1, 0);
      expect(budget).toBeGreaterThan(MAX_PATHSPEC_BYTES);

      for (const path of many) writeFileSync(join(dir, path), `${path}\n`);
      const { runner: counting, verbs } = recording();

      const snapshot = await leavingUserStateIntact(() =>
        captureDirtyState(dir, repo, {
          runner: counting,
          scope: {
            kind: 'scoped',
            paths: many,
            baseTreeOid: git('rev-parse', 'HEAD^{tree}').trim(),
          },
        }),
      );

      // The point of the test: one `add` would have exceeded the budget.
      expect(verbs.filter((verb) => verb === 'add').length).toBeGreaterThan(1);
      expect(treePaths(snapshot.treeOid)).toHaveLength(many.length + 2);
    });

    it.each([
      ['an object id that is too short', 'abc123'],
      ['an object id that is not hex', 'z'.repeat(40)],
      ['a value shaped like a flag', '--output=/tmp/pwned'],
      ['a revision expression', 'HEAD~1'],
    ])('refuses %s as a base tree', async (_name, baseTreeOid) => {
      // It arrives from stored state and is interpolated into a `rev-parse`
      // argument, so its shape is checked before git ever sees it.
      const error = await rejection(
        captureDirtyState(dir, repo, {
          runner,
          scope: { kind: 'scoped', paths: ['tracked.txt'], baseTreeOid },
        }),
      );

      expect(error.code).toBe('GIT_COMMAND_REFUSED');
      expect(error.message).toContain('not an object id');
      expect(error.infra).toBe(false);
    });
  });

  describe('against a repository configured to write while it reads', () => {
    it.each([
      ['core.splitIndex', 'true'],
      // A hook path rather than `true`: the builtin daemon starts
      // asynchronously and drops a socket into `.git`, which would race the
      // listing this asserts on.
      ['core.fsmonitor', './no-such-hook'],
      ['core.untrackedCache', 'true'],
    ])('leaves the git directory alone with %s set', async (key, value) => {
      // The split index puts a `sharedindex.*` file in `$GIT_DIR` on every
      // index write, whatever `GIT_INDEX_FILE` says, and the user most likely
      // to have it on is the one with the big repository this is built for.
      //
      // What keeps this green lives in the runner, not here: it passes
      // `-c core.splitIndex=false` alongside `core.fsmonitor=`. A failure in
      // this test points at that argv, not at this file.
      git('config', key, value);
      writeFileSync(join(dir, 'tracked.txt'), 'modified\n');

      const snapshot = await leavingUserStateIntact(() => captureDirtyState(dir, repo, { runner }));

      // The wrapper asserts the git directory; this asserts the capture still
      // did its job rather than failing quietly into an unchanged tree.
      expect(git('show', `${snapshot.treeOid}:tracked.txt`)).toBe('modified\n');
    });
  });

  describe('under a sparse checkout', () => {
    it.each([
      ['a cone', false],
      ['a cone with a sparse index', true],
    ])('keeps files outside %s in the snapshot', async (_name, sparseIndex) => {
      // Sparse checkout removes them from disk, and `add -A` stages absent files
      // as deletions, so the tree could silently lose everything outside the
      // cone. What prevents that is `git add` itself: it reads
      // `core.sparseCheckout` and the pattern file and leaves out-of-cone paths
      // alone. Not skip-worktree bits — a plain `read-tree` into a fresh index
      // sets none, measured with `ls-files -v`.
      //
      // So `core.sparseCheckout` must stay readable. Scrubbing it the way the
      // runner scrubs `core.splitIndex` would delete every out-of-cone file from
      // every snapshot, and this test is what would catch that.
      mkdirSync(join(dir, 'inside'));
      mkdirSync(join(dir, 'outside'));
      writeFileSync(join(dir, 'inside', 'a.txt'), 'in\n');
      writeFileSync(join(dir, 'outside', 'b.txt'), 'out\n');
      git('add', '-A');
      git('commit', '-qm', 'two directories');

      git('sparse-checkout', 'init', '--cone');
      if (sparseIndex) git('config', 'index.sparse', 'true');
      git('sparse-checkout', 'set', 'inside');
      // Dirty, so the tree is one `add -A` built under sparsity rather than one
      // that matches HEAD whatever happened.
      writeFileSync(join(dir, 'inside', 'a.txt'), 'edited under a cone\n');

      const snapshot = await leavingUserStateIntact(() => captureDirtyState(dir, repo, { runner }));

      expect(existsSync(join(dir, 'outside', 'b.txt'))).toBe(false);
      expect(git('show', `${snapshot.treeOid}:inside/a.txt`)).toBe('edited under a cone\n');
      expect(treePaths(snapshot.treeOid)).toContain('outside/b.txt');
      expect(snapshot.clean).toBe(false);
    });
  });

  describe('a linked worktree', () => {
    it('captures the worktree it was given, not the main checkout', async () => {
      // `worktreePath` and `repo` differ here, which is the reason they are
      // separate arguments, and a branch checked out in a linked worktree is
      // the ordinary case rather than an exotic one.
      const linked = join(dir, '..', `${basename(dir)}-wt`);
      git('branch', 'side');
      git('worktree', 'add', '-q', linked, 'side');
      const inLinked = (...args: string[]): string =>
        execFileSync('git', ['-C', linked, ...args], { stdio: 'pipe', encoding: 'utf8' });

      // Committed, and divergent: a capture that read the main checkout's HEAD
      // would still restage this worktree and produce a plausible tree, so the
      // two branches have to disagree for the assertions to mean anything.
      writeFileSync(join(linked, 'only-here.txt'), 'linked\n');
      inLinked('add', '-A');
      inLinked('commit', '-qm', 'side only');
      const sideTree = inLinked('rev-parse', 'side^{tree}').trim();
      const linkedIndex = join(dir, '.git', 'worktrees', basename(linked), 'index');
      const linkedBefore = { bytes: indexBytes(linkedIndex), mtime: indexMtime(linkedIndex) };

      try {
        const snapshot = await leavingUserStateIntact(() =>
          captureDirtyState(realpathSync(linked), repo, { runner }),
        );

        expect(snapshot.treeOid).toBe(sideTree);
        // This is the assertion that discriminates. The tree matches either
        // way — `add -A` restages this worktree whichever HEAD was read — so
        // only `clean`, which compares against that HEAD, can tell them apart.
        expect(snapshot.clean).toBe(true);
        expect(treePaths(snapshot.treeOid)).toContain('only-here.txt');
        // The index at risk here is this worktree's, not the main one, and the
        // mtime matters for the same reason it does there.
        expect(indexBytes(linkedIndex)).toBe(linkedBefore.bytes);
        expect(indexMtime(linkedIndex)).toBe(linkedBefore.mtime);
      } finally {
        rmSync(linked, { recursive: true, force: true });
      }
    });
  });

  describe('splitting a path list', () => {
    it('never yields an empty group, which would stage the whole worktree', () => {
      // `git add -A --` with no pathspec stages everything, so an empty chunk
      // turns a scoped capture into a silent whole-tree one.
      expect([...chunkPaths([])]).toEqual([]);
      expect([...chunkPaths(['a.txt'])]).toEqual([['a.txt']]);
    });

    it('sends a path over the ceiling on its own rather than dropping it', () => {
      const huge = 'x'.repeat(MAX_PATHSPEC_BYTES + 1);

      expect([...chunkPaths([huge, 'small.txt'])]).toEqual([[huge], ['small.txt']]);
    });
  });

  describe('when the capture fails partway', () => {
    /** A runner that fails one verb, leaving everything before it done. */
    const failingAt = (verb: string): GitRunner => ({
      run: async (target, args, options): Promise<GitResult> => {
        if (args[0] === verb) throw new Error(`injected failure in git ${verb}`);
        return runner.run(target, args, options);
      },
    });

    it('leaves the user repository untouched when write-tree never runs', async () => {
      writeFileSync(join(dir, 'tracked.txt'), 'modified\n');
      writeFileSync(join(dir, 'untracked.txt'), 'untracked\n');
      await leavingUserStateIntact(async () => {
        await expect(
          captureDirtyState(dir, repo, { runner: failingAt('write-tree') }),
        ).rejects.toThrow('injected failure');
      });
    });

    it('leaves the user repository untouched when a scoped capture fails mid-stage', async () => {
      // The scoped route runs read-tree, status, add and write-tree, so a
      // failure inside `add` leaves a partly populated temporary index behind.
      writeFileSync(join(dir, 'tracked.txt'), 'modified\n');
      const base = git('rev-parse', 'HEAD^{tree}').trim();

      await leavingUserStateIntact(async () => {
        await expect(
          captureDirtyState(dir, repo, {
            runner: failingAt('add'),
            scope: { kind: 'scoped', paths: ['tracked.txt'], baseTreeOid: base },
          }),
        ).rejects.toThrow('injected failure');
      });
    });

    it('removes the temporary index on the error path', async () => {
      // A private root, so a capture running in another worker cannot leave
      // something here for this assertion to blame on the failure path.
      const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-temproot-')));

      try {
        await expect(
          captureDirtyState(dir, repo, { runner: failingAt('write-tree'), tempDir }),
        ).rejects.toThrow('injected failure');

        expect(readdirSync(tempDir)).toEqual([]);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
