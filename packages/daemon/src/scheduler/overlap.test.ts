import { ulid } from '@interlock/shared';
import type { BranchRefId, ChangeSet, ChangeSetId, FileChange } from '@interlock/shared';
import { describe, expect, it } from 'vitest';
import { pairOverlap } from './overlap.js';

function changes(...files: (string | [previous: string, path: string])[]): ChangeSet {
  return {
    id: ulid<ChangeSetId>(),
    branchRefId: ulid<BranchRefId>(),
    snapshotId: null,
    mergeBaseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    computedAt: '',
    files: files.map((file): FileChange => ({
      path: typeof file === 'string' ? file : file[1],
      previousPath: typeof file === 'string' ? null : file[0],
      kind: typeof file === 'string' ? 'modified' : 'renamed',
      hunks: [],
      symbols: [],
      binary: false,
    })),
  };
}

describe('pairOverlap', () => {
  it('finds a file both sides touched', () => {
    expect(pairOverlap(changes('src/a.ts', 'b.ts'), changes('src/a.ts', 'c.ts'))).toEqual({
      tier: 'file',
      commonFiles: ['src/a.ts'],
    });
  });

  it('counts both ends of a rename', () => {
    expect(pairOverlap(changes(['old.ts', 'new.ts']), changes('old.ts')).tier).toBe('file');
    expect(pairOverlap(changes('new.ts'), changes(['old.ts', 'new.ts'])).tier).toBe('file');
  });

  it('finds files in one directory', () => {
    expect(pairOverlap(changes('src/a.ts'), changes('src/b.ts'))).toEqual({
      tier: 'directory',
      commonFiles: [],
    });
  });

  it('finds a file on one side where the other made a directory', () => {
    expect(pairOverlap(changes('d'), changes('d/x.ts')).tier).toBe('directory');
    expect(pairOverlap(changes('lib/d/deep/x.ts'), changes('lib/d')).tier).toBe('directory');
  });

  it('does not count the repository root as a common directory', () => {
    expect(pairOverlap(changes('a.ts'), changes('b.ts')).tier).toBe('none');
  });

  it('does not count a shared grandparent', () => {
    expect(pairOverlap(changes('src/x/a.ts'), changes('src/y/b.ts')).tier).toBe('none');
  });

  it('rules nothing out when a side has no change set', () => {
    expect(pairOverlap(null, changes('a.ts')).tier).toBe('unknown');
    expect(pairOverlap(changes('a.ts'), null).tier).toBe('unknown');
  });

  it('finds nothing in common with a branch that changed nothing', () => {
    expect(pairOverlap(changes(), changes('a.ts')).tier).toBe('none');
  });
});
