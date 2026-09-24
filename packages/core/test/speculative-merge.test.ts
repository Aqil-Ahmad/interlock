import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoId } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitRunner } from '../src/git/repo-handle.js';
import type { GitResult, GitRunner, ShadowRepo, UserRepo } from '../src/git/repo-handle.js';
import { ensureShadow } from '../src/git/shadow.js';
import { captureDirtyState, commitSnapshotInShadow } from '../src/git/worktree.js';
import { parseConflictRegions, speculativeMerge } from '../src/merge/speculative-merge.js';
import type { SpeculativeMergeRequest } from '../src/merge/speculative-merge.js';
import { rejection } from './support/rejection.js';

/**
 * The merge, against real repositories in every shape that has broken a merge
 * tool before.
 *
 * Every pair is committed in the user's repository and merged in its shadow,
 * which borrows those commits through alternates — the way a scheduler will
 * run it. Each case asserts on what `merge-tree` reported, not on what a merge
 * would ideally say: the classifier reads these results, and a test written
 * against an idealised merge would pass on a parser that invents one.
 */
describe('speculativeMerge', () => {
  let base: string;
  let dir: string;
  let dataDir: string;
  let shadow: ShadowRepo;
  const runner = createGitRunner();

  const gitIn = (where: string, ...args: string[]): string =>
    execFileSync('git', ['-C', where, ...args], { stdio: 'pipe', encoding: 'utf8' });
  const git = (...args: string[]): string => gitIn(dir, ...args);
  const head = (): string => git('rev-parse', 'HEAD').trim();

  /** Every object file under the user's git directory. */
  const userObjects = (): string[] =>
    execFileSync('find', [join(dir, '.git', 'objects'), '-type', 'f'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .sort();

  const blobIn = (tree: string, path: string): string =>
    gitIn(shadow.rootPath, 'cat-file', 'blob', `${tree}:${path}`);

  /**
   * A base commit and two branches off it, each shaped by one callback, then a
   * shadow that can see all three.
   */
  const pair = async (
    setup: () => void,
    one: () => void,
    two: () => void,
  ): Promise<SpeculativeMergeRequest> => {
    setup();
    git('add', '-A');
    git('commit', '-qm', 'base');
    const mergeBaseSha = head();
    git('checkout', '-qb', 'one');
    one();
    git('add', '-A');
    git('commit', '-qm', 'one');
    const commitA = head();
    git('checkout', '-q', mergeBaseSha);
    git('checkout', '-qb', 'two');
    two();
    git('add', '-A');
    git('commit', '-qm', 'two');
    const commitB = head();
    git('checkout', '-q', 'main');
    const repo: UserRepo = { kind: 'user', rootPath: dir, gitDir: join(dir, '.git') };
    shadow = await ensureShadow(repo, {
      runner,
      dataDir,
      repoId: '01JBQ0000000000000000MERG' as RepoId,
    });
    return { shadow, commitA, commitB, mergeBaseSha };
  };

  const write = (path: string, content: string): void => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  };

  /** Stands in for the real runner, answering `merge-tree` with a result of the test's choosing. */
  const answering = (fake: Partial<GitResult>): GitRunner => ({
    run: (target, args, options) =>
      args.includes('merge-tree')
        ? Promise.resolve({ stdout: '', stderr: '', exitCode: 0, ...fake })
        : runner.run(target, args, options),
  });

  beforeEach(() => {
    // git answers with fully-resolved paths, and on macOS /var is a symlink to
    // /private/var, so the fixture works in canonical form throughout.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-merge-')));
    dir = join(base, 'user');
    dataDir = join(base, 'data');
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
    git('config', 'user.name', 'Interlock Test');
    git('config', 'user.email', 'test@example.invalid');
    // Since git 2.47 `commit` detaches a maintenance process that holds
    // `objects/maintenance.lock` after the commit returns.
    git('config', 'maintenance.auto', 'false');
    git('config', 'gc.auto', '0');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe('a clean pair', () => {
    it('returns the merged tree and nothing conflicted', async () => {
      const request = await pair(
        () => write('a.txt', 'base\n'),
        () => write('a.txt', 'base\none\n'),
        () => write('b.txt', 'two\n'),
      );

      const result = await speculativeMerge(request, { runner });

      expect(result.clean).toBe(true);
      expect(result.conflictedPaths).toEqual([]);
      expect(result.stages).toEqual([]);
      expect(result.messages).toEqual([]);
      expect(result.conflictBlocks).toEqual([]);
      expect(blobIn(result.treeOid, 'a.txt')).toBe('base\none\n');
      expect(blobIn(result.treeOid, 'b.txt')).toBe('two\n');
    });

    it('materialises nothing and writes nothing into the user repository', async () => {
      const request = await pair(
        () => write('a.txt', 'base\n'),
        () => write('a.txt', 'base\none\n'),
        () => write('b.txt', 'two\n'),
      );
      const before = userObjects();

      const result = await speculativeMerge(request, { runner });

      // The tree is new, it exists only in the shadow, and nothing was checked
      // out anywhere to produce it: no index, no worktree beside the bare one.
      expect(userObjects()).toEqual(before);
      expect(gitIn(shadow.rootPath, 'cat-file', '-t', result.treeOid).trim()).toBe('tree');
      expect(() => gitIn(dir, 'cat-file', '-t', result.treeOid)).toThrow();
      expect(gitIn(shadow.rootPath, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
      expect(existsSync(join(shadow.rootPath, 'index'))).toBe(false);
    });

    it('merges against the base it is given rather than one git would choose', async () => {
      // `other.txt` goes x → y on the way to the real base; one side puts it
      // back to x. Against the real base that is one side's change and wins;
      // against the older commit both sides agree with it unchanged except one,
      // and the other answer wins. The two trees differ only if the base is
      // the one passed in.
      write('other.txt', 'x\n');
      git('add', '-A');
      git('commit', '-qm', 'older');
      const older = head();
      const request = await pair(
        () => write('other.txt', 'y\n'),
        () => write('other.txt', 'x\n'),
        () => write('unrelated.txt', 'two\n'),
      );

      const againstBase = await speculativeMerge(request, { runner });
      const againstOlder = await speculativeMerge({ ...request, mergeBaseSha: older }, { runner });

      expect(blobIn(againstBase.treeOid, 'other.txt')).toBe('x\n');
      expect(blobIn(againstOlder.treeOid, 'other.txt')).toBe('y\n');
    });

    it('handles a clean merge that touches thousands of files', async () => {
      const count = 3000;
      const request = await pair(
        () => {
          for (let i = 0; i < count; i++) write(`src/f${String(i)}.txt`, `${String(i)}\n`);
        },
        () => {
          for (let i = 0; i < count / 2; i++) write(`src/f${String(i)}.txt`, 'one\n');
        },
        () => {
          for (let i = count / 2; i < count; i++) write(`src/f${String(i)}.txt`, 'two\n');
        },
      );

      const result = await speculativeMerge(request, { runner });

      expect(result.clean).toBe(true);
      expect(blobIn(result.treeOid, 'src/f0.txt')).toBe('one\n');
      expect(blobIn(result.treeOid, `src/f${String(count - 1)}.txt`)).toBe('two\n');
    }, 60_000);
  });

  describe('a conflicting pair', () => {
    const conflicting = (): Promise<SpeculativeMergeRequest> =>
      pair(
        () => write('t.txt', 'l1\nl2\nl3\n'),
        () => write('t.txt', 'l1\nONE\nl3\n'),
        () => write('t.txt', 'l1\nTWO\nl3\n'),
      );

    it('reports the path, its three stages and the typed message', async () => {
      const request = await conflicting();

      const result = await speculativeMerge(request, { runner });

      expect(result.clean).toBe(false);
      expect(result.conflictedPaths).toEqual(['t.txt']);
      expect(result.stages.map((s) => [s.path, s.stage, s.mode])).toEqual([
        ['t.txt', 1, '100644'],
        ['t.txt', 2, '100644'],
        ['t.txt', 3, '100644'],
      ]);
      // The stage blobs are the file as each commit has it, which the
      // classifier needs to map a region back to a line on each branch.
      expect(gitIn(shadow.rootPath, 'cat-file', 'blob', result.stages[1]!.oid)).toBe(
        'l1\nONE\nl3\n',
      );
      expect(result.messages).toContainEqual({
        paths: ['t.txt'],
        type: 'CONFLICT (contents)',
        text: 'CONFLICT (content): Merge conflict in t.txt',
      });
    });

    it('reads the conflict region out of the merged tree, base included', async () => {
      const request = await conflicting();

      const result = await speculativeMerge(request, { runner });

      expect(result.conflictBlocks).toEqual([
        { path: 't.txt', startLine: 2, endLine: 8, ours: 'ONE', theirs: 'TWO', base: 'l2' },
      ]);
      // The proof that no checkout was involved: the region's lines are the
      // merged tree's own blob, markers and all.
      const merged = blobIn(result.treeOid, 't.txt').split('\n');
      expect(merged[1]).toMatch(/^<{7} /u);
      expect(merged[7]).toMatch(/^>{7} /u);
    });

    it('reads a region without a base from a shadow that does not write one', async () => {
      const request = await conflicting();
      // What a clone made before it wrote regions with their base produces.
      gitIn(shadow.rootPath, 'config', 'merge.conflictStyle', 'merge');

      const result = await speculativeMerge(request, { runner });

      expect(result.conflictBlocks).toEqual([
        { path: 't.txt', startLine: 2, endLine: 6, ours: 'ONE', theirs: 'TWO', base: null },
      ]);
    });

    it('carries a path holding a newline through intact', async () => {
      const name = 'with\nnewline.txt';
      const request = await pair(
        () => write(name, 'base\n'),
        () => write(name, 'one\n'),
        () => write(name, 'two\n'),
      );

      const result = await speculativeMerge(request, { runner });

      expect(result.conflictedPaths).toEqual([name]);
      expect(result.conflictBlocks.map((block) => block.path)).toEqual([name]);
    });

    it('reports a binary conflict with its stages and reads no region out of it', async () => {
      const request = await pair(
        () => write('b.bin', '\0\u0001base'),
        () => write('b.bin', '\0one'),
        () => write('b.bin', '\0two'),
      );

      const result = await speculativeMerge(request, { runner });

      expect(result.conflictedPaths).toEqual(['b.bin']);
      // git names it both, which is why `contents` alone cannot mean markers.
      const types = result.messages.filter((m) => m.paths.includes('b.bin')).map((m) => m.type);
      expect(types).toEqual(expect.arrayContaining(['CONFLICT (binary)', 'CONFLICT (contents)']));
      expect(result.conflictBlocks).toEqual([]);
    });

    it('reads no region from a file the repository marks binary, however textual it is', async () => {
      // No NUL anywhere: only git's own verdict, carried by the message type,
      // says this file has no markers in it.
      const request = await pair(
        () => {
          write('.gitattributes', '*.dat binary\n');
          write('table.dat', 'base\n');
        },
        () => write('table.dat', 'one\n'),
        () => write('table.dat', 'two\n'),
      );

      const result = await speculativeMerge(request, { runner });

      expect(result.messages.map((m) => m.type)).toContain('CONFLICT (binary)');
      expect(result.conflictBlocks).toEqual([]);
    });

    it('reads the attributes commitA has, not the ones commitB has', async () => {
      // Only A marks the file binary. A `git merge` run on A's checkout reads
      // A's attributes, and so does this; read from B, the file would merge as
      // text and a region would be read from it.
      const request = await pair(
        () => write('table.dat', 'base\n'),
        () => {
          write('.gitattributes', '*.dat binary\n');
          write('table.dat', 'one\n');
        },
        () => write('table.dat', 'two\n'),
      );

      const result = await speculativeMerge(request, { runner });

      expect(result.messages.map((m) => m.type)).toContain('CONFLICT (binary)');
      expect(result.conflictBlocks).toEqual([]);
    });

    it('invents no region from marker-like text in a file git did not merge as text', async () => {
      // git keeps one side of a binary file whole and writes no markers, so any
      // marker-shaped lines in the result are that side's own content.
      const lookalike = '<<<<<<< not\nours\n=======\ntheirs\n>>>>>>> real\n';
      const request = await pair(
        () => {
          write('.gitattributes', '*.dat binary\n');
          write('table.dat', 'base\n');
        },
        () => write('table.dat', lookalike),
        () => write('table.dat', 'two\n'),
      );

      const result = await speculativeMerge(request, { runner });

      expect(blobIn(result.treeOid, 'table.dat')).toBe(lookalike);
      expect(result.conflictBlocks).toEqual([]);
    });

    it('reads no region from a file whose conflict is not about its contents', async () => {
      // Deleted on one side and edited on the other: the kept file is one
      // side's text, not a merge of two, whatever it happens to contain.
      const lookalike = '<<<<<<< not\nours\n=======\ntheirs\n>>>>>>> real\n';
      const request = await pair(
        () => write('kept.txt', 'base\n'),
        () => write('kept.txt', lookalike),
        () => rmSync(join(dir, 'kept.txt')),
      );

      const result = await speculativeMerge(request, { runner });

      expect(result.messages.map((m) => m.type)).toContain('CONFLICT (modify/delete)');
      expect(result.conflictBlocks).toEqual([]);
    });

    it('reports a file against a symlink, moved aside under a name neither branch has', async () => {
      const request = await pair(
        () => write('f', 'file\n'),
        () => {
          rmSync(join(dir, 'f'));
          symlinkSync('target', join(dir, 'f'));
        },
        () => write('f', 'changed\n'),
      );

      const result = await speculativeMerge(request, { runner });

      expect(result.messages.map((m) => m.type)).toContain('CONFLICT (distinct modes)');
      expect(result.stages.some((s) => s.mode === '120000')).toBe(true);
      expect(result.conflictedPaths).toContain('f');
      expect(result.conflictedPaths.some((p) => p.startsWith('f~'))).toBe(true);
      expect(result.conflictBlocks).toEqual([]);
    });

    it('reports a directory against a file', async () => {
      const request = await pair(
        () => write('d/x', 'x\n'),
        () => write('d/x', 'changed\n'),
        () => {
          rmSync(join(dir, 'd'), { recursive: true });
          write('d', 'now a file\n');
        },
      );

      const result = await speculativeMerge(request, { runner });

      const types = result.messages.map((m) => m.type);
      expect(types).toContain('CONFLICT (file/directory)');
      expect(types).toContain('CONFLICT (modify/delete)');
      expect(result.conflictedPaths).toContain('d/x');
    });

    it('reports a rename against a rename, pinned to the documented message shape', async () => {
      const request = await pair(
        () => write('b.txt', 'x\n'),
        () => git('mv', 'b.txt', 'b1.txt'),
        () => git('mv', 'b.txt', 'b2.txt'),
      );

      const result = await speculativeMerge(request, { runner });

      // Each stage sits under a different name, so the paths of one conflict
      // do not agree — and a message names all three, count first.
      expect(result.stages.map((s) => [s.stage, s.path])).toEqual([
        [1, 'b.txt'],
        [2, 'b1.txt'],
        [3, 'b2.txt'],
      ]);
      const renamed = result.messages.find((m) => m.type === 'CONFLICT (rename/rename)');
      expect(renamed?.paths).toEqual(['b.txt', 'b1.txt', 'b2.txt']);
    });

    it('reports a submodule moved to different commits on each side', async () => {
      // An embedded repository, whose commits live in its own store and not the
      // superproject's — so the merge cannot see them, and has to say so rather
      // than pass. `add -A` records its HEAD as a gitlink.
      const sub = join(dir, 'sub');
      execFileSync('git', ['init', '-q', '-b', 'main', sub], { stdio: 'pipe' });
      gitIn(sub, 'config', 'user.name', 'Interlock Test');
      gitIn(sub, 'config', 'user.email', 'test@example.invalid');
      const commits = ['c1', 'c2', 'c3'].map((message) => {
        gitIn(sub, 'commit', '-q', '--allow-empty', '-m', message);
        return gitIn(sub, 'rev-parse', 'HEAD').trim();
      });
      const at = (sha: string) => (): void => {
        gitIn(sub, 'checkout', '-q', sha);
      };
      const request = await pair(at(commits[0]!), at(commits[1]!), at(commits[2]!));

      const result = await speculativeMerge(request, { runner });

      expect(result.clean).toBe(false);
      expect(result.conflictedPaths).toEqual(['sub']);
      expect(result.stages.every((s) => s.mode === '160000')).toBe(true);
      expect(result.conflictBlocks).toEqual([]);
    });
  });

  describe('a merge that cannot be attempted', () => {
    const request = (): Promise<SpeculativeMergeRequest> =>
      pair(
        () => write('a.txt', 'base\n'),
        () => write('a.txt', 'one\n'),
        () => write('b.txt', 'two\n'),
      );

    it('is a stale snapshot when a commit is not in the shadow', async () => {
      const valid = await request();

      const error = await rejection(
        speculativeMerge({ ...valid, commitB: 'e'.repeat(40) }, { runner }),
      );

      expect(error.code).toBe('SNAPSHOT_STALE');
      expect(error.infra).toBe(false);
      expect(error.details.field).toBe('commitB');
    });

    it('is a stale snapshot when a commit is there and its tree has been collected', async () => {
      // A snapshot captured into the user's store rather than the shadow: its
      // commit lives in the shadow, its tree where the user's `gc` reaps it.
      const valid = await request();
      write('a.txt', 'uncommitted\n');
      const repo: UserRepo = { kind: 'user', rootPath: dir, gitDir: join(dir, '.git') };
      const snapshot = await captureDirtyState(dir, repo, { runner });
      const { commitSha } = await commitSnapshotInShadow(shadow, snapshot, { runner });
      git('checkout', '--', 'a.txt');
      git('reflog', 'expire', '--expire=now', '--all');
      git('gc', '-q', '--prune=now');

      const error = await rejection(speculativeMerge({ ...valid, commitA: commitSha }, { runner }));

      expect(error.code).toBe('SNAPSHOT_STALE');
      expect(error.details.field).toBe('commitA');
    });

    it('reports a git too old for this merge as unsupported, not as a failed merge', async () => {
      const valid = await request();

      // git 2.38 and 2.39 exit 129 on `--merge-base`, which the real git on
      // this machine cannot be made to do.
      const error = await rejection(
        speculativeMerge(valid, { runner: answering({ exitCode: 129 }) }),
      );

      expect(error.code).toBe('TOOLCHAIN_UNSUPPORTED');
      expect(error.infra).toBe(true);
    });

    it('reports how long the call took', async () => {
      const valid = await request();
      const slow: GitRunner = {
        run: async (target, args, options) => {
          if (args.includes('merge-tree')) await new Promise((resolve) => setTimeout(resolve, 40));
          return runner.run(target, args, options);
        },
      };

      const result = await speculativeMerge(valid, { runner: slow });

      // The timing is part of what this returns — the scheduler budgets on it —
      // so it has to measure the call rather than merely be a number.
      expect(result.durationMs).toBeGreaterThanOrEqual(40);
    });

    it('keeps git stderr, which is repository content, out of the error', async () => {
      const valid = await request();
      const stderr = 'fatal: something about secret/path/names';

      const error = await rejection(
        speculativeMerge(valid, { runner: answering({ exitCode: 128, stderr }) }),
      );

      expect(error.code).toBe('MERGE_FAILED');
      expect(JSON.stringify(error.details)).not.toContain('secret');
      expect(error.message).not.toContain('secret');
    });

    it('refuses ids that are not object ids before git reads one as an option', async () => {
      const valid = await request();

      for (const field of ['commitA', 'commitB', 'mergeBaseSha'] as const) {
        const error = await rejection(
          speculativeMerge({ ...valid, [field]: '--output=/tmp/x' }, { runner }),
        );
        expect(error.code).toBe('GIT_COMMAND_REFUSED');
      }
    });

    it('refuses output it cannot read rather than reporting a guess', async () => {
      const valid = await request();
      const tree = gitIn(dir, 'rev-parse', 'HEAD^{tree}').trim();

      const stage = `100644 ${tree} 1\tx`;
      const named = '1\0x\0CONFLICT (contents)\0CONFLICT (content): x\0';
      const unreadable = [
        // A clean exit with no tree to report.
        { exitCode: 0, stdout: 'not a tree\0' },
        { exitCode: 1, stdout: 'not a tree\0' },
        // Records that reach the stage parser and are not stages, each followed
        // by a message that is fine, so the stage check is the one refusing.
        { exitCode: 1, stdout: `${tree}\x00garbage record\0\0${named}` },
        { exitCode: 1, stdout: `${tree}\x00100644 notanoid 1\tx\0\0${named}` },
        { exitCode: 1, stdout: `${tree}\x00100644 ${tree} 1 extra\tx\0\0${named}` },
        { exitCode: 1, stdout: `${tree}\x00644 ${tree} 1\tx\0\0${named}` },
        { exitCode: 1, stdout: `${tree}\x00100644 ${tree} 4\tx\0\0${named}` },
        // Messages after a valid stage, so only the message checks can refuse.
        { exitCode: 1, stdout: `${tree}\0${stage}\0\0zero\0CONFLICT (contents)\0x\0` },
        { exitCode: 1, stdout: `${tree}\0${stage}\0\x000\0CONFLICT (contents)\0x\0` },
        { exitCode: 1, stdout: `${tree}\0${stage}\0\x002\0only-one-path\0` },
        // Cut short, and the two ways exit status and output can disagree.
        { exitCode: 1, stdout: `${tree}` },
        { exitCode: 0, stdout: `${tree}\0${stage}\0\0` },
        { exitCode: 1, stdout: `${tree}\0` },
        // Stages and the separator, then nothing: cut off before any message.
        { exitCode: 1, stdout: `${tree}\0${stage}\0\0` },
      ];
      for (const fake of unreadable) {
        const error = await rejection(speculativeMerge(valid, { runner: answering(fake) }));
        expect(error.code).toBe('MERGE_FAILED');
      }
    });
  });
});

describe('parseConflictRegions', () => {
  it('reads several regions and the lines between them', () => {
    const text = [
      'a',
      '<<<<<<< x',
      'o1',
      '=======',
      't1',
      '>>>>>>> y',
      'b',
      '<<<<<<< x',
      'o2',
      '=======',
      't2',
      '>>>>>>> y',
      '',
    ].join('\n');

    expect(parseConflictRegions('f', text)).toEqual([
      { path: 'f', startLine: 2, endLine: 6, ours: 'o1', theirs: 't1', base: null },
      { path: 'f', startLine: 8, endLine: 12, ours: 'o2', theirs: 't2', base: null },
    ]);
  });

  it('reads markers of the length the repository configured', () => {
    // `conflict-marker-size` is the repository's to set, and a parser fixed at
    // seven would read these as content and find nothing.
    const text = [
      '<<<<<<<<<< x',
      'o',
      '|||||||||| b',
      'base',
      '==========',
      't',
      '>>>>>>>>>> y',
    ].join('\n');

    expect(parseConflictRegions('f', text)).toEqual([
      { path: 'f', startLine: 1, endLine: 7, ours: 'o', theirs: 't', base: 'base' },
    ]);
  });

  it('reads CRLF markers and keeps the content as it was', () => {
    const text = ['<<<<<<< x\r', 'o\r', '=======\r', 't\r', '>>>>>>> y\r', ''].join('\n');

    expect(parseConflictRegions('f', text)).toEqual([
      { path: 'f', startLine: 1, endLine: 5, ours: 'o\r', theirs: 't\r', base: null },
    ]);
  });

  it('does not read content that merely starts like a marker as one', () => {
    const text = ['<<<<<<<x not a marker', '<<<<<< six', 'plain'].join('\n');

    expect(parseConflictRegions('f', text)).toEqual([]);
  });

  it('reads a shorter marker run inside a longer region as content', () => {
    // In the section a closer is looked for, so only the length tells the two
    // apart.
    const text = ['<<<<<<<<<< x', 'o', '==========', 't', '>>>>>>> inner', '>>>>>>>>>> y'].join(
      '\n',
    );

    expect(parseConflictRegions('f', text)).toEqual([
      { path: 'f', startLine: 1, endLine: 6, ours: 'o', theirs: 't\n>>>>>>> inner', base: null },
    ]);
  });

  it('reads a shorter pipe run inside a longer region as content, not as the base', () => {
    // With `conflict-marker-size` above seven, a line of seven pipes in one
    // side's own text would otherwise split the region at the wrong place.
    const text = [
      '<<<<<<<<<< x',
      'o',
      '||||||| not the base',
      '|||||||||| b',
      'base',
      '==========',
      't',
      '>>>>>>>>>> y',
    ].join('\n');

    expect(parseConflictRegions('f', text)).toEqual([
      {
        path: 'f',
        startLine: 1,
        endLine: 8,
        ours: 'o\n||||||| not the base',
        theirs: 't',
        base: 'base',
      },
    ]);
  });

  it('does not open a region on a run with no space before its label', () => {
    const text = ['<<<<<<<x', 'o', '=======', 't', '>>>>>>> y'].join('\n');

    expect(parseConflictRegions('f', text)).toEqual([]);
  });

  it('does not read runs shorter than seven as markers, however well-formed', () => {
    const text = ['<<<<<< a', 'o', '======', 't', '>>>>>> b'].join('\n');

    expect(parseConflictRegions('f', text)).toEqual([]);
  });

  it('reads nothing after a region that never closes, even a region of another size', () => {
    // Whatever follows an unclosed marker is not text this can vouch for.
    const text = [
      '<<<<<<< x',
      'dangling',
      '<<<<<<<<<< a',
      'o',
      '==========',
      't',
      '>>>>>>>>>> b',
    ].join('\n');

    expect(parseConflictRegions('f', text)).toEqual([]);
  });

  it('stops at a region that never closes, keeping the ones before it', () => {
    const text = ['<<<<<<< x', 'o', '=======', 't', '>>>>>>> y', '<<<<<<< x', 'dangling'].join(
      '\n',
    );

    expect(parseConflictRegions('f', text)).toHaveLength(1);
  });
});
