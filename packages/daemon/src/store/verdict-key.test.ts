import { ulid } from '@interlock/shared';
import type { BranchRefId } from '@interlock/shared';
import { describe, expect, it } from 'vitest';
import { toolchainFingerprint, verdictKey } from './verdict-key.js';
import type { VerdictKeyParts } from './verdict-key.js';

describe('verdictKey', () => {
  const [low, high] = [ulid<BranchRefId>(), ulid<BranchRefId>()].sort() as [
    BranchRefId,
    BranchRefId,
  ];
  const parts: VerdictKeyParts = {
    fingerprint: toolchainFingerprint({ analyzer: 'textual', version: 1, tools: ['git 2.55.0'] }),
    branchA: low,
    treeA: 'a'.repeat(40),
    branchB: high,
    treeB: 'b'.repeat(40),
    mergeBaseSha: 'c'.repeat(40),
  };

  it('does not depend on which side is passed first', () => {
    const flipped = {
      ...parts,
      branchA: parts.branchB,
      treeA: parts.treeB,
      branchB: parts.branchA,
      treeB: parts.treeA,
    };
    expect(verdictKey(flipped)).toBe(verdictKey(parts));
  });

  it('differs when the same trees sit on the other branches', () => {
    // Stages 2 and 3 and the attribution swap with them, so it is another merge.
    expect(verdictKey({ ...parts, treeA: parts.treeB, treeB: parts.treeA })).not.toBe(
      verdictKey(parts),
    );
  });

  it.each([
    ['a tree', { treeA: 'd'.repeat(40) }],
    ['the merge base', { mergeBaseSha: 'e'.repeat(40) }],
    ['the pair', { branchB: ulid<BranchRefId>() }],
    ['the toolchain', { fingerprint: 'other' }],
  ] as const)('differs with %s', (_, change) => {
    expect(verdictKey({ ...parts, ...change })).not.toBe(verdictKey(parts));
  });

  it('cannot be forged by a value that carries a separator', () => {
    const a = verdictKey({ ...parts, fingerprint: 'x","y' });
    const b = verdictKey({ ...parts, fingerprint: 'x', treeA: `y","${parts.treeA}` });
    expect(a).not.toBe(b);
  });
});

describe('toolchainFingerprint', () => {
  const textual = { analyzer: 'textual', version: 1, tools: ['git 2.55.0'] };

  it.each([
    ['a bumped version', { version: 2 }],
    ['another tool version', { tools: ['git 2.56.0'] }],
    ['another analyzer', { analyzer: 'typecheck' }],
  ] as const)('changes with %s', (_, change) => {
    expect(toolchainFingerprint({ ...textual, ...change })).not.toBe(toolchainFingerprint(textual));
  });
});
