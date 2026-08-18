import { describe, expect, it } from 'vitest';
import { isInterlockError } from '@interlock/shared';
import type { InterlockError } from '@interlock/shared';
import { createGitRunner, isMutatingCommand, MUTATING_GIT_COMMANDS } from './repo-handle.js';
import type { ShadowRepo, UserRepo } from './repo-handle.js';

/**
 * Await a rejection and narrow it, so assertions run against a typed error
 * rather than an untyped matcher — the error type is part of the contract.
 */
async function rejection(promise: Promise<unknown>): Promise<InterlockError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!isInterlockError(error)) {
    throw new Error(`expected an InterlockError, got: ${String(error)}`);
  }
  return error;
}

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

  it.each(MUTATING_GIT_COMMANDS)('refuses `git %s` against a user repo', async (command) => {
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
