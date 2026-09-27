import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitRunner } from '../src/git/repo-handle.js';
import type { GitResult, GitRunner, UserRepo } from '../src/git/repo-handle.js';
import { repositoryDirHolding, repositoryDirsOf } from '../src/git/repo-dirs.js';
import { rejection } from './support/rejection.js';

/**
 * Which directories belong to a user's repository, and whether a path falls in
 * one: the question every refusal of a data dir inside a repository rests on.
 */
describe('repositoryDirHolding', () => {
  let base: string;
  const runner = createGitRunner();

  const gitIn = (where: string, ...args: string[]): string =>
    execFileSync('git', ['-C', where, ...args], { stdio: 'pipe', encoding: 'utf8' });

  const init = (path: string, ...flags: string[]): void => {
    execFileSync('git', ['init', '-q', '-b', 'main', ...flags, path], { stdio: 'pipe' });
    gitIn(
      path,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'one',
    );
  };

  const dirsOf = (rootPath: string): Promise<string[]> =>
    repositoryDirsOf({ kind: 'user', rootPath, gitDir: '' } satisfies UserRepo, runner);

  /** The real runner, recording what it is asked and failing what `fail` picks. */
  const watching = (
    fail: (args: readonly string[]) => boolean = () => false,
  ): { runner: GitRunner; calls: string[][] } => {
    const calls: string[][] = [];
    return {
      calls,
      runner: {
        run: (target, args, options): Promise<GitResult> => {
          calls.push([...args]);
          return fail(args)
            ? Promise.resolve({ exitCode: 128, stdout: '', stderr: 'fatal: injected' })
            : runner.run(target, args, options);
        },
      },
    };
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-repo-dirs-')));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('finds a path outside every repository without asking git', async () => {
    init(join(base, 'repo'));
    const dirs = await dirsOf(join(base, 'repo'));
    const probe = watching();

    expect(await repositoryDirHolding(join(base, 'data'), dirs, probe.runner)).toBeNull();
    expect(probe.calls).toStrictEqual([]);
  });

  it('refuses to read a failed answer from inside a repository as outside', async () => {
    // A detached checkout is found only by asking git, so its failing is the
    // one answer the check cannot do without.
    init(join(base, 'separate'), `--separate-git-dir=${join(base, 'apart.git')}`);
    gitIn(join(base, 'separate'), 'worktree', 'add', '-q', '-b', 'feature', join(base, 'linked'));
    const dirs = await dirsOf(join(base, 'linked'));
    const probe = watching((args) => args.includes('--git-common-dir'));

    const error = await rejection(
      repositoryDirHolding(join(base, 'separate', 'data'), dirs, probe.runner),
    );

    expect(error.code).toBe('GIT_COMMAND_FAILED');
  });

  it('finds the main checkout of a git dir kept apart, which git lists as the git dir', async () => {
    init(join(base, 'separate'), `--separate-git-dir=${join(base, 'apart.git')}`);
    gitIn(join(base, 'separate'), 'worktree', 'add', '-q', '-b', 'feature', join(base, 'linked'));
    const dirs = await dirsOf(join(base, 'linked'));

    expect(dirs).not.toContain(join(base, 'separate'));
    expect(await repositoryDirHolding(join(base, 'separate', 'data'), dirs, runner)).toBe(
      join(base, 'apart.git'),
    );
  });

  it('lets a path inside some other repository through', async () => {
    init(join(base, 'watched'));
    init(join(base, 'other'));
    mkdirSync(join(base, 'other', 'nested'));
    const dirs = await dirsOf(join(base, 'watched'));

    expect(
      await repositoryDirHolding(join(base, 'other', 'nested', 'data'), dirs, runner),
    ).toBeNull();
  });
});
