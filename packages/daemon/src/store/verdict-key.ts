import type { BranchRefId } from '@interlock/shared';

/**
 * What a cached verdict is keyed on: the content an analyzer judged, and the
 * analyzer that judged it.
 */
export interface VerdictKeyParts {
  /** From {@link toolchainFingerprint}: the analyzer, its version and its toolchain. */
  readonly fingerprint: string;
  readonly branchA: BranchRefId;
  readonly treeA: string;
  readonly branchB: BranchRefId;
  readonly treeB: string;
  /** The same two trees merged from another base are another merge. */
  readonly mergeBaseSha: string;
}

/**
 * The cache key for a verdict.
 *
 * Content, not snapshot ids: an id is minted per capture, so the same work
 * captured twice would never hit. Each tree stays attached to its branch, and
 * the two sides are put in the pair's own order — by branch id — so the
 * argument order cannot matter while swapped content still does: the same
 * two trees on the other branches are a merge with its stages and its
 * attribution the other way round.
 *
 * The branches are part of it because Findings are never copied. A hit can
 * only point at Findings its own pair raised, and another pair with identical
 * trees — a branch just cut from another — would otherwise be answered with
 * Findings attributed to someone else.
 *
 * JSON rather than a joined string, so no value can forge a boundary.
 */
export function verdictKey(parts: VerdictKeyParts): string {
  const a = [parts.branchA, parts.treeA] as const;
  const b = [parts.branchB, parts.treeB] as const;
  const [first, second] = parts.branchA < parts.branchB ? [a, b] : [b, a];
  return JSON.stringify([parts.fingerprint, ...first, ...second, parts.mergeBaseSha]);
}

/** What an analyzer's verdict depends on besides the content. */
export interface Toolchain {
  readonly analyzer: string;
  /** Bumped with the analyzer's logic, so a fixed bug stops being served. */
  readonly version: number;
  /** Each tool the verdict came through, with its version: `git 2.55.0`. */
  readonly tools: readonly string[];
}

/**
 * One analyzer's toolchain as a string: its name, its version, and every tool
 * its verdict came through. A change to any of them is a miss, which is the
 * only invalidation a content-keyed cache needs.
 */
export function toolchainFingerprint(toolchain: Toolchain): string {
  return JSON.stringify([toolchain.analyzer, toolchain.version, ...toolchain.tools]);
}
