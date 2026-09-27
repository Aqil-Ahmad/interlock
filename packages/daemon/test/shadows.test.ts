import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRunner } from '@interlock/core';
import type { GitRunner, UserRepo } from '@interlock/core';
import type { RepoId } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createShadowRegistry } from '../src/shadows.js';

/**
 * The registry resolves each repository's shadow once. `ensureShadow` fetches
 * on every call, so fetches are what this counts: one per resolution.
 */
describe('shadow registry', () => {
  let base: string;
  let repo: UserRepo;
  let fetches: number;
  let failFetch: boolean;
  const real = createGitRunner();
  const repoId = '01JBQ0000000000000000SHDW' as RepoId;

  const runner: GitRunner = {
    run: (target, args, options) => {
      if (args.includes('fetch')) {
        fetches += 1;
        if (failFetch) return Promise.resolve({ stdout: '', stderr: '', exitCode: 128 });
      }
      return real.run(target, args, options);
    },
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-shadows-')));
    const root = join(base, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
    for (const [key, value] of [
      ['user.name', 'Interlock Test'],
      ['user.email', 'test@example.invalid'],
      ['maintenance.auto', 'false'],
      ['gc.auto', '0'],
    ]) {
      execFileSync('git', ['-C', root, 'config', key!, value!]);
    }
    writeFileSync(join(root, 'a.txt'), 'a\n');
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'one']);
    repo = { kind: 'user', rootPath: root, gitDir: join(root, '.git') };
    fetches = 0;
    failFetch = false;
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('resolves a repository’s shadow once and hands the same one out after', async () => {
    const shadows = createShadowRegistry({ runner, dataDir: join(base, 'data') });

    const first = await shadows.get(repo, repoId);
    const second = await shadows.get(repo, repoId);

    expect(second).toBe(first);
    expect(fetches).toBe(1);
  });

  it('does not remember a failure, so the next caller tries again', async () => {
    const shadows = createShadowRegistry({ runner, dataDir: join(base, 'data') });
    failFetch = true;
    await expect(shadows.get(repo, repoId)).rejects.toThrow();

    failFetch = false;
    await expect(shadows.get(repo, repoId)).resolves.toMatchObject({ kind: 'shadow' });
    expect(fetches).toBe(2);
  });

  it('resolves again once told a shadow failed', async () => {
    const shadows = createShadowRegistry({ runner, dataDir: join(base, 'data') });
    await shadows.get(repo, repoId);

    shadows.forget(repoId);
    await shadows.get(repo, repoId);

    expect(fetches).toBe(2);
  });
});
