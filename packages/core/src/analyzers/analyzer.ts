import { redact } from '@interlock/shared';
import type {
  AnalyzerKind,
  AnalyzerVerdict,
  BranchRefId,
  ChangeSet,
  Finding,
  InterlockError,
  Logger,
  SpeculativeRunId,
} from '@interlock/shared';
import type { GitRunner } from '../git/repo-handle.js';
import type { PoolSlot } from '../git/worktree-pool.js';
import type {
  SpeculativeMergeRequest,
  SpeculativeMergeResult,
} from '../merge/speculative-merge.js';

/**
 * The analyzer contract.
 *
 * Analyzers form a pipeline ordered cheapest first: textual → ast-semantic →
 * typecheck → build → test. Each sees the merged shadow tree plus both sides'
 * ChangeSets and returns Findings with evidence, or a non-verdict.
 *
 * Two rules every implementation must respect:
 *  1. An analyzer that cannot run returns `infra-failure`; it never invents a
 *     Finding, and an infra failure is never shown to the user as a conflict.
 *  2. Anything executing repository code goes through the sandbox.
 */
export interface Analyzer {
  readonly kind: AnalyzerKind;
  /** Stable rule prefix used in Finding ids and evaluation reports. */
  readonly name: string;
  /**
   * Bumped whenever a change to this analyzer's logic could change a verdict.
   *
   * Verdicts are cached on the content they judged, and content never goes
   * stale — so a fixed bug would keep being served from the cache for every
   * pair already judged, until the version it is keyed under changes.
   */
  readonly version: number;

  /**
   * Whether this analyzer reads the merged tree from disk, in the pair's pool
   * slot (`context.slot`).
   *
   * Required, so no analyzer can be written without deciding: the slot is
   * null for a clean merge whose dependencies differ from the installed tree,
   * and an analyzer that needs it cannot run then. The pipeline answers that
   * case `infra-failure` without calling `analyze`, rather than trust whatever
   * an analyzer handed a null slot would say — `clean`, most likely.
   */
  readonly needsSlot: boolean;

  /**
   * Cheap pre-check: can this analyzer produce anything useful for this run?
   * Skips, for example, the typechecker when no source file changed.
   */
  appliesTo(context: AnalyzerContext): boolean;

  analyze(context: AnalyzerContext): Promise<AnalyzerOutcome>;
}

export interface AnalyzerContext {
  readonly runId: SpeculativeRunId;
  readonly branchA: BranchRefId;
  readonly branchB: BranchRefId;
  /**
   * Each side's diff against its merge base with the default branch; null for
   * a branch with no worktree to diff, which the watcher never snapshots.
   */
  readonly changeSetA: ChangeSet | null;
  readonly changeSetB: ChangeSet | null;
  /** The merge as it was asked for: the shadow, both commits and the merge base. */
  readonly mergeRequest: SpeculativeMergeRequest;
  readonly merged: SpeculativeMergeResult;
  /**
   * The merged tree on disk, in the pair's pool slot, for an analyzer that
   * needs real files. Null for a conflicted merge, which never enters a slot,
   * and for a pair whose dependencies differ from the installed tree. Held for
   * this run alone: valid until `analyze` settles, and never executed on the
   * host.
   */
  readonly slot: PoolSlot | null;
  /** Reads the shadow; `mergeRequest.shadow` is the only repository it is given. */
  readonly runner: GitRunner;
  readonly logger: Logger;
  /** Aborted when the run is superseded by newer snapshots. */
  readonly signal: AbortSignal;
}

export interface AnalyzerOutcome {
  readonly verdict: AnalyzerVerdict;
  readonly findings: readonly Finding[];
  /** Redacted diagnostic for `infra-failure` / `timeout`. */
  readonly diagnostic?: string;
}

export const CLEAN: AnalyzerOutcome = { verdict: 'clean', findings: [] };

export function infraFailure(diagnostic: string): AnalyzerOutcome {
  return { verdict: 'infra-failure', findings: [], diagnostic };
}

/**
 * An infrastructure error as an analyzer's non-verdict: its code, its message
 * and its remedy, redacted.
 *
 * The remedy is what a person acts on — start Docker, pull the image — and the
 * code is what a script matches on, so both travel to where the failure is
 * shown. Details stay out: they carry paths, and nothing here needs them.
 */
export function infraFailureFrom(error: InterlockError): AnalyzerOutcome {
  const remedy = error.remedy === undefined ? '' : ` (${error.remedy})`;
  return infraFailure(redact(`${error.code}: ${error.message}${remedy}`));
}
