import { describe, expect, it } from 'vitest';
import { rejection } from '../../test/support/rejection.js';
import {
  classifyCommand,
  createGitRunner,
  isMutatingCommand,
  READ_ONLY_GIT_COMMANDS,
} from './repo-handle.js';
import type { ShadowRepo, UserRepo } from './repo-handle.js';

/**
 * Verbs that modify a repository. Not the implementation's list — the guard is
 * an allowlist — but a corpus that must stay refused, including the plumbing
 * writers whose names do not look like writes.
 */
const DANGEROUS_COMMANDS = [
  'add',
  'am',
  'apply',
  'branch',
  'checkout',
  'cherry-pick',
  'clean',
  'commit',
  'config',
  'fetch',
  'filter-branch',
  'gc',
  'merge',
  'mv',
  'notes',
  'prune',
  'pull',
  'push',
  'read-tree',
  'rebase',
  'reflog',
  'remote',
  'repack',
  'replace',
  'reset',
  'restore',
  'revert',
  'rm',
  'sparse-checkout',
  'stash',
  'submodule',
  'switch',
  'tag',
  'update-index',
  'update-ref',
  'worktree',
];

describe('isMutatingCommand', () => {
  it('flags commands that write repository state', () => {
    expect(isMutatingCommand(['commit', '-m', 'x'])).toBe(true);
    expect(isMutatingCommand(['worktree', 'add', '/tmp/wt'])).toBe(true);
  });

  it('sees through global flags that take a value', () => {
    expect(isMutatingCommand(['-C', '/repo', 'merge', 'feature'])).toBe(true);
    expect(isMutatingCommand(['-c', 'user.name=x', 'commit'])).toBe(true);
    expect(isMutatingCommand(['--git-dir', '/repo/.git', 'status'])).toBe(false);
  });

  it('allows read-only plumbing', () => {
    expect(isMutatingCommand(['rev-parse', 'HEAD'])).toBe(false);
    expect(isMutatingCommand(['status', '--porcelain=v2'])).toBe(false);
    expect(isMutatingCommand(['merge-base', 'a', 'b'])).toBe(false);
    expect(isMutatingCommand(['diff', '--name-only'])).toBe(false);
  });
});

describe('createGitRunner refusals', () => {
  const userRepo: UserRepo = { kind: 'user', rootPath: '/repo', gitDir: '/repo/.git' };
  const shadowRepo: ShadowRepo = {
    kind: 'shadow',
    rootPath: '/shadow',
    gitDir: '/shadow/.git',
    originPath: '/repo',
  };
  // A path that cannot exist, so a refusal is proven by the rejection reason
  // rather than by git happening to fail afterwards.
  const runner = createGitRunner({ gitPath: '/nonexistent/git' });

  it.each(DANGEROUS_COMMANDS)('refuses `git %s` against a user repo', async (command) => {
    const error = await rejection(runner.run(userRepo, [command]));
    expect(error.code).toBe('GIT_COMMAND_FAILED');
    // Not an infra failure: a mutation reaching here is a programming error.
    expect(error.infra).toBe(false);
  });

  it('names the shadow route in the remedy rather than just refusing', async () => {
    const error = await rejection(runner.run(userRepo, ['commit', '-m', 'x']));
    expect(error.remedy).toContain('ensureShadow');
  });

  it('allows the same command against a shadow repo', async () => {
    // Reaching the spawn is the assertion: it failed on the missing binary,
    // not on the mutation guard.
    const error = await rejection(runner.run(shadowRepo, ['commit', '-m', 'x']));
    expect(error.infra).toBe(true);
    expect(error.details.gitPath).toBe('/nonexistent/git');
  });

  it.each([
    ['-C', ['-C', '/elsewhere', 'status']],
    ['-c', ['-c', 'core.hooksPath=/evil', 'status']],
    ['--git-dir', ['--git-dir', '/elsewhere/.git', 'status']],
    ['--work-tree', ['--work-tree', '/elsewhere', 'status']],
    ['--exec-path', ['--exec-path=/evil', 'status']],
  ])('refuses a caller-supplied %s', async (_name, args) => {
    const error = await rejection(runner.run(userRepo, args));
    expect(error.code).toBe('GIT_COMMAND_FAILED');
    expect(error.message).toContain('reserved global flag');
  });

  it('leaves subcommand flags of the same name alone', async () => {
    // `-c` after the subcommand is copy detection, not a config override.
    const error = await rejection(runner.run(userRepo, ['log', '-c']));
    expect(error.infra).toBe(true);
  });
});

describe('refusal reporting', () => {
  const userRepo: UserRepo = { kind: 'user', rootPath: '/repo', gitDir: '/repo/.git' };
  const runner = createGitRunner({ gitPath: '/nonexistent/git' });

  it('names the subcommand, not the leading global flag', async () => {
    const error = await rejection(runner.run(userRepo, ['--no-optional-locks', 'commit']));
    expect(error.message).toContain('commit');
    expect(error.details.command).toBe('commit');
  });
});

describe('the allowlist is default-deny', () => {
  it('refuses a command it has never heard of', () => {
    expect(isMutatingCommand(['some-future-porcelain'])).toBe(true);
    expect(classifyCommand(['some-future-porcelain'])).toBe('mutating');
  });

  it('refuses the plumbing writers a denylist misses', () => {
    // Both verified against a real repo: `read-tree --reset` destroyed a staged
    // change, `update-ref` created a branch. Neither reads as a write.
    expect(isMutatingCommand(['read-tree', '--reset', 'HEAD'])).toBe(true);
    expect(isMutatingCommand(['update-ref', 'refs/heads/evil', 'HEAD'])).toBe(true);
    expect(isMutatingCommand(['update-index', '--refresh'])).toBe(true);
  });

  it('allows the read-only plumbing discovery needs', () => {
    for (const verb of ['rev-parse', 'for-each-ref', 'status', 'merge-base', 'diff']) {
      expect(isMutatingCommand([verb])).toBe(false);
    }
    expect(READ_ONLY_GIT_COMMANDS.has('rev-parse')).toBe(true);
  });

  it('classifies index writers apart from other writes', () => {
    expect(classifyCommand(['add', '-A'])).toBe('index-only');
    expect(classifyCommand(['commit', '-m', 'x'])).toBe('mutating');
  });

  it('separates the reading and writing forms of symbolic-ref', () => {
    expect(classifyCommand(['symbolic-ref', '--short', 'HEAD'])).toBe('read-only');
    expect(classifyCommand(['symbolic-ref', 'HEAD', 'refs/heads/evil'])).toBe('mutating');
  });
});

describe('read-only verbs of mutating subcommands', () => {
  it('allows the reporting forms', () => {
    expect(isMutatingCommand(['worktree', 'list', '--porcelain', '-z'])).toBe(false);
    expect(isMutatingCommand(['stash', 'list'])).toBe(false);
    expect(isMutatingCommand(['remote', 'show'])).toBe(false);
  });

  it('still refuses the writing forms', () => {
    expect(isMutatingCommand(['worktree', 'add', '/tmp/wt'])).toBe(true);
    expect(isMutatingCommand(['worktree', 'prune'])).toBe(true);
    expect(isMutatingCommand(['stash', 'push'])).toBe(true);
    expect(isMutatingCommand(['stash'])).toBe(true);
  });

  it('requires the verb to follow the subcommand immediately', () => {
    // A writing flag must not be able to hide behind a read-only verb.
    expect(isMutatingCommand(['worktree', 'add', 'list'])).toBe(true);
  });

  it('does not treat flag-based read-only forms as safe', () => {
    // `git branch --contains X -d Y` deletes, so `--list`-style flags are not
    // recognised; callers wanting those use plumbing instead.
    expect(isMutatingCommand(['branch', '--list'])).toBe(true);
    expect(isMutatingCommand(['config', '--get', 'user.name'])).toBe(true);
  });
});

describe('index redirection', () => {
  const userRepo: UserRepo = { kind: 'user', rootPath: '/repo', gitDir: '/repo/.git' };
  const runner = createGitRunner({ gitPath: '/nonexistent/git' });

  it('refuses an index write with no redirection', async () => {
    const error = await rejection(runner.run(userRepo, ['add', '-A']));
    expect(error.message).toContain('no indexFile was given');
  });

  it('refuses an index redirected back into the repository', async () => {
    // The whole point of the capability is not writing this file.
    const error = await rejection(
      runner.run(userRepo, ['add', '-A'], { indexFile: '/repo/.git/index' }),
    );
    expect(error.message).toContain('resolves inside');
  });

  it('refuses an index inside the working tree', async () => {
    const error = await rejection(
      runner.run(userRepo, ['add', '-A'], { indexFile: '/repo/sub/index' }),
    );
    expect(error.message).toContain('resolves inside');
  });

  it('refuses a relative index path, which resolves against an unknown cwd', async () => {
    const error = await rejection(runner.run(userRepo, ['add', '-A'], { indexFile: 'tmp/index' }));
    expect(error.message).toContain('absolute');
  });

  it('allows an index outside the repository', async () => {
    // Reaching the spawn is the assertion: it failed on the missing binary,
    // not on the guard.
    const error = await rejection(
      runner.run(userRepo, ['add', '-A'], { indexFile: '/elsewhere/index' }),
    );
    expect(error.infra).toBe(true);
    expect(error.details.gitPath).toBe('/nonexistent/git');
  });
});
