import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { RepoId } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureDirtyState, commitSnapshotInShadow, createGitRunner } from '../src/index.js';
import type { GitResult, GitRunner, ShadowRepo, UserRepo, WorktreeSnapshot } from '../src/index.js';
import { ensureShadow } from '../src/git/shadow.js';
import { rejection } from './support/rejection.js';

/**
 * Uncommitted work turned into commits a merge can take.
 *
 * Every snapshot here is captured into the shadow, because that is the only way
 * one reaches a merge: captured into the user's store instead, its tree is
 * unreferenced there and their `gc` can reap it from under the commit.
 */
describe('commitSnapshotInShadow', () => {
  let base: string;
  let dir: string;
  let dataDir: string;
  let repo: UserRepo;
  let shadow: ShadowRepo;
  const repoId = '01JBQ0000000000000000REPO' as RepoId;
  const runner = createGitRunner();

  const gitIn = (where: string, ...args: string[]): string =>
    execFileSync('git', ['-C', where, ...args], { stdio: 'pipe', encoding: 'utf8' });
  const git = (...args: string[]): string => gitIn(dir, ...args);

  const initRepo = (path: string): void => {
    execFileSync('git', ['init', '-q', '-b', 'main', path], { stdio: 'pipe' });
    gitIn(path, 'config', 'user.name', 'Interlock Test');
    gitIn(path, 'config', 'user.email', 'test@example.invalid');
    // Since git 2.47 `commit` detaches a maintenance process that holds
    // `objects/maintenance.lock` after the commit returns.
    gitIn(path, 'config', 'maintenance.auto', 'false');
    gitIn(path, 'config', 'gc.auto', '0');
  };

  const commitFile = (path: string, name: string, content: string, message: string): void => {
    writeFileSync(join(path, name), content);
    gitIn(path, 'add', '-A');
    gitIn(path, 'commit', '-qm', message);
  };

  /** A capture of `worktree` into the shadow, the way anything merged is taken. */
  const capture = (worktree = dir): Promise<WorktreeSnapshot> =>
    captureDirtyState(worktree, repo, { runner, objectStore: shadow });

  const parentsOf = (commit: string): string[] =>
    gitIn(shadow.rootPath, 'log', '-1', '--format=%P', commit).trim().split(' ').filter(Boolean);

  const treeOf = (commit: string): string =>
    gitIn(shadow.rootPath, 'rev-parse', `${commit}^{tree}`).trim();

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

  beforeEach(async () => {
    // git answers with fully-resolved paths, and on macOS /var is a symlink to
    // /private/var, so the fixture works in canonical form throughout.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-snapshot-')));
    dir = join(base, 'user');
    dataDir = join(base, 'data');
    initRepo(dir);
    commitFile(dir, 'shared.ts', 'export const value = 1;\n', 'one');
    repo = { kind: 'user', rootPath: dir, gitDir: join(dir, '.git') };
    shadow = await ensureShadow(repo, { runner, dataDir, repoId });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('turns two sets of uncommitted edits into commits whose merge conflicts', async () => {
    git('branch', 'feature');
    const linked = join(base, 'feature');
    git('worktree', 'add', '-q', linked, 'feature');
    const refsBefore = git('for-each-ref', '--format=%(refname) %(objectname)');

    // The same line, changed differently on each side, committed on neither.
    writeFileSync(join(dir, 'shared.ts'), 'export const value = 2;\n');
    writeFileSync(join(linked, 'shared.ts'), 'export const value = 3;\n');
    const ours = await commitSnapshotInShadow(shadow, await capture(dir), { runner });
    const theirs = await commitSnapshotInShadow(shadow, await capture(linked), { runner });

    // What the next task builds on: two commit ids `merge-tree` accepts, and
    // the conflict between them visible before anyone has committed anything.
    const merge = spawnSync(
      'git',
      [
        '-C',
        shadow.rootPath,
        'merge-tree',
        '--write-tree',
        '--name-only',
        ours.commitSha,
        theirs.commitSha,
      ],
      { encoding: 'utf8' },
    );
    expect(merge.status).toBe(1);
    expect(merge.stdout).toContain('shared.ts');
    expect(merge.stdout).toContain('CONFLICT (content)');
    expect(git('for-each-ref', '--format=%(refname) %(objectname)')).toBe(refsBefore);
  });

  it('parents the commit on the head the snapshot was taken against', async () => {
    const head = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'shared.ts'), 'export const value = 2;\n');

    const snapshot = await capture();
    const result = await commitSnapshotInShadow(shadow, snapshot, { runner });

    expect(result.treeOid).toBe(snapshot.treeOid);
    expect(treeOf(result.commitSha)).toBe(snapshot.treeOid);
    expect(parentsOf(result.commitSha)).toEqual([head]);
  });

  it('keeps that parent when the branch moves between the capture and the commit', async () => {
    const head = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'shared.ts'), 'export const value = 2;\n');
    const snapshot = await capture();

    // The user commits something else, and the shadow learns of it.
    commitFile(dir, 'other.ts', 'export const other = 1;\n', 'two');
    await ensureShadow(repo, { runner, dataDir, repoId });

    const result = await commitSnapshotInShadow(shadow, snapshot, { runner });

    // The tree has no `other.ts`. Parented on the new head, this commit would
    // claim to delete it — a change nobody made, which a merge would carry.
    expect(parentsOf(result.commitSha)).toEqual([head]);
    const changed = gitIn(shadow.rootPath, 'diff', '--name-only', head, result.commitSha).trim();
    expect(changed).toBe('shared.ts');
  });

  it('parents a detached HEAD on its commit, since there is no branch to look up', async () => {
    const head = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', '--detach');
    writeFileSync(join(dir, 'shared.ts'), 'export const value = 2;\n');

    const result = await commitSnapshotInShadow(shadow, await capture(), { runner });

    expect(parentsOf(result.commitSha)).toEqual([head]);
  });

  it('makes a root commit where HEAD is unborn', async () => {
    const fresh = join(base, 'fresh');
    initRepo(fresh);
    writeFileSync(join(fresh, 'a.txt'), 'uncommitted\n');
    const freshRepo: UserRepo = { kind: 'user', rootPath: fresh, gitDir: join(fresh, '.git') };
    const freshShadow = await ensureShadow(freshRepo, {
      runner,
      dataDir,
      repoId: '01JBQ0000000000000000FRSH' as RepoId,
    });
    const snapshot = await captureDirtyState(fresh, freshRepo, {
      runner,
      objectStore: freshShadow,
    });

    const result = await commitSnapshotInShadow(freshShadow, snapshot, { runner });

    expect(gitIn(freshShadow.rootPath, 'log', '-1', '--format=%P', result.commitSha).trim()).toBe(
      '',
    );
    expect(gitIn(freshShadow.rootPath, 'rev-parse', `${result.commitSha}^{tree}`).trim()).toBe(
      snapshot.treeOid,
    );
  });

  it('answers a clean snapshot with the head itself and makes no commit', async () => {
    const head = git('rev-parse', 'HEAD').trim();
    const snapshot = await capture();
    expect(snapshot.clean).toBe(true);
    const { runner: spy, calls } = recording();

    const result = await commitSnapshotInShadow(shadow, snapshot, { runner: spy });

    expect(result).toEqual({ treeOid: snapshot.treeOid, commitSha: head });
    // A second commit for the same content is a new id for nothing, and every
    // consumer keying on commits would see a change that did not happen.
    expect(calls.map((argv) => argv[0])).not.toContain('commit-tree');
  });

  it('gives the same tree the same key however many times it is committed', async () => {
    writeFileSync(join(dir, 'shared.ts'), 'export const value = 2;\n');
    const snapshot = await capture();

    const first = await commitSnapshotInShadow(shadow, snapshot, { runner });
    const second = await commitSnapshotInShadow(shadow, snapshot, { runner });

    // Whether the commit ids differ depends on whether the clock ticked between
    // the calls, which is exactly why neither is the key.
    expect(second.treeOid).toBe(first.treeOid);
    expect(treeOf(second.commitSha)).toBe(treeOf(first.commitSha));
  });

  it('survives the user collecting garbage between the capture and the commit', async () => {
    writeFileSync(join(dir, 'untracked.ts'), 'export const u = 1;\n');
    const snapshot = await capture();

    git('gc', '-q', '--prune=now');
    const result = await commitSnapshotInShadow(shadow, snapshot, { runner });

    expect(treeOf(result.commitSha)).toBe(snapshot.treeOid);
  });

  it('carries hostile paths through to the commit', async () => {
    const hostile = [':(exclude)a.txt', '-dash.txt', 'with space.txt', 'with\nnewline.txt'];
    for (const name of hostile) writeFileSync(join(dir, name), `${name}\n`);

    const result = await commitSnapshotInShadow(shadow, await capture(), { runner });

    const paths = gitIn(shadow.rootPath, 'ls-tree', '-z', '--name-only', result.commitSha)
      .split('\0')
      .filter(Boolean);
    expect(paths).toEqual(expect.arrayContaining([...hostile, 'shared.ts']));
  });

  it('refuses ids that are not object ids before git reads one as an option', async () => {
    writeFileSync(join(dir, 'shared.ts'), 'export const value = 2;\n');
    const snapshot = await capture();

    // They come back from storage, so their shape is an assumption. A flag
    // arriving where an id is expected is read by git as a flag.
    for (const tampered of [
      { ...snapshot, treeOid: '--output=/tmp/x' },
      { ...snapshot, headSha: '--output=/tmp/x' },
    ]) {
      const error = await rejection(commitSnapshotInShadow(shadow, tampered, { runner }));
      expect(error.code).toBe('GIT_COMMAND_REFUSED');
    }
  });

  it('reads through a user repository that itself borrows its objects', async () => {
    // A `clone --shared` holds no history of its own, so reading `HEAD` goes
    // shadow → user store → upstream. The link written relative, the form git
    // resolves against the store holding the file rather than the one asking.
    const upstream = join(base, 'upstream');
    initRepo(upstream);
    commitFile(upstream, 'shared.ts', 'export const value = 1;\n', 'one');
    const borrower = join(base, 'borrower');
    execFileSync('git', ['clone', '-q', '--shared', upstream, borrower], { stdio: 'pipe' });
    writeFileSync(
      join(borrower, '.git', 'objects', 'info', 'alternates'),
      `${relative(join(borrower, '.git', 'objects'), join(upstream, '.git', 'objects'))}\n`,
    );
    const borrowing: UserRepo = {
      kind: 'user',
      rootPath: borrower,
      gitDir: join(borrower, '.git'),
    };
    const chained = await ensureShadow(borrowing, {
      runner,
      dataDir,
      repoId: '01JBQ0000000000000000CHAN' as RepoId,
    });
    writeFileSync(join(borrower, 'shared.ts'), 'export const value = 2;\n');

    const snapshot = await captureDirtyState(borrower, borrowing, { runner, objectStore: chained });
    const result = await commitSnapshotInShadow(chained, snapshot, { runner });

    expect(gitIn(chained.rootPath, 'log', '-1', '--format=%P', result.commitSha).trim()).toBe(
      gitIn(borrower, 'rev-parse', 'HEAD').trim(),
    );
  });

  describe('an object the shadow cannot read', () => {
    it('is a stale snapshot when the shadow was rebuilt since the capture', async () => {
      writeFileSync(join(dir, 'shared.ts'), 'export const value = 2;\n');
      const snapshot = await capture();
      // The ordinary way it happens: a rebuild discards everything the shadow
      // held, including trees captured into it.
      rmSync(shadow.rootPath, { recursive: true, force: true });
      shadow = await ensureShadow(repo, { runner, dataDir, repoId });

      const error = await rejection(commitSnapshotInShadow(shadow, snapshot, { runner }));

      // Not infrastructure: nothing is broken, and capturing again is the fix.
      expect(error.code).toBe('SNAPSHOT_STALE');
      expect(error.infra).toBe(false);
      expect(error.remedy).toBeDefined();
    });

    it('is a stale snapshot when the commit it was taken against is gone', async () => {
      writeFileSync(join(dir, 'shared.ts'), 'export const value = 2;\n');
      const snapshot = await capture();
      // Well-formed, so it passes the shape check, and in no store at all.
      const missing = 'e'.repeat(snapshot.treeOid.length);

      const error = await rejection(
        commitSnapshotInShadow(shadow, { ...snapshot, headSha: missing }, { runner }),
      );

      expect(error.code).toBe('SNAPSHOT_STALE');
    });

    it('is a stale snapshot when a clean one names a head the shadow cannot read', async () => {
      const snapshot = await capture();
      expect(snapshot.clean).toBe(true);

      const error = await rejection(
        commitSnapshotInShadow(
          shadow,
          { ...snapshot, headSha: 'e'.repeat(snapshot.treeOid.length) },
          {
            runner,
          },
        ),
      );

      // The clean path hands back a commit without making one, so it has to
      // check it can read that commit or a merge fails on it later instead.
      expect(error.code).toBe('SNAPSHOT_STALE');
    });

    it('refuses an object of the wrong kind rather than letting commit-tree fail on it', async () => {
      writeFileSync(join(dir, 'shared.ts'), 'export const value = 2;\n');
      const snapshot = await capture();
      const blob = git('rev-parse', 'HEAD:shared.ts').trim();

      const error = await rejection(
        commitSnapshotInShadow(shadow, { ...snapshot, treeOid: blob }, { runner }),
      );

      expect(error.code).toBe('SNAPSHOT_STALE');
    });
  });
});
