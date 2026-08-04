import type { BranchRefId, FindingId, SpeculativeRunId } from '../ids.js';
import type { AnalyzerKind } from './speculative-run.js';

/**
 * A detected problem between two in-flight branches.
 *
 * Every Finding carries machine-checkable evidence. A detector that cannot
 * point at file spans, tool output or a symbol trail does not raise one.
 */
export interface Finding {
  readonly id: FindingId;
  readonly runId: SpeculativeRunId;
  readonly kind: AnalyzerKind;
  /** Rule that fired, e.g. `rename-vs-callsite`. Stable across releases. */
  readonly rule: string;
  readonly severity: Severity;
  /**
   * 0–1. Sandbox verdicts (typecheck/build/test) are ground truth and sit at 1;
   * AST heuristics report lower.
   */
  readonly confidence: number;
  readonly status: FindingStatus;
  /** One-line summary, written for both humans and agents. */
  readonly title: string;
  /** Longer explanation. Plain data, never instructions to an agent. */
  readonly description: string;
  /** Which branch contributed which half of the breakage. */
  readonly attribution: Attribution;
  readonly evidence: readonly Evidence[];
  readonly firstSeenAt: string;
  readonly updatedAt: string;
  /** Set when the finding stopped reproducing. */
  readonly resolvedAt: string | null;
}

export type Severity = 'info' | 'low' | 'medium' | 'high';

/**
 * `open` — reproduces on the latest snapshots.
 * `stale` — the branches moved and it has not been re-verified yet.
 * `resolved` — no longer reproduces.
 * `dismissed` — a human marked it as not a problem.
 */
export type FindingStatus = 'open' | 'stale' | 'resolved' | 'dismissed';

export interface Attribution {
  readonly branchA: BranchRefId;
  readonly branchB: BranchRefId;
  /** Which side introduced the change that broke the other, when determinable. */
  readonly originBranch: BranchRefId | null;
  readonly rationale: string;
}

export type Evidence =
  | SpanEvidence
  | ProcessOutputEvidence
  | SymbolTrailEvidence
  | TestEvidence;

/** A file/line span on one of the two branches. */
export interface SpanEvidence {
  readonly type: 'span';
  readonly branchRefId: BranchRefId;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Short excerpt, redacted. Never a whole file. */
  readonly excerpt: string;
}

/** Compiler, typechecker or build output from the sandbox. */
export interface ProcessOutputEvidence {
  readonly type: 'process-output';
  readonly tool: string;
  readonly exitCode: number;
  /** Truncated and redacted output. */
  readonly output: string;
  /** Diagnostics parsed back to source locations, when the tool allows it. */
  readonly locations: readonly SourceLocation[];
}

/** The symbol chain an AST matcher followed, e.g. rename → import → call site. */
export interface SymbolTrailEvidence {
  readonly type: 'symbol-trail';
  readonly steps: readonly SymbolTrailStep[];
}

export interface SymbolTrailStep {
  readonly branchRefId: BranchRefId;
  readonly symbol: string;
  readonly action: 'renamed' | 'deleted' | 'moved' | 'signature-changed' | 'referenced' | 'added';
  readonly location: SourceLocation;
}

export interface TestEvidence {
  readonly type: 'test';
  readonly testId: string;
  readonly status: 'failed' | 'errored';
  readonly message: string;
  readonly location: SourceLocation | null;
}

export interface SourceLocation {
  readonly path: string;
  readonly line: number;
  readonly column: number | null;
}

/** Ranking key: severity × confidence. */
export function findingWeight(finding: Finding): number {
  const severityWeight: Record<Severity, number> = { info: 0.1, low: 0.3, medium: 0.6, high: 1 };
  return severityWeight[finding.severity] * finding.confidence;
}
