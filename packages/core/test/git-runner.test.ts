import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createLogger } from '@interlock/shared';
import type { LogRecord } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitRunner, SAFE_FLAGS } from '../src/git/repo-handle.js';
import type { ShadowRepo, UserRepo } from '../src/git/repo-handle.js';
import { rejection } from './support/rejection.js';

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
    // One argv word, so this does not distinguish a shell from no shell — the
    // metacharacter test above does that. What it pins is that an unknown flag
    // reaches git verbatim and is rejected there, rather than being filtered,
    // rewritten or split by the runner on the way.
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

  it('stages a user repo into an overridden index, leaving its own index alone', async () => {
    const indexBefore = readFileSync(join(dir, '.git', 'index'));
    const indexDir = mkdtempSync(join(tmpdir(), 'interlock-index-'));
    const tempIndex = join(indexDir, 'index');
    writeFileSync(join(dir, 'b.txt'), 'staged elsewhere\n');

    try {
      // A UserRepo on purpose: staging without disturbing the user's index is
      // exactly what this capability exists for, and a shadow would not test it.
      const added = await runner.run(repo, ['add', '-A'], { indexFile: tempIndex });
      expect(added.exitCode).toBe(0);

      const tree = await runner.run(repo, ['write-tree'], { indexFile: tempIndex });
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
      // Every infrastructure failure carries this code and flag, so pin the branch.
      expect(error.message).toContain('did not finish within');
      expect(error.details.timeoutMs).toBe(100);
      // Proves it was killed rather than waited out.
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      rmSync(scriptDir, { recursive: true, force: true });
    }
  });

  it('refuses to stage a user repo through its own index', async () => {
    const before = readFileSync(join(dir, '.git', 'index'));
    const error = await rejection(
      runner.run(repo, ['add', '-A'], { indexFile: join(dir, '.git', 'index') }),
    );
    expect(error.message).toContain('resolves inside');
    expect(readFileSync(join(dir, '.git', 'index'))).toEqual(before);
  });

  it('refuses an index redirection that resolves back into the repository', async () => {
    // A symlink is enough: `resolve` normalises a path, it does not follow one.
    const linkDir = mkdtempSync(join(tmpdir(), 'interlock-link-'));
    const link = join(linkDir, 'outside');
    symlinkSync(join(dir, '.git'), link);
    const before = readFileSync(join(dir, '.git', 'index'));
    writeFileSync(join(dir, 'c.txt'), 'staged through a symlink\n');

    try {
      const error = await rejection(
        runner.run(repo, ['add', '-A'], { indexFile: join(link, 'index') }),
      );
      expect(error.message).toContain('resolves inside');
      expect(readFileSync(join(dir, '.git', 'index'))).toEqual(before);
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it('refuses a redirection reached by a different alias of the repository path', async () => {
    // `tmpdir()` on macOS returns a path whose real path differs, so a handle
    // and an indexFile can name the same file and compare as different.
    const real = realpathSync(dir);
    const aliased: UserRepo = { kind: 'user', rootPath: real, gitDir: join(real, '.git') };
    const before = readFileSync(join(real, '.git', 'index'));

    const error = await rejection(
      runner.run(aliased, ['add', '-A'], { indexFile: join(dir, '.git', 'index') }),
    );
    expect(error.message).toContain('resolves inside');
    expect(readFileSync(join(real, '.git', 'index'))).toEqual(before);
  });

  it('refuses read-tree -u, which no index redirection protects', async () => {
    const indexDir = mkdtempSync(join(tmpdir(), 'interlock-index-'));
    writeFileSync(join(dir, 'a.txt'), 'uncommitted work\n');

    try {
      const error = await rejection(
        runner.run(repo, ['read-tree', '-u', '--reset', 'HEAD'], {
          indexFile: join(indexDir, 'index'),
        }),
      );
      expect(error.message).toContain('mutating');
      // `-u` writes the working tree, so the index guard never sees the damage.
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('uncommitted work\n');
    } finally {
      rmSync(indexDir, { recursive: true, force: true });
    }
  });

  it('refuses read-tree --index-output, which overrides the redirection', async () => {
    const indexDir = mkdtempSync(join(tmpdir(), 'interlock-index-'));
    writeFileSync(join(dir, 'staged.txt'), 'staged\n');
    git('add', 'staged.txt');
    const before = readFileSync(join(dir, '.git', 'index'));

    try {
      const error = await rejection(
        runner.run(repo, ['read-tree', `--index-output=${join(dir, '.git', 'index')}`, 'HEAD'], {
          indexFile: join(indexDir, 'index'),
        }),
      );
      expect(error.message).toContain('mutating');
      expect(readFileSync(join(dir, '.git', 'index'))).toEqual(before);
    } finally {
      rmSync(indexDir, { recursive: true, force: true });
    }
  });

  it('refuses symbolic-ref -d, which reads like its one-operand reading form', async () => {
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

    const error = await rejection(
      runner.run(repo, ['symbolic-ref', '-d', 'refs/remotes/origin/HEAD']),
    );
    expect(error.message).toContain('mutating');

    const still = await runner.run(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    expect(still.stdout.trim()).toBe('refs/remotes/origin/main');
  });

  it('refuses an abbreviated --index-output, which git resolves and a guard may not', async () => {
    // Git accepts any unambiguous prefix, so `--i=` is `--index-output=`.
    writeFileSync(join(dir, 'staged.txt'), 'staged\n');
    git('add', 'staged.txt');
    const before = readFileSync(join(dir, '.git', 'index'));
    const indexDir = mkdtempSync(join(tmpdir(), 'interlock-index-'));

    try {
      const error = await rejection(
        runner.run(repo, ['read-tree', `--i=${join(dir, '.git', 'index')}`, 'HEAD'], {
          indexFile: join(indexDir, 'index'),
        }),
      );
      expect(error.message).toContain('mutating');
      expect(readFileSync(join(dir, '.git', 'index'))).toEqual(before);
    } finally {
      rmSync(indexDir, { recursive: true, force: true });
    }
  });

  it('refuses update-index --split-index, which writes into the git directory', async () => {
    // The shared index lands in `$GIT_DIR` whatever `GIT_INDEX_FILE` says.
    const indexDir = mkdtempSync(join(tmpdir(), 'interlock-index-'));

    try {
      const error = await rejection(
        runner.run(repo, ['update-index', '--split-index'], {
          indexFile: join(indexDir, 'index'),
        }),
      );
      expect(error.message).toContain('mutating');
      expect(readdirSync(join(dir, '.git')).some((entry) => entry.startsWith('sharedindex'))).toBe(
        false,
      );
    } finally {
      rmSync(indexDir, { recursive: true, force: true });
    }
  });

  it('refuses an index redirected at the git directory a linked worktree shares', async () => {
    // The handle names the worktree and `.git/worktrees/<name>`, neither of
    // which contains the index this redirection would overwrite.
    const worktree = join(dir, '..', `${basename(dir)}-wt`);
    git('branch', 'side');
    git('worktree', 'add', '-q', worktree, 'side');
    const gitDir = execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
    }).trim();
    const linked: UserRepo = { kind: 'user', rootPath: realpathSync(worktree), gitDir };
    const before = readFileSync(join(dir, '.git', 'index'));

    try {
      const error = await rejection(
        runner.run(linked, ['add', '-A'], { indexFile: join(dir, '.git', 'index') }),
      );
      expect(error.message).toContain('resolves inside');
      expect(readFileSync(join(dir, '.git', 'index'))).toEqual(before);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('returns promptly from a command that reads stdin', async () => {
    // Nothing writes to the child. Without an explicit EOF this blocks until the
    // timeout kills it, so the assertion is the elapsed time as much as the hash.
    const startedAt = Date.now();
    const result = await runner.run(repo, ['hash-object', '--stdin']);

    expect(result.exitCode).toBe(0);
    // The empty blob: git read stdin, got EOF, and hashed nothing.
    expect(result.stdout.trim()).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('refuses an index redirected to a sibling whose name begins with two dots', async () => {
    // `relative()` returns `..bak` here, which a `..` prefix test reads as an
    // escape from the very directory the path is inside.
    const before = readFileSync(join(dir, '.git', 'index'));

    const error = await rejection(
      runner.run(repo, ['add', '-A'], { indexFile: join(dir, '..bak') }),
    );
    expect(error.message).toContain('resolves inside');
    expect(existsSync(join(dir, '..bak'))).toBe(false);
    expect(readFileSync(join(dir, '.git', 'index'))).toEqual(before);
  });

  it('does not run a program named by repository-local config', async () => {
    // `core.fsmonitor` is executed during an ordinary `status`. Repository
    // config is the one layer the environment scrubbing cannot reach, so a
    // read command is an arbitrary-execution vector without the `-c` override.
    const spy = join(dir, 'fsmonitor-spy.sh');
    const marker = join(dir, 'fsmonitor-fired');
    writeFileSync(spy, `#!/bin/sh\ntouch '${marker}'\nprintf '/\\0'\n`);
    chmodSync(spy, 0o755);
    git('config', 'core.fsmonitor', spy);
    writeFileSync(join(dir, 'a.txt'), 'dirty\n');

    const result = await runner.run(repo, ['status', '--porcelain']);

    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("does not read the user's global config", async () => {
    // `diff.external` runs a program during an ordinary `diff`, and unlike
    // `core.fsmonitor` no `-c` override neutralises it — so this fails if
    // `GIT_CONFIG_GLOBAL` stops pointing at nowhere, rather than passing on the
    // strength of a different defence.
    const home = mkdtempSync(join(tmpdir(), 'interlock-home-'));
    const spy = join(home, 'spy.sh');
    const marker = join(home, 'global-fired');
    writeFileSync(spy, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(spy, 0o755);
    writeFileSync(join(home, '.gitconfig'), `[diff]\n\texternal = ${spy}\n`);
    writeFileSync(join(dir, 'a.txt'), 'dirty\n');

    vi.stubEnv('HOME', home);
    try {
      const result = await runner.run(repo, ['diff']);
      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes to a shadow repository without running its hooks', async () => {
    // The write path exists for this, and nothing else exercises it: a guard
    // that refused everything rather than only user repos would pass the rest
    // of this suite. A real clone, because a shadow of itself is not a shadow.
    const shadowPath = mkdtempSync(join(tmpdir(), 'interlock-shadow-'));
    execFileSync('git', ['clone', '-q', dir, shadowPath], { stdio: 'pipe' });
    const shadow: ShadowRepo = {
      kind: 'shadow',
      rootPath: shadowPath,
      gitDir: join(shadowPath, '.git'),
      originPath: dir,
    };
    const marker = join(shadowPath, 'hook-fired');
    writeFileSync(
      join(shadowPath, '.git', 'hooks', 'pre-commit'),
      `#!/bin/sh\ntouch '${marker}'\n`,
    );
    chmodSync(join(shadowPath, '.git', 'hooks', 'pre-commit'), 0o755);

    try {
      execFileSync('git', ['-C', shadowPath, 'config', 'user.name', 'Interlock Test'], {
        stdio: 'pipe',
      });
      execFileSync('git', ['-C', shadowPath, 'config', 'user.email', 'test@example.invalid'], {
        stdio: 'pipe',
      });
      writeFileSync(join(shadowPath, 'b.txt'), 'shadow work\n');

      const staged = await runner.run(shadow, ['add', '-A']);
      const committed = await runner.run(shadow, ['commit', '-m', 'speculative']);

      expect(staged.exitCode).toBe(0);
      expect(committed.exitCode).toBe(0);
      const log = await runner.run(shadow, ['log', '--oneline', '-1']);
      expect(log.stdout).toContain('speculative');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(shadowPath, { recursive: true, force: true });
    }
  });

  it('reports a SIGTERM it did not send as a signal death, not a timeout', async () => {
    // `execFile` sends SIGTERM on timeout, so the two look alike from the
    // outside — except that Node sets `killed` only for a kill it issued
    // itself. Reporting an OOM kill as a timeout sends whoever debugs it after
    // an elapsed limit that never elapsed.
    const suicidalGit = join(dir, 'suicidal-git');
    writeFileSync(suicidalGit, '#!/bin/sh\nkill -TERM $$\n');
    chmodSync(suicidalGit, 0o755);

    const patient = createGitRunner({ gitPath: suicidalGit, timeoutMs: 30_000 });
    const startedAt = Date.now();
    const error = await rejection(patient.run(repo, ['status']));

    expect(error.message).toContain('SIGTERM');
    expect(error.message).not.toContain('did not finish');
    expect(error.details.signal).toBe('SIGTERM');
    expect(error.details.timeoutMs).toBeUndefined();
    // The timeout never elapsed, so a report of one would be doubly wrong.
    expect(Date.now() - startedAt).toBeLessThan(30_000);
  });

  it('refuses the plumbing writers that a verb denylist would miss', async () => {
    writeFileSync(join(dir, 'staged.txt'), 'staged\n');
    git('add', 'staged.txt');
    const before = readFileSync(join(dir, '.git', 'index'));

    // Verified against a real repo: this destroys a staged change when allowed.
    const error = await rejection(runner.run(repo, ['read-tree', '--reset', 'HEAD']));
    expect(error.message).toContain('no indexFile was given');
    expect(readFileSync(join(dir, '.git', 'index'))).toEqual(before);

    const refError = await rejection(runner.run(repo, ['update-ref', 'refs/heads/evil', 'HEAD']));
    expect(refError.message).toContain('mutating');
    const branches = await runner.run(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads']);
    expect(branches.stdout).not.toContain('evil');
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
    // Otherwise this still passes if the branch regresses into the generic handler.
    expect(error.message).toContain('more output than the runner buffers');
  });
});

/**
 * Long flags git lists for a verb, with `--[no-]x` recorded under both
 * spellings.
 *
 * Git 2.39 prints `--dry-run` where 2.55 prints `--[no-]dry-run`, so the names
 * have to be read out of the usage rather than matched inside it.
 */
function declaredLongFlags(usage: string): readonly string[] {
  const declared = new Set<string>();
  for (const token of usage.match(/--(?:\[no-\])?[a-zA-Z0-9][a-zA-Z0-9-]*/g) ?? []) {
    if (!token.startsWith('--[no-]')) {
      declared.add(token);
      continue;
    }
    const name = token.slice('--[no-]'.length);
    declared.add(`--${name}`);
    declared.add(`--no-${name}`);
  }
  return [...declared];
}

/** Short flags git lists for a verb, as bare characters. */
function declaredShortFlags(usage: string): readonly string[] {
  return [...usage.matchAll(/(?:^|[\s,])-([a-zA-Z])(?=[\s,]|$)/gm)].map((match) => match[1]!);
}

/**
 * Every name in the allowlist must be a real flag of its verb. Long flags match
 * by prefix, so an invented name would license abbreviations git resolves to
 * something else, and a future git renaming one would widen the allowlist in
 * silence.
 */
describe('the flag allowlist against real git', () => {
  const help = (verb: string): string => {
    try {
      return execFileSync('git', [verb, '-h'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      // `git <verb> -h` exits 129 and may print usage on either stream.
      const failure = error as { stdout?: string; stderr?: string };
      return `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }
  };

  it.each([...SAFE_FLAGS.keys()])('%s declares every flag the guard permits', (verb) => {
    const usage = help(verb);
    const policy = SAFE_FLAGS.get(verb)!;
    const long = declaredLongFlags(usage);
    const short = declaredShortFlags(usage);

    // An empty parse would make every assertion below vacuously true.
    expect(long.length, `${verb} usage parsed no flags`).toBeGreaterThan(0);

    for (const flag of policy.long) {
      expect(long, `${verb} ${flag}`).toContain(flag);
    }
    for (const char of policy.short) {
      expect(short, `${verb} -${char}`).toContain(char);
    }
  });
});
