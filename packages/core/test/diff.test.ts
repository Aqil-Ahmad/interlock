import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ulid } from '@interlock/shared';
import type { BranchRef, BranchRefId, Hunk, RepoId, SnapshotId } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  alignHunks,
  extractChangeSet,
  parseBinaryPaths,
  parseHunks,
  parseNameStatus,
  touchedPaths,
} from '../src/git/diff.js';
import type { NamedChange } from '../src/git/diff.js';
import { createGitRunner } from '../src/git/repo-handle.js';
import type { UserRepo } from '../src/git/repo-handle.js';
import { captureDirtyState } from '../src/git/worktree.js';

/**
 * ChangeSet extraction against a repository holding every shape a diff has.
 *
 * The file list and the hunk counts are asserted against `git diff` itself
 * rather than against literals: a literal records what the implementation did
 * on the day it was written, and this has to keep agreeing with git.
 */
describe('extractChangeSet', () => {
  let dir: string;
  let repo: UserRepo;
  let base: string;
  const runner = createGitRunner();

  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  /** git's own answer for the same range, NUL-separated so awkward names survive. */
  const gitPaths = (target: string): string[] =>
    git('diff', '--name-only', '-z', '--find-renames', base, target).split('\0').filter(Boolean);

  /**
   * git's hunk count for one file.
   *
   * Both paths of a rename are named, because a pathspec narrows rename
   * detection too: scoped to the destination alone git sees an addition and
   * counts a hunk for content that never changed.
   */
  const gitHunkCount = (target: string, path: string, previousPath: string | null): number =>
    git(
      'diff',
      '--unified=0',
      '--find-renames',
      base,
      target,
      '--',
      ...(previousPath === null ? [path] : [previousPath, path]),
    )
      .split('\n')
      .filter((line) => line.startsWith('@@ ')).length;

  /** git's hunk count for the whole range, which no pathspec can distort. */
  const gitTotalHunks = (target: string): number =>
    git('diff', '--unified=0', '--find-renames', base, target)
      .split('\n')
      .filter((line) => line.startsWith('@@ ')).length;

  const branch = (headSha: string): BranchRef => ({
    id: ulid<BranchRefId>(),
    repoId: ulid<RepoId>(),
    ref: 'refs/heads/main',
    name: 'main',
    headSha,
    worktreePath: dir,
    dirty: null,
    sessionId: null,
    firstSeenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-diff-')));
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
    git('config', 'user.name', 'Interlock Test');
    git('config', 'user.email', 'test@example.invalid');

    writeFileSync(join(dir, 'edited.txt'), 'one\ntwo\nthree\nfour\nfive\n');
    writeFileSync(join(dir, 'renamed-from.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\n');
    writeFileSync(join(dir, 'deleted.txt'), 'goes away\n');
    writeFileSync(join(dir, 'mode.sh'), '#!/bin/sh\n');
    // NUL bytes are what make git call a file binary; random bytes alone do not.
    writeFileSync(join(dir, 'image.bin'), Buffer.from([0x89, 0x00, 0x01, 0x02, 0x00, 0xff]));
    writeFileSync(join(dir, 'has space.txt'), 'spaced\n');
    // Renamed rather than edited in `commitEveryShape`: `--numstat -z` reports
    // a rename as an empty path in the counts field followed by the source and
    // destination, and nothing else in the fixture reaches that branch.
    writeFileSync(join(dir, 'moved.bin'), Buffer.from([0x00, 0x11, 0x00, 0x22]));
    git('add', '-A');
    git('commit', '-qm', 'base');
    base = git('rev-parse', 'HEAD').trim();

    repo = { kind: 'user', rootPath: dir, gitDir: join(dir, '.git') };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Every shape at once, committed so the range is commit-to-commit. */
  const commitEveryShape = (): string => {
    writeFileSync(join(dir, 'edited.txt'), 'ONE\ntwo\nthree\nFOUR\nfive\nsix\n');
    git('mv', 'renamed-from.txt', 'renamed-to.txt');
    // Edited as well as moved: a rename with no content change has no patch
    // section, so the alignment for a hunk-bearing rename goes untested. One
    // line of six, so similarity stays above git's rename threshold.
    writeFileSync(join(dir, 'renamed-to.txt'), 'one\ntwo\nTHREE\nfour\nfive\nsix\n');
    rmSync(join(dir, 'deleted.txt'));
    chmodSync(join(dir, 'mode.sh'), 0o755);
    writeFileSync(join(dir, 'image.bin'), Buffer.from([0x89, 0x00, 0xaa, 0xbb, 0x00, 0x01]));
    git('mv', 'moved.bin', 'moved-elsewhere.bin');
    writeFileSync(join(dir, 'has space.txt'), 'spaced differently\n');
    writeFileSync(join(dir, 'added.txt'), 'brand new\n');
    git('add', '-A');
    git('commit', '-qm', 'every shape');
    return git('rev-parse', 'HEAD').trim();
  };

  it('reports the same file list as git for the same range', async () => {
    const head = commitEveryShape();

    const changeSet = await extractChangeSet(repo, branch(head), base, { runner });

    const expected = gitPaths(head);
    // Guards the comparison: two empty lists would agree about nothing.
    expect(expected.length).toBeGreaterThan(5);
    expect([...changeSet.files.map((file) => file.path)].sort()).toEqual([...expected].sort());
  });

  it('reports the same hunk counts as git, file by file', async () => {
    const head = commitEveryShape();

    const changeSet = await extractChangeSet(repo, branch(head), base, { runner });

    for (const file of changeSet.files) {
      expect(file.hunks.length, file.path).toBe(gitHunkCount(head, file.path, file.previousPath));
    }
    // The totals too: hunks attributed to the wrong file can still agree file
    // by file if one gains exactly what another loses.
    const total = changeSet.files.reduce((sum, file) => sum + file.hunks.length, 0);
    expect(total).toBe(gitTotalHunks(head));
    expect(total).toBeGreaterThan(0);
  });

  it('classifies every shape of change', async () => {
    const head = commitEveryShape();

    const changeSet = await extractChangeSet(repo, branch(head), base, { runner });
    const byPath = new Map(changeSet.files.map((file) => [file.path, file]));

    expect(byPath.get('added.txt')?.kind).toBe('added');
    expect(byPath.get('deleted.txt')?.kind).toBe('deleted');
    expect(byPath.get('edited.txt')?.kind).toBe('modified');
    expect(byPath.get('renamed-to.txt')?.kind).toBe('renamed');
    expect(byPath.get('renamed-to.txt')?.previousPath).toBe('renamed-from.txt');
    // A rename is recorded under its destination; the source is not a file of
    // its own, or the same change would be counted twice.
    expect(byPath.has('renamed-from.txt')).toBe(false);
  });

  it('flags a binary file and gives it no hunks', async () => {
    const head = commitEveryShape();

    const changeSet = await extractChangeSet(repo, branch(head), base, { runner });
    const image = changeSet.files.find((file) => file.path === 'image.bin');
    const text = changeSet.files.find((file) => file.path === 'edited.txt');

    expect(image?.binary).toBe(true);
    expect(image?.hunks).toEqual([]);
    expect(text?.binary).toBe(false);
  });

  it('flags a renamed binary under its destination', async () => {
    // The rename branch of the numstat parser: git writes the counts with an
    // empty path, then the source, then the destination. Reading the third
    // column as the path would flag the source and leave the destination — the
    // path the change is recorded under — reported as text.
    const head = commitEveryShape();

    const changeSet = await extractChangeSet(repo, branch(head), base, { runner });
    const moved = changeSet.files.find((file) => file.path === 'moved-elsewhere.bin');

    expect(moved?.kind).toBe('renamed');
    expect(moved?.binary).toBe(true);
    expect(changeSet.files.some((file) => file.path === 'moved.bin')).toBe(false);
  });

  it('gives a rename that also changed content its own hunks', async () => {
    const head = commitEveryShape();

    const changeSet = await extractChangeSet(repo, branch(head), base, { runner });
    const renamed = changeSet.files.find((file) => file.path === 'renamed-to.txt');

    expect(renamed?.kind).toBe('renamed');
    expect(renamed?.hunks.length).toBeGreaterThan(0);
    expect(renamed?.hunks.length).toBe(gitHunkCount(head, 'renamed-to.txt', 'renamed-from.txt'));
  });

  it('records a change that is only a mode as modified with no hunks', async () => {
    const head = commitEveryShape();

    const changeSet = await extractChangeSet(repo, branch(head), base, { runner });
    const mode = changeSet.files.find((file) => file.path === 'mode.sh');

    expect(mode?.kind).toBe('modified');
    expect(mode?.hunks).toEqual([]);
    expect(mode?.binary).toBe(false);
  });

  it('keeps hunks with their own files across a typechange', async () => {
    // git reports a file becoming a symlink once in the summaries and twice in
    // the patch — a deletion and a creation — so every later file takes the
    // wrong section unless both are consumed.
    writeFileSync(join(dir, 'aaa.txt'), 'a1\na2\n');
    writeFileSync(join(dir, 'becomes-link.txt'), 'plain\n');
    writeFileSync(join(dir, 'zzz.txt'), 'z1\nz2\nz3\nz4\nz5\nz6\n');
    git('add', '-A');
    git('commit', '-qm', 'before the typechange');
    const from = git('rev-parse', 'HEAD').trim();

    writeFileSync(join(dir, 'aaa.txt'), 'a1\nA2\n');
    rmSync(join(dir, 'becomes-link.txt'));
    symlinkSync('target-need-not-exist', join(dir, 'becomes-link.txt'));
    // Two separated edits, so a file that inherited the typechange's second
    // section would read one hunk instead of two. With one hunk each, every
    // per-file assertion passes under the bug and only the total catches it.
    writeFileSync(join(dir, 'zzz.txt'), 'Z1\nz2\nz3\nz4\nz5\nZ6\n');
    git('add', '-A');
    git('commit', '-qm', 'typechange');
    const head = git('rev-parse', 'HEAD').trim();

    const changeSet = await extractChangeSet(repo, branch(head), from, { runner });
    const byPath = new Map(changeSet.files.map((file) => [file.path, file]));

    expect(byPath.get('aaa.txt')?.hunks).toHaveLength(1);
    expect(byPath.get('zzz.txt')?.hunks).toHaveLength(2);
    const total = changeSet.files.reduce((sum, file) => sum + file.hunks.length, 0);
    expect(total).toBe(
      git('diff', '--unified=0', '--find-renames', from, head)
        .split('\n')
        .filter((line) => line.startsWith('@@ ')).length,
    );
  });

  it('refuses a revision expression, which git would resolve', async () => {
    const head = commitEveryShape();

    await expect(extractChangeSet(repo, branch(head), 'HEAD~1', { runner })).rejects.toThrow(
      'not an object id',
    );
  });

  it('refuses a flag-shaped revision, which git would act on', async () => {
    // Revisions are positional, and `--` separates them from paths rather than
    // from flags — so this writes a file where it is not refused.
    const marker = join(dir, '..', `${basename(dir)}-written-by-git.txt`);
    const head = commitEveryShape();

    await expect(
      extractChangeSet(repo, branch(head), base, {
        runner,
        snapshot: { id: ulid<SnapshotId>(), treeOid: `--output=${marker}` },
      }),
    ).rejects.toThrow('not an object id');
    // The throw is not the point; the file is.
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ['a space', 'has space.txt'],
    ['a newline', 'has\nnewline.txt'],
    ['a quote', 'has"quote.txt'],
  ])('survives a path containing %s', async (_name, path) => {
    // Patch output quotes these, which is why hunks are matched to files by
    // position rather than by reading the path back out of the patch.
    writeFileSync(join(dir, path), 'first\n');
    git('add', '-A');
    git('commit', '-qm', 'awkward');
    const head = git('rev-parse', 'HEAD').trim();

    const changeSet = await extractChangeSet(repo, branch(head), base, { runner });

    expect(changeSet.files.map((file) => file.path)).toContain(path);
    expect(changeSet.files.map((file) => file.path).sort()).toEqual([...gitPaths(head)].sort());
  });

  it('leaves symbols empty rather than guessing them', async () => {
    const head = commitEveryShape();

    const changeSet = await extractChangeSet(repo, branch(head), base, { runner });

    expect(changeSet.files.every((file) => file.symbols.length === 0)).toBe(true);
  });

  it('keeps rename pairing when the repository turns it off', async () => {
    const head = commitEveryShape();
    const before = await extractChangeSet(repo, branch(head), base, { runner });

    git('config', 'diff.renames', 'false');
    const after = await extractChangeSet(repo, branch(head), base, { runner });

    expect(after.files.map((file) => `${file.kind} ${file.path}`)).toEqual(
      before.files.map((file) => `${file.kind} ${file.path}`),
    );
    expect(after.files.some((file) => file.kind === 'renamed')).toBe(true);
  });

  it('suppresses the copy detection a repository asks for', () => {
    // Asserted on what git emitted rather than on the parsed result: a copy is
    // normalised to an addition with no previous path, byte-identical to the
    // addition the flag produces, so comparing change sets cannot tell them
    // apart and would pass however the flag behaved.
    writeFileSync(join(dir, 'copy-source.txt'), 'copy me\n');
    git('add', '-A');
    git('commit', '-qm', 'source');
    const from = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'copy-of.txt'), 'copy me\n');
    writeFileSync(join(dir, 'copy-source.txt'), 'copy me\nand more\n');
    git('add', '-A');
    git('commit', '-qm', 'copied');
    const head = git('rev-parse', 'HEAD').trim();
    git('config', 'diff.renames', 'copies');

    const unflagged = git('diff', '--name-status', '-z', from, head);
    const ours = git('diff', '--name-status', '-z', '--find-renames', from, head);

    // The fixture has to provoke a copy, or neither side proves anything.
    expect(unflagged).toContain('C');
    expect(ours).not.toContain('C');
  });

  it('records no copies when the repository asks for them', async () => {
    // The test above pins git's flag semantics on raw output; this runs the
    // module under the same config, which is what a watched repository would
    // actually be doing to it.
    const head = commitEveryShape();
    git('config', 'diff.renames', 'copies');

    const changeSet = await extractChangeSet(repo, branch(head), base, { runner });

    expect(changeSet.files.some((file) => file.kind === 'renamed')).toBe(true);
    for (const file of changeSet.files) {
      if (file.previousPath !== null) expect(file.kind).toBe('renamed');
    }
  });

  it('keeps the hunk count a repository config would merge away', async () => {
    // `diff.interHunkContext` merges hunks that sit near each other, so two
    // separated edits are reported as one region. Same family as
    // `diff.renames`: repository config deciding what Interlock records.
    writeFileSync(join(dir, 'spread.txt'), 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n');
    git('add', '-A');
    git('commit', '-qm', 'spread');
    const from = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'spread.txt'), 'X1\nl2\nl3\nl4\nl5\nl6\nl7\nX8\n');
    git('add', '-A');
    git('commit', '-qm', 'both ends');
    const head = git('rev-parse', 'HEAD').trim();
    git('config', 'diff.interHunkContext', '10');

    const changeSet = await extractChangeSet(repo, branch(head), from, { runner });

    // A fixed expectation, because git invoked without the pinning flags moves
    // with the config and would agree with a broken answer.
    expect(changeSet.files.find((file) => file.path === 'spread.txt')?.hunks).toHaveLength(2);
  });

  describe('uncommitted work', () => {
    it('diffs the snapshot tree rather than the branch head', async () => {
      const head = git('rev-parse', 'HEAD').trim();
      writeFileSync(join(dir, 'uncommitted.txt'), 'never committed\n');
      const snapshot = await captureDirtyState(dir, repo, { runner });
      const id = ulid<SnapshotId>();

      const changeSet = await extractChangeSet(repo, branch(head), base, {
        runner,
        snapshot: { id, treeOid: snapshot.treeOid },
      });

      expect(changeSet.files.map((file) => file.path)).toContain('uncommitted.txt');
      // The result records what it was computed from, or it cannot be traced.
      expect(changeSet.snapshotId).toBe(id);
      expect(changeSet.headSha).toBe(head);
    });

    it('records no snapshot when it compared the head', async () => {
      const head = commitEveryShape();

      const changeSet = await extractChangeSet(repo, branch(head), base, { runner });

      expect(changeSet.snapshotId).toBeNull();
    });
  });

  describe('touchedPaths', () => {
    it('includes both sides of a rename', async () => {
      // The source is gone and the destination is new, and a pair overlapping
      // on either is worth comparing.
      const head = commitEveryShape();

      const paths = await touchedPaths(repo, branch(head), base, { runner });

      expect(paths).toContain('renamed-to.txt');
      expect(paths).toContain('renamed-from.txt');
    });

    it.each([
      ['a revision expression', 'HEAD~1'],
      ['a flag-shaped value', '--output=written-by-git.txt'],
    ])('refuses %s as a revision', async (_name, value) => {
      // The same guard as `extractChangeSet`, reached through the other entry
      // point — which is the call site that had no test of its own.
      const marker = join(dir, '..', `${basename(dir)}-touched-by-git.txt`);

      await expect(
        touchedPaths(repo, branch(`--output=${marker}`), base, { runner }),
      ).rejects.toThrow('not an object id');
      await expect(touchedPaths(repo, branch(value), base, { runner })).rejects.toThrow(
        'not an object id',
      );
      // The throw is not the point; the file is.
      expect(existsSync(marker)).toBe(false);
    });

    it('agrees with the change set about which files moved', async () => {
      const head = commitEveryShape();

      const paths = await touchedPaths(repo, branch(head), base, { runner });
      const changeSet = await extractChangeSet(repo, branch(head), base, { runner });

      for (const file of changeSet.files) expect(paths).toContain(file.path);
    });
  });
});

describe('parseHunks', () => {
  it('reads a range whose count git omitted', () => {
    // git writes `-2` rather than `-2,1`, so a parser expecting the comma
    // silently drops every single-line hunk.
    const [file] = parseHunks(
      ['diff --git a/x b/x', '@@ -2 +2 @@ context', '@@ -3,0 +4,2 @@'].join('\n'),
    );

    expect(file).toEqual([
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
      { oldStart: 3, oldLines: 0, newStart: 4, newLines: 2 },
    ]);
  });

  it('keeps one list per file, including files with no hunks', () => {
    // A binary file and a mode-only change each produce a section with no
    // hunks in it, and dropping those would shift every later file's hunks
    // onto the wrong path.
    const patch = [
      'diff --git a/binary b/binary',
      'Binary files a/binary and b/binary differ',
      'diff --git a/text b/text',
      '@@ -1 +1 @@',
    ].join('\n');

    expect(parseHunks(patch)).toEqual([
      [],
      [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }],
    ]);
  });
});

/**
 * The parsers, driven directly.
 *
 * `--find-renames` suppresses copy detection, so a `C` entry cannot be produced
 * through git with the flags this module uses. The branch that reads one is
 * defence against a future caller asking for copies, and a synthetic field is
 * the only way to exercise it.
 */
describe('parseNameStatus', () => {
  const nul = (...fields: string[]): string => fields.join('\0');

  it('reads a rename as source then destination', () => {
    // The reverse of `status --porcelain -z`, which puts the destination first.
    expect(parseNameStatus(nul('R100', 'from.txt', 'to.txt', ''))).toEqual([
      { kind: 'renamed', path: 'to.txt', previousPath: 'from.txt', status: 'R' },
    ]);
  });

  it('reads a copy as an addition, leaving its source alone', () => {
    // A copy's source still exists, and `previousPath` means the opposite.
    expect(parseNameStatus(nul('C75', 'source.txt', 'copy.txt', ''))).toEqual([
      { kind: 'added', path: 'copy.txt', previousPath: null, status: 'C' },
    ]);
  });

  it.each([
    ['A', 'added'],
    ['D', 'deleted'],
    ['M', 'modified'],
    ['T', 'modified'],
    ['X', 'modified'],
  ])('maps %s to %s', (letter, kind) => {
    // An unrecognised letter still names a path that differs, and dropping it
    // would understate what a branch touches.
    expect(parseNameStatus(nul(letter, 'file.txt', ''))).toEqual([
      { kind, path: 'file.txt', previousPath: null, status: letter },
    ]);
  });

  it('stops cleanly on output that ends mid-entry', () => {
    expect(parseNameStatus(nul('R100', 'only-a-source.txt'))).toEqual([]);
    expect(parseNameStatus(nul('M'))).toEqual([]);
  });
});

describe('parseBinaryPaths', () => {
  it('reads the destination of a renamed binary, whose path field is empty', () => {
    // A rename puts an empty path in the counts field and follows it with the
    // two paths, so a parser reading the third column finds nothing there.
    expect([...parseBinaryPaths(['-\t-\t', 'from.bin', 'to.bin', ''].join('\0'))]).toEqual([
      'to.bin',
    ]);
  });

  it('keeps a path containing a tab, the separator this format uses', () => {
    // `-z` does not quote the path, so splitting on every tab truncates it —
    // the real file loses its binary flag and a phantom takes its place.
    expect([...parseBinaryPaths(['-\t-\thas\ttab.bin', ''].join('\0'))]).toEqual(['has\ttab.bin']);
  });

  it('separates binary from text by the counts, not the path', () => {
    const stdout = ['-\t-\timage.png', '3\t1\tcode.ts', ''].join('\0');

    expect([...parseBinaryPaths(stdout)]).toEqual(['image.png']);
  });
});

describe('alignHunks', () => {
  const change = (path: string, status: string): NamedChange => ({
    kind: 'modified',
    path,
    previousPath: null,
    status,
  });
  const hunk = (line: number): Hunk => ({
    oldStart: line,
    oldLines: 1,
    newStart: line,
    newLines: 1,
  });

  it('gives a typechange both of its sections', () => {
    const aligned = alignHunks(
      [change('before.txt', 'M'), change('link.txt', 'T'), change('after.txt', 'M')],
      [[hunk(1)], [hunk(2)], [hunk(3)], [hunk(4)]],
    );

    expect(aligned.map((entry) => entry.hunks)).toEqual([
      [hunk(1)],
      [hunk(2), hunk(3)],
      // The file after the typechange keeps its own section rather than
      // inheriting the second half of the one before it.
      [hunk(4)],
    ]);
  });

  it('raises when the two forms disagree rather than absorbing it', () => {
    // Reachable only from a git that splits a section this does not know about.
    // Silently absorbing it would attribute hunks to whichever file sits at
    // that index, which reads as evidence.
    expect(() => alignHunks([change('one.txt', 'M')], [[hunk(1)], [hunk(2)]])).toThrow(
      'different number of files',
    );
    expect(() => alignHunks([change('one.txt', 'M'), change('two.txt', 'M')], [[hunk(1)]])).toThrow(
      'different number of files',
    );
  });
});
