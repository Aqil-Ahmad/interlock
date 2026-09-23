import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoId } from '@interlock/shared';
import { createGitRunner } from '../src/git/repo-handle.js';
import type { GitResult, GitRunner, UserRepo } from '../src/git/repo-handle.js';
import { ensureShadow, shadowPathFor } from '../src/git/shadow.js';
import { rejection } from './support/rejection.js';

/**
 * The clone Interlock owns.
 *
 * Two properties carry the whole design and both are asserted against a real
 * repository rather than a mock: the clone borrows the user's objects instead
 * of copying them, so cost does not scale with history; and a second call
 * refreshes what is there instead of building it again.
 */
describe('ensureShadow', () => {
  let base: string;
  let dir: string;
  let dataDir: string;
  let repo: UserRepo;
  const repoId = '01JBQ0000000000000000REPO' as RepoId;
  const runner = createGitRunner();

  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  const gitIn = (where: string, ...args: string[]): string =>
    execFileSync('git', ['-C', where, ...args], { stdio: 'pipe', encoding: 'utf8' });

  /** Wraps the real runner and records every argv it is asked to run. */
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

  /**
   * Loose and packed objects in a store, by name.
   *
   * What "shared, not copied" means concretely: the shadow's own store stays
   * empty however much history the user has.
   */
  const objectCount = (objectsDir: string): number => {
    const out = execFileSync(
      'find',
      [objectsDir, '-type', 'f', '-not', '-path', `${objectsDir}/info/*`],
      { stdio: 'pipe', encoding: 'utf8' },
    );
    return out.split('\n').filter(Boolean).length;
  };

  const shadowRefs = (shadowPath: string): string[] =>
    gitIn(shadowPath, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean);

  const alternatesOf = (shadowPath: string): string =>
    readFileSync(join(shadowPath, 'objects', 'info', 'alternates'), 'utf8').trim();

  beforeEach(() => {
    // git answers with fully-resolved paths, and on macOS /var is a symlink to
    // /private/var, so the fixture works in canonical form throughout.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-shadow-')));
    dir = join(base, 'user');
    dataDir = join(base, 'data');
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
    git('config', 'user.name', 'Interlock Test');
    git('config', 'user.email', 'test@example.invalid');
    // Since git 2.47 `commit` detaches a maintenance process that holds
    // `objects/maintenance.lock` after the commit returns.
    git('config', 'maintenance.auto', 'false');
    git('config', 'gc.auto', '0');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'one');

    repo = { kind: 'user', rootPath: dir, gitDir: join(dir, '.git') };
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('borrows the user object store rather than copying it', async () => {
    const shadow = await ensureShadow(repo, { runner, dataDir, repoId });

    expect(alternatesOf(shadow.rootPath)).toBe(realpathSync(join(dir, '.git', 'objects')));
    // The commit is reachable, and no object of it lives here.
    expect(gitIn(shadow.rootPath, 'log', '--oneline', '-1', 'refs/remotes/user/main')).toContain(
      'one',
    );
    expect(objectCount(join(shadow.rootPath, 'objects'))).toBe(0);
  });

  it('returns the existing clone on a second call rather than building it again', async () => {
    const first = await ensureShadow(repo, { runner, dataDir, repoId });

    const { runner: spy, calls } = recording();
    const second = await ensureShadow(repo, { runner: spy, dataDir, repoId });

    expect(second).toEqual(first);
    // `init` is the whole question: a second creation would discard whatever
    // the first left, which later holds incremental analyzer state.
    expect(calls.map((argv) => argv[0])).not.toContain('init');
  });

  it('brings across work committed since the last call', async () => {
    await ensureShadow(repo, { runner, dataDir, repoId });

    writeFileSync(join(dir, 'b.txt'), 'two\n');
    git('add', '-A');
    git('commit', '-qm', 'two');
    const shadow = await ensureShadow(repo, { runner, dataDir, repoId });

    expect(gitIn(shadow.rootPath, 'log', '--oneline', '-1', 'refs/remotes/user/main')).toContain(
      'two',
    );
  });

  it('keeps the user branches in their own namespace', async () => {
    git('branch', 'feature');
    const shadow = await ensureShadow(repo, { runner, dataDir, repoId });

    expect(shadowRefs(shadow.rootPath).sort()).toEqual([
      'refs/remotes/user/feature',
      'refs/remotes/user/main',
    ]);
    // Nothing under `refs/heads/`: those names belong to the speculative work
    // this clone exists to do, and a fetch writing them would collide.
    expect(shadowRefs(shadow.rootPath).some((ref) => ref.startsWith('refs/heads/'))).toBe(false);
  });

  it('imports no tags', async () => {
    git('tag', 'v1.0');
    const shadow = await ensureShadow(repo, { runner, dataDir, repoId });

    // Fetch follows tags reachable from what it fetched unless told not to, and
    // a tag is a global name: two repositories' `v1.0` are different commits,
    // and nothing here resolves one.
    expect(shadowRefs(shadow.rootPath).filter((ref) => ref.startsWith('refs/tags/'))).toEqual([]);
  });

  it('drops a branch the user deleted', async () => {
    git('branch', 'feature');
    const shadow = await ensureShadow(repo, { runner, dataDir, repoId });
    expect(shadowRefs(shadow.rootPath)).toContain('refs/remotes/user/feature');

    git('branch', '-D', 'feature');
    await ensureShadow(repo, { runner, dataDir, repoId });

    // Without the prune the shadow would keep wanting objects the user's own
    // `gc` is now free to reclaim.
    expect(shadowRefs(shadow.rootPath)).not.toContain('refs/remotes/user/feature');
  });

  it('picks up a branch created since the last call', async () => {
    const shadow = await ensureShadow(repo, { runner, dataDir, repoId });
    git('branch', 'later');

    await ensureShadow(repo, { runner, dataDir, repoId });

    expect(shadowRefs(shadow.rootPath)).toContain('refs/remotes/user/later');
  });

  it('recovers when the user collects an object only the shadow still names', async () => {
    git('checkout', '-qb', 'feature');
    writeFileSync(join(dir, 'f.txt'), 'only on feature\n');
    git('add', '-A');
    git('commit', '-qm', 'feature');
    git('checkout', '-q', 'main');
    const shadow = await ensureShadow(repo, { runner, dataDir, repoId });

    // The user's `gc` cannot know the shadow borrows its objects, so a branch
    // deleted between refreshes leaves the shadow naming a commit that is gone.
    git('branch', '-D', 'feature');
    git('reflog', 'expire', '--expire=now', '--all');
    git('gc', '-q', '--prune=now');

    await ensureShadow(repo, { runner, dataDir, repoId });

    expect(shadowRefs(shadow.rootPath)).toEqual(['refs/remotes/user/main']);
  });

  describe('a linked worktree', () => {
    let linked: string;

    beforeEach(() => {
      git('branch', 'feature');
      linked = join(base, 'linked');
      git('worktree', 'add', '-q', linked, 'feature');
    });

    it('borrows the shared object store, not the worktree administrative dir', async () => {
      const worktreeRepo: UserRepo = {
        kind: 'user',
        rootPath: linked,
        // What a linked worktree's handle actually names: it holds `HEAD` and
        // no objects at all.
        gitDir: join(dir, '.git', 'worktrees', 'linked'),
      };

      const shadow = await ensureShadow(worktreeRepo, { runner, dataDir, repoId });

      expect(alternatesOf(shadow.rootPath)).toBe(realpathSync(join(dir, '.git', 'objects')));
      expect(alternatesOf(shadow.rootPath)).not.toContain('worktrees');
    });

    it('reaches history that only the shared store holds', async () => {
      const worktreeRepo: UserRepo = {
        kind: 'user',
        rootPath: linked,
        gitDir: join(dir, '.git', 'worktrees', 'linked'),
      };

      const shadow = await ensureShadow(worktreeRepo, { runner, dataDir, repoId });

      expect(gitIn(shadow.rootPath, 'log', '--oneline', '-1', 'refs/remotes/user/main')).toContain(
        'one',
      );
      expect(objectCount(join(shadow.rootPath, 'objects'))).toBe(0);
    });
  });

  describe('object format', () => {
    let wide: string;
    let wideRepo: UserRepo;

    beforeEach(() => {
      wide = join(base, 'sha256');
      execFileSync('git', ['init', '-q', '--object-format=sha256', '-b', 'main', wide], {
        stdio: 'pipe',
      });
      gitIn(wide, 'config', 'user.name', 'Interlock Test');
      gitIn(wide, 'config', 'user.email', 'test@example.invalid');
      gitIn(wide, 'config', 'maintenance.auto', 'false');
      gitIn(wide, 'config', 'gc.auto', '0');
      writeFileSync(join(wide, 'a.txt'), 'one\n');
      gitIn(wide, 'add', '-A');
      gitIn(wide, 'commit', '-qm', 'one');
      wideRepo = { kind: 'user', rootPath: wide, gitDir: join(wide, '.git') };
    });

    it('mirrors a sha256 repository in its own format', async () => {
      const shadow = await ensureShadow(wideRepo, { runner, dataDir, repoId });

      // git refuses to fetch across formats, so a clone made in the default
      // one could never be refreshed from this repository at all.
      expect(gitIn(shadow.rootPath, 'rev-parse', '--show-object-format').trim()).toBe('sha256');
      expect(gitIn(shadow.rootPath, 'rev-parse', 'refs/remotes/user/main').trim()).toMatch(
        /^[0-9a-f]{64}$/u,
      );
      expect(objectCount(join(shadow.rootPath, 'objects'))).toBe(0);
    });

    it('rebuilds a clone left in the wrong format rather than failing on it forever', async () => {
      // The exact state an earlier build left behind: bare, borrowing the right
      // store, and unable to fetch from it. Every check but the format passes.
      const shadowPath = shadowPathFor(repoId, dataDir);
      mkdirSync(shadowPath, { recursive: true });
      execFileSync('git', ['init', '-q', '--bare', '--object-format=sha1', shadowPath], {
        stdio: 'pipe',
      });
      writeFileSync(
        join(shadowPath, 'objects', 'info', 'alternates'),
        `${realpathSync(join(wide, '.git', 'objects'))}\n`,
      );

      const shadow = await ensureShadow(wideRepo, { runner, dataDir, repoId });

      expect(gitIn(shadow.rootPath, 'rev-parse', '--show-object-format').trim()).toBe('sha256');
    });

    it('refuses a format it does not know rather than passing it to init', async () => {
      // No git in use produces one today, so the answer is rewritten: this is
      // the git that ships a third hash function before this code learns it.
      const future: GitRunner = {
        run: async (target, args, options) => {
          const result = await runner.run(target, args, options);
          return args.includes('--show-object-format') && target.kind === 'user'
            ? { ...result, stdout: result.stdout.replace(/^sha1/u, 'sha512') }
            : result;
        },
      };

      const error = await rejection(ensureShadow(repo, { runner: future, dataDir, repoId }));

      expect(error.code).toBe('TOOLCHAIN_UNSUPPORTED');
      expect(existsSync(shadowPathFor(repoId, dataDir))).toBe(false);
    });
  });

  describe('concurrent callers', () => {
    it('build one clone between them, and all of them get it', async () => {
      const { runner: spy, calls } = recording();

      const shadows = await Promise.all(
        [1, 2, 3, 4].map(() => ensureShadow(repo, { runner: spy, dataDir, repoId })),
      );

      // Interleaved, these deleted each other's half-built clone: most failed
      // on `init` or `config` in a directory another call had just removed.
      expect(calls.filter((argv) => argv[0] === 'init')).toHaveLength(1);
      expect(calls.filter((argv) => argv[0] === 'fetch')).toHaveLength(1);
      for (const shadow of shadows) expect(shadow).toEqual(shadows[0]);
    });

    it('starts a fresh refresh once the joined one has settled', async () => {
      await Promise.all([1, 2].map(() => ensureShadow(repo, { runner, dataDir, repoId })));
      writeFileSync(join(dir, 'b.txt'), 'two\n');
      git('add', '-A');
      git('commit', '-qm', 'two');

      const shadow = await ensureShadow(repo, { runner, dataDir, repoId });

      // A settled refresh handed to every later caller would pin the shadow to
      // the moment of its first call.
      expect(gitIn(shadow.rootPath, 'log', '--oneline', '-1', 'refs/remotes/user/main')).toContain(
        'two',
      );
    });

    it('lets a later call retry after a joined one failed', async () => {
      const late = join(base, 'late');
      const lateRepo: UserRepo = { kind: 'user', rootPath: late, gitDir: join(late, '.git') };
      const failed = await Promise.allSettled(
        [1, 2].map(() => ensureShadow(lateRepo, { runner, dataDir, repoId })),
      );
      expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected']);

      execFileSync('git', ['init', '-q', '-b', 'main', late], { stdio: 'pipe' });
      gitIn(late, 'config', 'user.name', 'Interlock Test');
      gitIn(late, 'config', 'user.email', 'test@example.invalid');
      gitIn(late, 'commit', '-q', '--allow-empty', '-m', 'one');

      const shadow = await ensureShadow(lateRepo, { runner, dataDir, repoId });

      expect(shadowRefs(shadow.rootPath)).toContain('refs/remotes/user/main');
    });
  });

  describe('recovery', () => {
    it('rebuilds a directory a crash left behind', async () => {
      const shadowPath = shadowPathFor(repoId, dataDir);
      mkdirSync(shadowPath, { recursive: true });
      // What a clone interrupted partway through looks like: the name is taken
      // and there is no repository under it.
      writeFileSync(join(shadowPath, 'half-written'), 'x');

      const shadow = await ensureShadow(repo, { runner, dataDir, repoId });

      expect(existsSync(join(shadowPath, 'half-written'))).toBe(false);
      expect(shadowRefs(shadow.rootPath)).toContain('refs/remotes/user/main');
    });

    it('rebuilds a clone borrowing a different repository', async () => {
      const shadow = await ensureShadow(repo, { runner, dataDir, repoId });
      const other = join(base, 'other');
      execFileSync('git', ['init', '-q', '-b', 'main', other], { stdio: 'pipe' });
      writeFileSync(
        join(shadow.rootPath, 'objects', 'info', 'alternates'),
        `${realpathSync(join(other, '.git', 'objects'))}\n`,
      );

      await ensureShadow(repo, { runner, dataDir, repoId });

      // Reachability is the point: a clone pointed at the wrong store answers
      // about a repository nobody asked about.
      expect(alternatesOf(shadow.rootPath)).toBe(realpathSync(join(dir, '.git', 'objects')));
    });

    it('replaces a file sitting where the clone belongs', async () => {
      const shadowPath = shadowPathFor(repoId, dataDir);
      mkdirSync(join(dataDir, 'shadows'), { recursive: true });
      writeFileSync(shadowPath, 'not a directory');

      const shadow = await ensureShadow(repo, { runner, dataDir, repoId });

      expect(statSync(shadow.rootPath).isDirectory()).toBe(true);
      expect(shadowRefs(shadow.rootPath)).toContain('refs/remotes/user/main');
    });

    it('rebuilds a clone that is not bare', async () => {
      const shadowPath = shadowPathFor(repoId, dataDir);
      mkdirSync(shadowPath, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main', shadowPath], { stdio: 'pipe' });

      const shadow = await ensureShadow(repo, { runner, dataDir, repoId });

      expect(gitIn(shadow.rootPath, 'rev-parse', '--is-bare-repository').trim()).toBe('true');
      expect(shadowRefs(shadow.rootPath)).toContain('refs/remotes/user/main');
    });

    it('rebuilds a clone whose config says it is no longer bare', async () => {
      const shadow = await ensureShadow(repo, { runner, dataDir, repoId });
      // `--is-bare-repository` answers from config, so a clone can stop being
      // bare without moving a file — and `git worktree add` behaves differently
      // against one that is not.
      gitIn(shadow.rootPath, 'config', 'core.bare', 'false');

      await ensureShadow(repo, { runner, dataDir, repoId });

      expect(gitIn(shadow.rootPath, 'rev-parse', '--is-bare-repository').trim()).toBe('true');
    });

    it('refuses to delete outside the data dir when the id escapes its directory', async () => {
      const outside = join(base, 'outside');
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'precious.txt'), "not Interlock's\n");
      // The id is a branded string, and a branded string is a claim rather than
      // a guarantee once one has been through the API and back.
      const escaping = '../../outside' as RepoId;

      const error = await rejection(ensureShadow(repo, { runner, dataDir, repoId: escaping }));

      expect(error.code).toBe('SHADOW_UNAVAILABLE');
      expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
    });

    it('rebuilds a bare clone that borrows nothing at all', async () => {
      const shadow = await ensureShadow(repo, { runner, dataDir, repoId });
      // A creation interrupted after `init` and before the alternates file:
      // a real repository that can reach none of the user's history.
      rmSync(join(shadow.rootPath, 'objects', 'info', 'alternates'));

      await ensureShadow(repo, { runner, dataDir, repoId });

      expect(alternatesOf(shadow.rootPath)).toBe(realpathSync(join(dir, '.git', 'objects')));
    });

    it('refuses a repository whose object store is gone', async () => {
      rmSync(join(dir, '.git', 'objects'), { recursive: true, force: true });

      const error = await rejection(ensureShadow(repo, { runner, dataDir, repoId }));

      // Git's own discovery requires `objects/` and `refs/`, so it refuses the
      // directory before anything here asks it a question — which is why
      // resolving the object store is a typed-error boundary rather than a
      // check that fires.
      expect(error.code).toBe('GIT_COMMAND_FAILED');
    });

    it('refuses a repository that is not on disk', async () => {
      const gone: UserRepo = {
        kind: 'user',
        rootPath: join(base, 'never-existed'),
        gitDir: join(base, 'never-existed', '.git'),
      };

      const error = await rejection(ensureShadow(gone, { runner, dataDir, repoId }));

      // Named rather than reported as a git failure: a repository that moved is
      // a property of the machine, and the remedy is a different one.
      expect(error.code).toBe('REPO_NOT_FOUND');
      expect(error.remedy).toBeDefined();
    });

    it('refuses a directory that is not a git repository', async () => {
      const plain = join(base, 'plain');
      mkdirSync(plain, { recursive: true });
      const notGit: UserRepo = { kind: 'user', rootPath: plain, gitDir: join(plain, '.git') };

      const error = await rejection(ensureShadow(notGit, { runner, dataDir, repoId }));

      expect(error.code).toBe('GIT_COMMAND_FAILED');
    });
  });

  it('keeps its directories owner-only', async () => {
    const shadow = await ensureShadow(repo, { runner, dataDir, repoId });

    // Both levels: `shadows/` is created by the same call and holds every
    // clone, so a loose mode there exposes all of them.
    expect(statSync(shadow.rootPath).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, 'shadows')).mode & 0o777).toBe(0o700);
  });

  it('can author a commit, which needs an identity nothing else can supply', async () => {
    const shadow = await ensureShadow(repo, { runner, dataDir, repoId });
    const tree = gitIn(shadow.rootPath, 'rev-parse', 'refs/remotes/user/main^{tree}').trim();

    // The runner strips inherited `GIT_*`, neutralises global config and
    // refuses a caller's `-c`, so an identity in the clone's own config is the
    // only channel left — and snapshot commits are the next thing built on it.
    const commit = gitIn(shadow.rootPath, 'commit-tree', tree, '-m', 'speculative').trim();
    expect(commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(gitIn(shadow.rootPath, 'log', '--format=%an <%ae>', '-1', commit).trim()).toBe(
      'Interlock <interlock@interlock.invalid>',
    );
  });

  it('is the handle mutating commands are accepted against', async () => {
    const shadow = await ensureShadow(repo, { runner, dataDir, repoId });

    // The type split is a compile-time guarantee; this is the runtime half of
    // it, and what makes the returned handle worth having.
    const refused = await rejection(runner.run(repo, ['update-ref', 'refs/heads/x', 'HEAD']));
    expect(refused.code).toBe('GIT_COMMAND_REFUSED');
    expect(shadow.kind).toBe('shadow');
    expect(shadow.originPath).toBe(dir);
  });
});
