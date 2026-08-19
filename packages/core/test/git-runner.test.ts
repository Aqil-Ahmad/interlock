import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, isInterlockError } from '@interlock/shared';
import type { InterlockError, LogRecord } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitRunner } from '../src/git/repo-handle.js';
import type { ShadowRepo, UserRepo } from '../src/git/repo-handle.js';

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

/**
 * Exercises the git runner against a real repository.
 *
 * A mocked runner would only prove the mock works. Everything that matters here
 * — argument injection, environment sanitisation, how git reports a non-zero
 * exit — is a property of the real binary.
 */
describe('git runner against a real repository', () => {
  let dir: string;
  let repo: UserRepo;
  let shadow: ShadowRepo;
  const runner = createGitRunner();

  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'interlock-git-'));
    // Explicit branch name and identity: CI has neither a default branch
    // preference nor a global git user, and `commit` fails without one.
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
    git('config', 'user.name', 'Interlock Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    git('add', '-A');
    git('commit', '-qm', 'initial');

    repo = { kind: 'user', rootPath: dir, gitDir: join(dir, '.git') };
    shadow = { kind: 'shadow', rootPath: dir, gitDir: join(dir, '.git'), originPath: dir };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs a read command and returns its output', async () => {
    const result = await runner.run(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('main');
    expect(result.stderr).toBe('');
  });

  it('reports a non-zero exit as a result, not an exception', async () => {
    // `merge-tree` signals a conflict this way, so a throw here would turn every
    // detected conflict into an error.
    const result = await runner.run(repo, ['rev-parse', '--verify', 'refs/heads/absent']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toBe('');
  });

  it('passes an argument that looks like a flag through as a literal', async () => {
    const marker = join(dir, 'pwned');
    // git refuses to create a ref whose name begins with `-`, so the injection
    // is exercised the way it would actually arrive: as an argument value.
    const result = await runner.run(repo, [
      'rev-parse',
      '--verify',
      `--upload-pack=touch ${marker}`,
    ]);

    expect(existsSync(marker)).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it('passes shell metacharacters through as literals', async () => {
    const marker = join(dir, 'shell-ran');
    await runner.run(repo, ['rev-parse', `; touch ${marker}`]);
    await runner.run(repo, ['rev-parse', `$(touch ${marker})`]);
    await runner.run(repo, ['rev-parse', `\`touch ${marker}\``]);

    expect(existsSync(marker)).toBe(false);
  });

  it('ignores GIT_ variables inherited from the environment', async () => {
    const decoy = mkdtempSync(join(tmpdir(), 'interlock-decoy-'));
    // stubEnv restores on teardown, so a failure here cannot leak into another test.
    vi.stubEnv('GIT_DIR', decoy);
    try {
      const result = await runner.run(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('main');
    } finally {
      vi.unstubAllEnvs();
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  it('returns output verbatim so callers can parse it', async () => {
    const token = 'ghp_0123456789abcdefghij0123456789';
    writeFileSync(join(dir, 'leak.txt'), `${token}\n`);
    git('add', '-A');
    git('commit', '-qm', 'leak');

    // Rewriting output here would corrupt object ids and paths that happen to
    // match a secret pattern, and every downstream parser reads this string.
    const result = await runner.run(repo, ['show', 'HEAD:leak.txt']);
    expect(result.stdout.trim()).toBe(token);
  });

  it('redacts secrets from what it logs', async () => {
    const token = 'ghp_0123456789abcdefghij0123456789';
    const records: LogRecord[] = [];
    const logging = createGitRunner({
      logger: createLogger('test', { level: 'trace', sink: (record) => records.push(record) }),
    });

    await logging.run(repo, ['rev-parse', '--verify', token]);

    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain(token);
  });

  it('stages into an overridden index without touching the repository index', async () => {
    const indexBefore = readFileSync(join(dir, '.git', 'index'));
    const indexDir = mkdtempSync(join(tmpdir(), 'interlock-index-'));
    const tempIndex = join(indexDir, 'index');
    writeFileSync(join(dir, 'b.txt'), 'staged elsewhere\n');

    try {
      const added = await runner.run(shadow, ['add', '-A'], { indexFile: tempIndex });
      expect(added.exitCode).toBe(0);

      const tree = await runner.run(shadow, ['write-tree'], { indexFile: tempIndex });
      expect(tree.exitCode).toBe(0);
      expect(tree.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);

      expect(readFileSync(join(dir, '.git', 'index'))).toEqual(indexBefore);
    } finally {
      rmSync(indexDir, { recursive: true, force: true });
    }
  });

  it('kills a command that outlives its timeout', async () => {
    const scriptDir = mkdtempSync(join(tmpdir(), 'interlock-slow-'));
    const fakeGit = join(scriptDir, 'git');
    writeFileSync(fakeGit, '#!/bin/sh\nsleep 30\n');
    chmodSync(fakeGit, 0o755);

    try {
      const slow = createGitRunner({ gitPath: fakeGit, timeoutMs: 100 });
      const startedAt = Date.now();
      const error = await rejection(slow.run(repo, ['status']));
      expect(error.code).toBe('GIT_COMMAND_FAILED');
      expect(error.infra).toBe(true);
      // Proves it was killed rather than waited out.
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      rmSync(scriptDir, { recursive: true, force: true });
    }
  });

  it('reports a missing git binary as an infrastructure failure', async () => {
    const missing = createGitRunner({ gitPath: join(dir, 'no-such-git') });
    const error = await rejection(missing.run(repo, ['status']));
    expect(error.code).toBe('GIT_COMMAND_FAILED');
    expect(error.infra).toBe(true);
    expect(error.remedy).toContain('PATH');
  });

  it('treats an attached global flag as a literal, because git rejects that form', async () => {
    // `git -C/path` and `git -cfoo=bar` are not valid: a global flag takes its
    // value as a separate argument. The reserved-flag check therefore matches
    // whole arguments and does not need to parse attached prefixes.
    const result = await runner.run(repo, [`-C${dir}`, 'rev-parse', 'HEAD']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('unknown option');
  });

  it('runs a command that has no subcommand', async () => {
    const result = await runner.run(repo, ['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('git version');
  });

  it('reports a git path that is not executable', async () => {
    const notExecutable = join(dir, 'not-executable');
    writeFileSync(notExecutable, 'not a program\n');
    chmodSync(notExecutable, 0o644);

    const broken = createGitRunner({ gitPath: notExecutable });
    const error = await rejection(broken.run(repo, ['status']));
    expect(error.code).toBe('GIT_COMMAND_FAILED');
    expect(error.infra).toBe(true);
  });

  it('reports output larger than the buffer instead of truncating it silently', async () => {
    const tiny = createGitRunner({ maxBufferBytes: 16 });
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(4096));
    git('add', '-A');
    git('commit', '-qm', 'big');

    const error = await rejection(tiny.run(repo, ['show', 'HEAD:big.txt']));
    expect(error.code).toBe('GIT_COMMAND_FAILED');
    expect(error.infra).toBe(true);
  });
});
