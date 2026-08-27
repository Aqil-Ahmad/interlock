import { describe, expect, it } from 'vitest';
import { ulid } from '../ids.js';
import type { BranchRefId, ChangeSetId } from '../ids.js';
import { overlappingPaths } from './change-set.js';
import type { ChangeKind, ChangeSet, FileChange } from './change-set.js';

/**
 * The cheapest conflict signal, so a pair it misses is never looked at again.
 */
describe('overlappingPaths', () => {
  const file = (
    path: string,
    kind: ChangeKind = 'modified',
    previousPath: string | null = null,
  ): FileChange => ({
    path,
    previousPath,
    kind,
    hunks: [],
    symbols: [],
    binary: false,
  });

  const changeSet = (files: FileChange[]): ChangeSet => ({
    id: ulid<ChangeSetId>(),
    branchRefId: ulid<BranchRefId>(),
    snapshotId: null,
    mergeBaseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    files,
    computedAt: new Date().toISOString(),
  });

  it('reports a file both sides changed', () => {
    expect(
      overlappingPaths(
        changeSet([file('src/a.ts'), file('src/b.ts')]),
        changeSet([file('src/b.ts')]),
      ),
    ).toEqual(['src/b.ts']);
  });

  it('reports nothing when the two sides are disjoint', () => {
    expect(overlappingPaths(changeSet([file('src/a.ts')]), changeSet([file('src/b.ts')]))).toEqual(
      [],
    );
  });

  it('sees a rename on one side and an edit on the other', () => {
    // git cannot merge this, and the two sides never name the same destination
    // — so comparing only where each file ended up reports no overlap at all.
    const renamer = changeSet([file('src/session.ts', 'renamed', 'src/auth.ts')]);
    const editor = changeSet([file('src/auth.ts')]);

    expect(overlappingPaths(renamer, editor)).toEqual(['src/auth.ts']);
    expect(overlappingPaths(editor, renamer)).toEqual(['src/auth.ts']);
  });

  it('names a file once when both sides renamed it', () => {
    const a = changeSet([file('src/one.ts', 'renamed', 'src/old.ts')]);
    const b = changeSet([file('src/two.ts', 'renamed', 'src/old.ts')]);

    expect(overlappingPaths(a, b)).toEqual(['src/old.ts']);
  });
});
