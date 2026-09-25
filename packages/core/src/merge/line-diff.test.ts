import { describe, expect, it } from 'vitest';
import { alignLines } from './line-diff.js';

/** Longest common subsequence length, by the textbook table. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      table[i]![j] =
        a[i - 1] === b[j - 1]
          ? table[i - 1]![j - 1]! + 1
          : Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
    }
  }
  return table[a.length]![b.length]!;
}

/** A small deterministic generator, so a failure reproduces. */
function lines(seed: number, length: number): string[] {
  let state = seed;
  return Array.from({ length }, () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return 'abcd'[state % 4]!;
  });
}

describe('alignLines', () => {
  it('matches identical texts line for line', () => {
    expect([...alignLines(['a', 'b', 'c'], ['a', 'b', 'c'], 10)!]).toEqual([0, 1, 2]);
  });

  it('leaves lines with no counterpart unmatched', () => {
    expect([...alignLines(['a', 'x', 'c'], ['a', 'c'], 10)!]).toEqual([0, -1, 1]);
    expect([...alignLines(['a', 'c'], ['a', 'y', 'c'], 10)!]).toEqual([0, 2]);
    expect([...alignLines([], ['a'], 10)!]).toEqual([]);
    expect([...alignLines(['a'], [], 10)!]).toEqual([-1]);
  });

  it('finds a longest common subsequence, as matched equal lines in order', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const a = lines(seed, seed % 17);
      const b = lines(seed * 7 + 3, (seed * 5) % 19);
      const match = alignLines(a, b, 1000)!;

      let last = -1;
      let count = 0;
      match.forEach((j, i) => {
        if (j === -1) return;
        expect(a[i]).toBe(b[j]);
        expect(j).toBeGreaterThan(last);
        last = j;
        count++;
      });
      expect(count, `seed ${seed}`).toBe(lcsLength(a, b));
    }
  });

  it('aligns a pure insertion or deletion whatever its size', () => {
    const many = Array.from({ length: 50 }, (_, i) => `n${i}`);
    expect([...alignLines(['a', 'b'], ['a', ...many, 'b'], 10)!]).toEqual([0, 51]);
    expect([...alignLines(['a', ...many, 'b'], ['a', 'b'], 10)!]).toEqual([
      0,
      ...many.map(() => -1),
      1,
    ]);
  });

  it('gives up past the edit bound, and not at it', () => {
    // Two lines replaced by two others: four edits once the shared ends are set aside.
    const a = ['s', 'a1', 'a2', 'e'];
    const b = ['s', 'b1', 'b2', 'e'];
    expect(alignLines(a, b, 3)).toBeNull();
    expect([...alignLines(a, b, 4)!]).toEqual([0, -1, -1, 3]);
  });
});
