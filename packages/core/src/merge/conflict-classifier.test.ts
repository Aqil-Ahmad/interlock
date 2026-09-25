import { describe, expect, it } from 'vitest';
import {
  MAX_EXCERPT_CHARS,
  MAX_EXCERPT_LINES,
  changedHunks,
  excerptOf,
  placeRegions,
  regionOverlaps,
} from './conflict-classifier.js';
import type { ConflictRegionLines } from './speculative-merge.js';

const region = (
  base: readonly string[] | null,
  ours: readonly string[],
  theirs: readonly string[],
): ConflictRegionLines => ({ startLine: 1, endLine: 1, base, ours, theirs });

/** More lines than the aligner will take on. */
const huge = (tag: string): string[] => Array.from({ length: 1001 }, (_, i) => `${tag}${i}`);

describe('regionOverlaps', () => {
  it('is true when both sides changed the same base line', () => {
    expect(regionOverlaps(region(['x'], ['a'], ['b']))).toBe(true);
  });

  it('is true when one side deleted a line the other changed', () => {
    expect(regionOverlaps(region(['x', 'y'], [], ['X', 'y']))).toBe(true);
  });

  it('is false for changes to neighbouring lines', () => {
    expect(regionOverlaps(region(['x', 'y'], ['X', 'y'], ['x', 'Y']))).toBe(false);
  });

  it('is false for two additions at one place', () => {
    expect(regionOverlaps(region([], ['import b'], ['import c']))).toBe(false);
  });

  it('is true for an insertion inside a run the other side replaced', () => {
    // Theirs replaced x, y and z; ours added a line between y and z.
    expect(regionOverlaps(region(['x', 'y', 'z'], ['x', 'y', 'new', 'z'], ['X']))).toBe(true);
    expect(regionOverlaps(region(['x', 'y', 'z'], ['X'], ['x', 'y', 'new', 'z']))).toBe(true);
  });

  it('is false for an insertion at the edge of a run the other side replaced', () => {
    expect(regionOverlaps(region(['x', 'y'], ['new', 'x', 'y'], ['X', 'Y']))).toBe(false);
    expect(regionOverlaps(region(['x', 'y'], ['x', 'y', 'new'], ['X', 'Y']))).toBe(false);
  });

  it('cannot tell without a base, or with a side too far from it to align', () => {
    expect(regionOverlaps(region(null, ['a'], ['b']))).toBeNull();
    // One side at a time, the other aligning easily.
    expect(regionOverlaps(region(['x'], huge('a'), ['b']))).toBeNull();
    expect(regionOverlaps(region(['x'], ['b'], huge('a')))).toBeNull();
  });
});

describe('placeRegions', () => {
  // The merged file: `k`, a region, `k2`.
  const merged = ['k', '<<<<<<< a', 'o', '||||||| b', 'x', '=======', 't', '>>>>>>> c', 'k2'];
  const at = (ours: string[], theirs: string[]): ConflictRegionLines => ({
    startLine: 2,
    endLine: 8,
    base: ['x'],
    ours,
    theirs,
  });

  it('places each side in its own file', () => {
    const regions = [at(['o'], ['t'])];
    expect(placeRegions(merged, regions, 'ours', ['k', 'o', 'k2'])).toEqual([[1, 2]]);
    expect(placeRegions(merged, regions, 'theirs', ['pre', 'k', 't', 'k2'])).toEqual([[2, 3]]);
  });

  it('refuses lines that do not align contiguously', () => {
    const regions = [at(['o', 'p'], ['t'])];
    expect(placeRegions(merged, regions, 'ours', ['k', 'o', 'mid', 'p', 'k2'])).toEqual([null]);
    expect(placeRegions(merged, regions, 'ours', ['k', 'q', 'p', 'k2'])).toEqual([null]);
    expect(placeRegions(merged, [at(['o'], ['t'])], 'ours', ['k', 'q', 'k2'])).toEqual([null]);
  });

  it('places an empty side between neighbours, and only between neighbours', () => {
    const regions = [at([], ['t'])];
    expect(placeRegions(merged, regions, 'ours', ['k', 'k2'])).toEqual([[1, 1]]);
    // Something of the other side's sits between them: no single position.
    expect(placeRegions(merged, regions, 'ours', ['k', 'other', 'k2'])).toEqual([null]);
  });

  it('places an empty side first when nothing before it is in the file', () => {
    // `k` is the other side's clean addition, absent from this side.
    expect(placeRegions(merged, [at([], ['t'])], 'ours', ['k2'])).toEqual([[0, 0]]);
    expect(placeRegions(merged, [at([], ['t'])], 'ours', ['z', 'k2'])).toEqual([null]);
  });

  it('places an empty side at either end of the file', () => {
    const first: ConflictRegionLines = {
      startLine: 1,
      endLine: 5,
      base: ['x'],
      ours: [],
      theirs: ['t'],
    };
    const top = ['<<<<<<< a', '||||||| b', 'x', '=======', 't', '>>>>>>> c', 'k'];
    expect(placeRegions(top, [{ ...first, endLine: 6 }], 'ours', ['k'])).toEqual([[0, 0]]);

    const bottom = ['k', '<<<<<<< a', '||||||| b', 'x', '=======', 't', '>>>>>>> c'];
    const last = { ...first, startLine: 2, endLine: 7 };
    expect(placeRegions(bottom, [last], 'ours', ['k'])).toEqual([[1, 1]]);
    expect(placeRegions(bottom, [last], 'ours', ['other', 'k'])).toEqual([[2, 2]]);
    expect(placeRegions(bottom, [last], 'ours', ['k', 'other'])).toEqual([null]);
  });

  it('places nothing when the file is too far from the merge to align', () => {
    const regions = [at(['o'], ['t'])];
    // Around the region rather than after it: a shared start and end are set
    // aside before aligning, and cost nothing however long.
    const side = ['k', ...huge('z'), 'o', ...huge('w'), 'k2'];
    expect(placeRegions(merged, regions, 'ours', side)).toEqual([null]);
  });
});

describe('changedHunks', () => {
  it('reports each change in the side’s own lines', () => {
    expect(changedHunks(['a', 'b', 'c'], ['a', 'B', 'c'])).toEqual([[1, 2]]);
    expect(changedHunks(['a', 'c'], ['a', 'b', 'b2', 'c'])).toEqual([[1, 3]]);
    expect(changedHunks(['a', 'b'], ['a', 'b', 'c'])).toEqual([[2, 3]]);
    expect(changedHunks(['x', 'a', 'y'], ['X', 'a', 'Y'])).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('reports a deletion as an empty range where the lines were', () => {
    expect(changedHunks(['a', 'b', 'c'], ['a', 'c'])).toEqual([[1, 1]]);
    expect(changedHunks(['a', 'b'], ['a'])).toEqual([[1, 1]]);
  });

  it('reports nothing for an unchanged file, and null for one too changed to align', () => {
    expect(changedHunks(['a'], ['a'])).toEqual([]);
    expect(changedHunks(huge('x'), huge('y'))).toBeNull();
  });
});

describe('excerptOf', () => {
  it('keeps at most the line bound', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
    expect(excerptOf(lines).split('\n')).toHaveLength(MAX_EXCERPT_LINES);
  });

  it('keeps at most the character bound, never splitting a character', () => {
    const excerpt = excerptOf(['😀'.repeat(MAX_EXCERPT_CHARS + 5)]);
    expect([...excerpt]).toHaveLength(MAX_EXCERPT_CHARS);
    expect(excerpt).toBe('😀'.repeat(MAX_EXCERPT_CHARS));
  });

  it('redacts secrets', () => {
    const excerpt = excerptOf([`const key = "ghp_${'a'.repeat(36)}";`]);
    expect(excerpt).not.toContain('ghp_');
    expect(excerpt).toContain('[redacted]');
  });
});
