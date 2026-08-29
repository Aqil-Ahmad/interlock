import type { FindingId, MergePairId, SnapshotId, SpeculativeRunId } from '../ids.js';

/**
 * One execution of merge + analyzers for a MergePair at specific snapshots.
 *
 * Runs are the cache unit, keyed by (snapshotA, snapshotB, analyzer, toolchain).
 */
export interface SpeculativeRun {
  readonly id: SpeculativeRunId;
  readonly mergePairId: MergePairId;
  /** Exact content both sides were at; makes the run reproducible. */
  readonly snapshotA: SnapshotId;
  readonly snapshotB: SnapshotId;
  readonly status: RunStatus;
  readonly mergeOutcome: MergeOutcome | null;
  readonly analyzerResults: readonly AnalyzerResult[];
  readonly findingIds: readonly FindingId[];
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
}

export const RUN_STATUSES = ['queued', 'running', 'complete', 'failed', 'superseded'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Result of the speculative merge itself, before any analyzer runs. */
export interface MergeOutcome {
  readonly clean: boolean;
  readonly conflictedPaths: readonly string[];
  /** Commit in the shadow repo holding the merged tree; null if the merge failed. */
  readonly mergedSha: string | null;
}

export const ANALYZER_KINDS = ['textual', 'typecheck', 'build', 'test', 'ast-semantic'] as const;
export type AnalyzerKind = (typeof ANALYZER_KINDS)[number];

export const ANALYZER_VERDICTS = [
  'clean',
  /** Analyzer found problems; see the Findings it produced. */
  'findings',
  /** Could not run — Docker down, toolchain missing. Never a Finding. */
  'infra-failure',
  'skipped',
  'timeout',
] as const;
export type AnalyzerVerdict = (typeof ANALYZER_VERDICTS)[number];

export interface AnalyzerResult {
  readonly analyzer: AnalyzerKind;
  readonly verdict: AnalyzerVerdict;
  readonly findingIds: readonly FindingId[];
  readonly durationMs: number;
  readonly cached: boolean;
  /** Populated for `infra-failure` / `timeout`; already redacted. */
  readonly diagnostic: string | null;
}
