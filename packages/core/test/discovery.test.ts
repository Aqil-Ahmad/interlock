import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '@interlock/shared';
import type { RepoId } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeRepo, listBranchRefs, mergeBase, openUserRepo } from '../src/git/discovery.js';
import { createGitRunner } from '../src/git/repo-handle.js';
import type { DescribeOptions } from '../src/git/discovery.js';
import type { UserRepo } from '../src/git/repo-handle.js';
import { rejection } from './support/rejection.js';

/**
 * Discovery against a repository in the states that actually occur: several
 * linked worktrees, one detached, one whose directory has been deleted, plus a
 * separate repository with an unborn HEAD.
 */
describe('repo discovery', () => {
  let base: string;
  let root: string;
  let repo: UserRepo;
  const repoId = ulid<RepoId>();
  const options: DescribeOptions = { runner: createGitRunner(), dataDir: '/data' };

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  beforeEach(() => {
    // git reports fully-resolved paths, and on macOS /var is a symlink to
    // /private/var — so the fixture works in canonical form throughout.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-disc-')));
    root = join(base, 'main-repo');
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
    git(root, 'config', 'user.name', 'Interlock Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'a.txt'), 'a\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'one');

    git(root, 'branch', 'feature');
    git(root, 'branch', 'release/1.0');
    git(root, 'worktree', 'add', '-q', join(base, 'wt-feature'), 'feature');
    git(root, 'worktree', 'add', '-q', '--detach', join(base, 'wt-detached'), 'HEAD');
    git(root, 'worktree', 'add', '-q', '-b', 'gone', join(base, 'wt-gone'));
    rmSync(join(base, 'wt-gone'), { recursive: true, force: true });

    repo = { kind: 'user', rootPath: root, gitDir: join(root, '.git') };
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe('openUserRepo', () => {
    it('resolves a linked worktree to the repository that owns it', async () => {
      // Two worktrees of one repository are one repository. Naming them apart
      // would give the store two rows and the pair two shadow clones.
      const viaWorktree = await openUserRepo(join(base, 'wt-feature'), options);
      const viaRoot = await openUserRepo(root, options);

      expect(viaWorktree.kind).toBe('user');
      expect(viaWorktree.rootPath).toBe(viaRoot.rootPath);
      expect(viaWorktree.gitDir).toBe(viaRoot.gitDir);
      expect(viaWorktree.gitDir).not.toContain('worktrees');
    });

    it('resolves a nested subdirectory to the repository root', async () => {
      const nested = join(root, 'some', 'deep', 'path');
      mkdirSync(nested, { recursive: true });

      const opened = await openUserRepo(nested, options);

      expect(opened.rootPath).toBe(root);
    });

    it('rejects a path that does not exist', async () => {
      const error = await rejection(openUserRepo(join(base, 'no-such-dir'), options));
      expect(error.code).toBe('REPO_NOT_FOUND');
    });

    it('rejects a path that is not a repository', async () => {
      const plain = mkdtempSync(join(tmpdir(), 'interlock-plain-'));
      try {
        const error = await rejection(openUserRepo(plain, options));
        expect(error.code).toBe('REPO_NOT_GIT');
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    });

    it('rejects a bare repository, which has no work in flight', async () => {
      const bare = join(base, 'bare.git');
      execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'pipe' });
      const error = await rejection(openUserRepo(bare, options));
      expect(error.code).toBe('REPO_BARE');
    });
  });

  describe('describeRepo', () => {
    it('reads the checked-out branch as the default when there is no remote', async () => {
      const described = await describeRepo(repo, options);
      expect(described.defaultBranch).toBe('main');
      expect(described.rootPath).toBe(root);
      expect(described.shadowPath).toBe(`/data/shadows/${described.id}`);
    });

    it('names the branch HEAD points at, even when it is unborn', async () => {
      // An unborn HEAD still resolves symbolically, so `main` is not a fallback
      // here — a repository initialised on another name reports that name.
      const trunk = join(base, 'trunk-repo');
      execFileSync('git', ['init', '-q', '-b', 'trunk', trunk], { stdio: 'pipe' });

      const described = await describeRepo(
        { kind: 'user', rootPath: trunk, gitDir: join(trunk, '.git') },
        options,
      );
      expect(described.defaultBranch).toBe('trunk');
    });

    it('falls back to main when HEAD names no branch and there is no remote', async () => {
      const described = await describeRepo(
        {
          kind: 'user',
          rootPath: join(base, 'wt-detached'),
          gitDir: join(root, '.git'),
        },
        options,
      );
      expect(described.defaultBranch).toBe('main');
    });

    it('prefers what the remote declares', async () => {
      git(root, 'remote', 'add', 'origin', root);
      git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/feature');
      const described = await describeRepo(repo, options);
      expect(described.defaultBranch).toBe('feature');
    });

    it('includes branches checked out in linked worktrees', async () => {
      const refs = await listBranchRefs(repo, repoId, options);
      const byName = new Map(refs.map((ref) => [ref.name, ref]));

      expect(byName.get('feature')?.worktreePath).toBe(join(base, 'wt-feature'));
      // Checked out in the primary worktree rather than a linked one.
      expect(byName.get('main')?.worktreePath).toBe(root);
      expect(refs.every((ref) => ref.repoId === repoId)).toBe(true);
      expect(refs.every((ref) => ref.ref.startsWith('refs/heads/'))).toBe(true);
    });

    it('skips a worktree whose directory has been deleted', async () => {
      const refs = await listBranchRefs(repo, repoId, options);
      const gone = refs.find((ref) => ref.name === 'gone');
      // The branch still exists; only its unusable worktree is dropped.
      expect(gone).toBeDefined();
      expect(gone?.worktreePath).toBeNull();
    });

    it('reads a staged rename as one destination path', async () => {
      // `-z` emits `R dest\0src\0`, so the source field has to be consumed.
      // Read as a status entry it yields the garbage path `xt` in both lists.
      const worktree = join(base, 'wt-feature');
      git(worktree, 'mv', 'a.txt', 'b.txt');

      const refs = await listBranchRefs(repo, repoId, options);
      const feature = refs.find((ref) => ref.name === 'feature');

      expect(feature?.dirty?.stagedFiles).toEqual(['b.txt']);
      expect(feature?.dirty?.unstagedFiles).toEqual([]);
      expect(feature?.dirty?.untrackedFiles).toEqual([]);
    });

    it('separates a locked missing worktree from an abandoned one', async () => {
      // Both directories are gone. The unlocked one is garbage awaiting
      // `worktree prune` and holds no observable work; the locked one is state
      // someone chose to keep and simply cannot be reached, so it is unknown.
      // Which of `locked` and `prunable` git prints for the first is a
      // porcelain detail, so neither assertion may depend on it.
      git(root, 'branch', 'locked');
      git(root, 'worktree', 'add', '-q', join(base, 'wt-locked'), 'locked');
      git(root, 'worktree', 'lock', join(base, 'wt-locked'));
      rmSync(join(base, 'wt-locked'), { recursive: true, force: true });

      const refs = await listBranchRefs(repo, repoId, options);

      expect(refs.find((ref) => ref.name === 'locked')?.dirty).toBeNull();
      // `gone` is the fixture's unlocked worktree with its directory removed.
      expect(refs.find((ref) => ref.name === 'gone')?.dirty?.isDirty).toBe(false);
      // One unreachable worktree must not take the rest of the repository down.
      expect(refs.find((ref) => ref.name === 'feature')?.dirty?.isDirty).toBe(false);
    });

    it('counts a conflicted path once', async () => {
      // Both status columns are non-blank for an unmerged path, so reading them
      // independently reports the same file as staged and unstaged at once.
      const worktree = join(base, 'wt-feature');
      writeFileSync(join(worktree, 'a.txt'), 'from feature\n');
      git(worktree, 'commit', '-qam', 'feature edit');
      writeFileSync(join(root, 'a.txt'), 'from main\n');
      git(root, 'commit', '-qam', 'main edit');
      try {
        git(worktree, 'merge', 'main');
      } catch {
        // A conflicting merge exits non-zero; the conflict is the fixture.
      }

      const refs = await listBranchRefs(repo, repoId, options);
      const feature = refs.find((ref) => ref.name === 'feature');

      expect(feature?.dirty?.isDirty).toBe(true);
      expect(feature?.dirty?.unstagedFiles).toEqual(['a.txt']);
      expect(feature?.dirty?.stagedFiles).not.toContain('a.txt');
    });

    it('reports dirty state per worktree', async () => {
      writeFileSync(join(base, 'wt-feature', 'staged.txt'), 'staged\n');
      git(join(base, 'wt-feature'), 'add', 'staged.txt');
      writeFileSync(join(base, 'wt-feature', 'a.txt'), 'changed\n');
      writeFileSync(join(base, 'wt-feature', 'untracked.txt'), 'new\n');

      const refs = await listBranchRefs(repo, repoId, options);
      const feature = refs.find((ref) => ref.name === 'feature');

      expect(feature?.dirty?.isDirty).toBe(true);
      expect(feature?.dirty?.stagedFiles).toContain('staged.txt');
      expect(feature?.dirty?.unstagedFiles).toContain('a.txt');
      expect(feature?.dirty?.untrackedFiles).toContain('untracked.txt');
      // Content identity belongs to the snapshot step, not to discovery.
      expect(feature?.dirty?.snapshotId).toBeNull();
    });

    it('reports a clean branch as clean', async () => {
      const refs = await listBranchRefs(repo, repoId, options);
      expect(refs.find((ref) => ref.name === 'main')?.dirty?.isDirty).toBe(false);
    });

    it('honours ignoreBranches globs', async () => {
      const refs = await listBranchRefs(repo, repoId, {
        ...options,
        ignoreBranches: ['release/*'],
      });
      expect(refs.map((ref) => ref.name)).not.toContain('release/1.0');
      expect(refs.map((ref) => ref.name)).toContain('feature');
    });

    it('returns nothing for a repository with an unborn HEAD', async () => {
      const unborn = join(base, 'unborn2');
      execFileSync('git', ['init', '-q', '-b', 'main', unborn], { stdio: 'pipe' });
      const refs = await listBranchRefs(
        { kind: 'user', rootPath: unborn, gitDir: join(unborn, '.git') },
        repoId,
        options,
      );
      expect(refs).toEqual([]);
    });

    it('handles a worktree whose path contains a space', async () => {
      const spaced = join(base, 'wt with space');
      git(root, 'worktree', 'add', '-q', '-b', 'spaced', spaced);
      const refs = await listBranchRefs(repo, repoId, options);
      expect(refs.find((ref) => ref.name === 'spaced')?.worktreePath).toBe(spaced);
    });
  });

  describe('a command that fails', () => {
    it('reports the failure without carrying git stderr into the error', async () => {
      // stderr names branches and paths. `details` is documented as holding
      // neither secrets nor file contents, and the error reaches agents.
      const plain = mkdtempSync(join(tmpdir(), 'interlock-plain-'));
      try {
        const handle: UserRepo = { kind: 'user', rootPath: plain, gitDir: join(plain, '.git') };
        const error = await rejection(listBranchRefs(handle, repoId, options));

        expect(error.code).toBe('GIT_COMMAND_FAILED');
        expect(error.infra).toBe(true);
        expect(error.message).toContain('for-each-ref');
        expect(error.details.command).toBe('for-each-ref');
        expect(error.remedy).not.toContain('fatal:');
        expect(JSON.stringify(error.details)).not.toContain('fatal:');
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    });
  });

  describe('ignoring branches', () => {
    it('matches ? against exactly one character', async () => {
      git(root, 'branch', 'wip');
      git(root, 'branch', 'wipe');

      const refs = await listBranchRefs(repo, repoId, { ...options, ignoreBranches: ['wip?'] });
      const names = refs.map((ref) => ref.name);

      expect(names).toContain('wip');
      expect(names).not.toContain('wipe');
    });

    it('matches * against any run of characters', async () => {
      const refs = await listBranchRefs(repo, repoId, {
        ...options,
        ignoreBranches: ['release/*'],
      });
      expect(refs.map((ref) => ref.name)).not.toContain('release/1.0');
    });

    it.each([
      ['adjacent wildcards', `${'*'.repeat(24)}x`],
      ['wildcards alternating with literals', `${'a*'.repeat(99)}b`],
    ])('does not stall on %s', async (_name, pattern) => {
      // Ignore patterns come from the repository's own config, so they are
      // attacker-supplied, and the match runs on the event loop for every
      // branch. Translated to a regex, the second pattern explores a partition
      // of the name per wildcard: 20 seconds at a third of this length.
      git(root, 'branch', 'a'.repeat(150));

      const startedAt = Date.now();
      await listBranchRefs(repo, repoId, { ...options, ignoreBranches: [pattern] });

      expect(Date.now() - startedAt).toBeLessThan(2_000);
    });

    it('ignores a pattern longer than the cap rather than matching it', async () => {
      const refs = await listBranchRefs(repo, repoId, {
        ...options,
        ignoreBranches: ['*'.repeat(201)],
      });
      expect(refs.map((ref) => ref.name)).toContain('main');
    });
  });

  describe('mergeBase', () => {
    it('finds the common ancestor of two branches', async () => {
      const expected = git(root, 'rev-parse', 'HEAD').trim();
      expect(await mergeBase(repo, 'main', 'feature', options)).toBe(expected);
    });

    it('returns null for branches with no shared history', async () => {
      git(root, 'checkout', '-q', '--orphan', 'unrelated');
      writeFileSync(join(root, 'b.txt'), 'b\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'orphan');
      git(root, 'checkout', '-q', 'main');

      expect(await mergeBase(repo, 'main', 'unrelated', options)).toBeNull();
    });

    it('raises for a ref that does not exist rather than reporting no merge-base', async () => {
      // git exits 1 for no common ancestor and 128 for an unresolvable ref.
      // Collapsing the two drops the pair from analysis in silence.
      const error = await rejection(mergeBase(repo, 'main', 'refs/heads/absent', options));
      expect(error.code).toBe('GIT_COMMAND_FAILED');
      expect(error.infra).toBe(true);
    });
  });
});
