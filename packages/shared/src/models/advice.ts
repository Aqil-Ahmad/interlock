import type { AdviceId, BranchRefId, FindingId, RepoId } from '../ids.js';

/**
 * Actionable guidance derived from Findings.
 *
 * This is what actually reaches an agent, so payloads stay small and
 * evidence-linked; delivery is rate-limited by the daemon.
 */
export interface Advice {
  readonly id: AdviceId;
  readonly repoId: RepoId;
  readonly kind: AdviceKind;
  /** The branch this advice is addressed to; null for repo-wide advice. */
  readonly audienceBranch: BranchRefId | null;
  readonly findingIds: readonly FindingId[];
  /** Short, imperative, action-oriented. This is the text an agent sees. */
  readonly headline: string;
  readonly detail: string;
  readonly payload: AdvicePayload;
  readonly createdAt: string;
  /** Set once the advice has been handed to an agent, for rate limiting. */
  readonly deliveredAt: string | null;
}

export type AdviceKind = 'warn-agent' | 'merge-order' | 'explanation' | 'draft-resolution';

export type AdvicePayload = WarnAgentPayload | MergeOrderPayload | ExplanationPayload;

export interface WarnAgentPayload {
  readonly kind: 'warn-agent';
  readonly conflictingBranch: string;
  readonly paths: readonly string[];
  readonly symbols: readonly string[];
  readonly suggestion: string;
}

/** Recommended landing order across N branches. */
export interface MergeOrderPayload {
  readonly kind: 'merge-order';
  readonly order: readonly BranchRefId[];
  /** Expected conflict hunks avoided versus naive FIFO, from shadow simulation. */
  readonly expectedSavings: number;
  readonly rationale: readonly string[];
}

/** Optional LLM-generated prose. Off by default and always labelled as such. */
export interface ExplanationPayload {
  readonly kind: 'explanation';
  readonly text: string;
  readonly model: string;
  readonly generatedAt: string;
}
