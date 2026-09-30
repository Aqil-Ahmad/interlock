/**
 * The golden fixture format.
 *
 * A fixture is data: files, the operations two branches apply to them, and what
 * an analyzer should find. No fixture carries code, so any one of them can be
 * read, reviewed and diffed on its own, and one generator builds them all.
 *
 * Frozen once written. A fixture's `id` names it in every report; changing an
 * id, a file or an expectation after results exist makes two reports stop
 * describing the same thing. Add a fixture instead.
 */
import type { AnalyzerKind } from '../../packages/shared/src/index.js';

export interface Fixture {
  /** Stable, lowercase-kebab, unique across the set: the report's key. */
  readonly id: string;
  /** One line, for a human reading the report. */
  readonly title: string;
  /** The case in `plan_docs/evaluation.md` this fixture stands for. */
  readonly covers: FixtureCase;
  /** The files every branch starts from, committed on `main`. */
  readonly base: Readonly<Record<string, string>>;
  readonly a: BranchSpec;
  readonly b: BranchSpec;
  /**
   * What should be found. Empty for a negative twin: a pair built to look like
   * a conflict that is genuinely independent, where anything found is a false
   * positive.
   */
  readonly expected: readonly Expectation[];
  /** For a twin, the conflicting fixture it mirrors; null for a conflict. */
  readonly twinOf: string | null;
  /**
   * For a case the protocol lists that no analyzer in this design is meant to
   * catch, why not. Its `expected` is empty, and anything found on it is a
   * false positive, as on a twin; the report lists it with this reason, so the
   * case stays visible rather than dropped. Absent everywhere else.
   */
  readonly notDetected?: string;
}

/**
 * What one branch does, in order: `committed` on the branch, then
 * `uncommitted` left in its worktree.
 *
 * Both halves matter. The watcher snapshots each worktree, dirty state
 * included, and that snapshot is what Interlock merges — so an edit an agent
 * has not committed is as much a side of the pair as one it has.
 */
export interface BranchSpec {
  readonly committed: readonly Operation[];
  readonly uncommitted: readonly Operation[];
}

export type Operation =
  | { readonly op: 'write'; readonly path: string; readonly content: string }
  | { readonly op: 'delete'; readonly path: string }
  /** Content moves unchanged; a `write` after it edits the file at its new path. */
  | { readonly op: 'rename'; readonly from: string; readonly to: string };

export interface Expectation {
  readonly analyzer: AnalyzerKind;
  /** The rule the Finding carries: a textual conflict class, or a semantic rule. */
  readonly class: string;
  /**
   * The path the finding is about: where git records a textual conflict — after
   * a rename, the new path — or the file a semantic breakage surfaces in.
   */
  readonly path: string;
  /** An identifier the finding's evidence has to name. */
  readonly symbol: string;
  /** Branch `a`'s lines, in its own copy of the file; null where it has none. */
  readonly spanA: Span | null;
  readonly spanB: Span | null;
}

/** Lines, 1-based and inclusive, in one branch's own copy of `path`. */
export interface Span {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

/** The cases `plan_docs/evaluation.md` names, and the textual classes M2 adds to them. */
export const FIXTURE_CASES = [
  'textual-overlap',
  'adjacent-addition',
  'add-add',
  'edit-delete',
  'rename-edit',
  'rename-delete',
  'rename-vs-callsite',
  'signature-vs-caller',
  'moved-export-vs-import',
  'same-symbol-dual-edit',
  'duplicate-implementation',
] as const;
export type FixtureCase = (typeof FIXTURE_CASES)[number];
