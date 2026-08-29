import { describe, expect, it } from 'vitest';
import { ulid } from '../ids.js';
import type { BranchRefId } from '../ids.js';
import { makePairKey } from './merge-pair.js';

/**
 * `(A,B)` and `(B,A)` are one pair. Two keys would mean two cache entries for
 * one pair, and the second run would never see the first's results.
 */
describe('makePairKey', () => {
  it('is independent of argument order', () => {
    const a = ulid<BranchRefId>();
    const b = ulid<BranchRefId>();

    expect(makePairKey(a, b)).toBe(makePairKey(b, a));
  });

  it('separates pairs that share a branch', () => {
    const a = ulid<BranchRefId>();
    const b = ulid<BranchRefId>();
    const c = ulid<BranchRefId>();

    expect(makePairKey(a, b)).not.toBe(makePairKey(a, c));
  });
});
