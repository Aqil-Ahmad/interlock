import type { BranchRefId, ChangeSetId, SnapshotId } from '../ids.js';

/**
 * Normalized diff of a BranchRef against its merge-base.
 *
 * Consumed by the scheduler (file overlap → priority) and by the AST layer
 * (symbol overlap → candidate matchers).
 */
export interface ChangeSet {
  readonly id: ChangeSetId;
  readonly branchRefId: BranchRefId;
  /** Working-tree snapshot this diff was computed from; null when clean. */
  readonly snapshotId: SnapshotId | null;
  /** Commit both sides descend from. */
  readonly mergeBaseSha: string;
  readonly headSha: string;
  readonly files: readonly FileChange[];
  readonly computedAt: string;
}

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export interface FileChange {
  readonly path: string;
  /** Previous path for renames. */
  readonly previousPath: string | null;
  readonly kind: ChangeKind;
  readonly hunks: readonly Hunk[];
  /** Symbols touched by this change; populated by the AST layer. */
  readonly symbols: readonly SymbolRef[];
  /** True for files the analyzers cannot read as text (images, binaries). */
  readonly binary: boolean;
}

/** A contiguous changed region, in the coordinate space of both sides. */
export interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

export type SymbolKind =
  'function' | 'method' | 'class' | 'interface' | 'type' | 'variable' | 'enum' | 'module';

/**
 * A named program symbol, addressed well enough to compare across branches.
 *
 * Cross-branch matchers join on `qualifiedName`, so it must stay stable under
 * formatting changes.
 */
export interface SymbolRef {
  readonly path: string;
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  readonly exported: boolean;
  readonly startLine: number;
  readonly endLine: number;
}

/** Files touched by both change sets; the cheapest conflict signal available. */
export function overlappingPaths(a: ChangeSet, b: ChangeSet): string[] {
  const bPaths = new Set(b.files.map((f) => f.path));
  return a.files.map((f) => f.path).filter((p) => bPaths.has(p));
}
