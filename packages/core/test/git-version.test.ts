import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoId } from '@interlock/shared';
import { ulid } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitRunner, gitVersion } from '../src/git/repo-handle.js';
import type { GitResult, GitRunner, ShadowRepo } from '../src/git/repo-handle.js';
import { ensureShadow } from '../src/git/shadow.js';
import { rejection } from './support/rejection.js';

/** The git version a cached verdict is keyed under, asked of the real git. */
describe('gitVersion', () => {
  let base: string;
  let shadow: ShadowRepo;
  const runner = createGitRunner();

  /** The real runner, counting `version` and answering it as told when told. */
  const counting = (answer?: Partial<GitResult>): { runner: GitRunner; asked: () => number } => {
    let asked = 0;
    return {
      asked: () => asked,
      runner: {
        run: (target, args, options) => {
          if (args[0] === 'version') {
            asked += 1;
            if (answer !== undefined) {
              return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, ...answer });
            }
          }
          return runner.run(target, args, options);
        },
      },
    };
  };

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-version-')));
    const dir = join(base, 'user');
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
    git('config', 'user.name', 'Interlock Test');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'maintenance.auto', 'false');
    git('config', 'gc.auto', '0');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-qm', 'one');
    shadow = await ensureShadow(
      { kind: 'user', rootPath: dir, gitDir: join(dir, '.git') },
      { runner, dataDir: join(base, 'data'), repoId: ulid<RepoId>() },
    );
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('reads the version the git on PATH reports', async () => {
    const reported = execFileSync('git', ['version'], { encoding: 'utf8' });

    expect(`git version ${await gitVersion(runner, shadow)}\n`).toBe(reported);
  });

  it('asks once per runner, however many callers ask', async () => {
    const { runner: once, asked } = counting();

    const answers = await Promise.all([gitVersion(once, shadow), gitVersion(once, shadow)]);
    await gitVersion(once, shadow);

    expect(new Set(answers).size).toBe(1);
    expect(asked()).toBe(1);
  });

  it('asks each runner for itself, since each may invoke another git', async () => {
    const { runner: other, asked } = counting({ stdout: 'git version 9.9.9\n' });

    expect(await gitVersion(other, shadow)).toBe('9.9.9');
    expect(asked()).toBe(1);
  });

  it('refuses output it cannot read, and asks again next time', async () => {
    const { runner: odd, asked } = counting({ stdout: 'something else\n' });

    const error = await rejection(gitVersion(odd, shadow));
    await rejection(gitVersion(odd, shadow));

    expect(error.code).toBe('TOOLCHAIN_UNSUPPORTED');
    expect(error.infra).toBe(true);
    expect(asked()).toBe(2);
  });
});
