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

    it('rebuilds a clone that is not bare', async () => {
      const shadowPath = shadowPathFor(repoId, dataDir);
      mkdirSync(shadowPath, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main', shadowPath], { stdio: 'pipe' });

      const shadow = await ensureShadow(repo, { runner, dataDir, repoId });

      expect(gitIn(shadow.rootPath, 'rev-parse', '--is-bare-repository').trim()).toBe('true');
      expect(shadowRefs(shadow.rootPath)).toContain('refs/remotes/user/main');
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
