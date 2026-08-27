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
  /**
   * Working-tree snapshot this diff was computed from, or `null` when the
   * branch head was compared instead.
   *
   * Not the same as "the worktree was clean": a dirty branch nobody snapshotted
   * produces a head-only change set that reads identically, so this says which
   * side was compared and never whether uncommitted work existed.
   */
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

/**
 * Files touched by both change sets; the cheapest conflict signal available.
 *
 * A rename counts under both of its names. Renaming a file on one branch while
 * the other edits it is a conflict git cannot resolve, and comparing only where
 * each file ended up cannot see it — the two sides never name the same path.
 * `touchedPaths` answers the same question the same way, and the two must agree
 * or a pair is prioritised by one and dropped by the other.
 */
export function overlappingPaths(a: ChangeSet, b: ChangeSet): string[] {
  const names = (files: readonly FileChange[]): string[] =>
    files.flatMap((file) =>
      file.previousPath === null ? [file.path] : [file.path, file.previousPath],
    );

  const bNames = new Set(names(b.files));
  // Deduplicated: one rename on each side of the same path would otherwise
  // report it twice, and a count of overlapping files is what reads this.
  return [...new Set(names(a.files).filter((name) => bNames.has(name)))];
}
