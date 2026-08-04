import type {
  AnalyzerKind,
  AnalyzerVerdict,
  BranchRefId,
  ChangeSet,
  Finding,
  Logger,
  SpeculativeRunId,
} from '@interlock/shared';
import type { ShadowWorktree } from '../git/shadow.js';
import type { SpeculativeMergeResult } from '../merge/speculative-merge.js';

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
  readonly changeSetA: ChangeSet;
  readonly changeSetB: ChangeSet;
  /** The merged tree, checked out in a disposable shadow worktree. */
  readonly merged: SpeculativeMergeResult;
  readonly worktree: ShadowWorktree;
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
