import type {
  AgentSessionId,
  BranchRefId,
  ChangeSetId,
  FindingId,
  MergePairId,
  RepoId,
  SpeculativeRunId,
} from '../ids.js';
import type { AgentKind } from '../models/agent-session.js';
import type { AnalyzerKind, AnalyzerVerdict } from '../models/speculative-run.js';

/**
 * The internal event vocabulary.
 *
 * Components communicate over the bus and nothing else, which keeps the daemon
 * replayable from its log and keeps components testable without git, Docker or
 * the filesystem.
 *
 * To add an event: define the interface and add it to {@link InterlockEvent}.
 * The shape is a wire format from that point on — the log is persisted.
 */

interface EventBase {
  /** Repo the event concerns; null for daemon-lifecycle events. */
  readonly repoId: RepoId | null;
  readonly at: string;
}

// --- Watcher ----------------------------------------------------------------

export interface RepoDiscovered extends EventBase {
  readonly type: 'repo.discovered';
  readonly rootPath: string;
  readonly defaultBranch: string;
}

export interface BranchAppeared extends EventBase {
  readonly type: 'branch.appeared';
  readonly branchRefId: BranchRefId;
  readonly name: string;
  readonly headSha: string;
  readonly worktreePath: string | null;
}

export interface BranchUpdated extends EventBase {
  readonly type: 'branch.updated';
  readonly branchRefId: BranchRefId;
  readonly headSha: string;
  /**
   * `null` when the worktree could not be read, which is not the same as
   * clean. Folding the two together here would undo the distinction the store
   * keeps, one layer further out and in a log that is never re-derived.
   */
  readonly dirty: boolean | null;
}

export interface BranchDisappeared extends EventBase {
  readonly type: 'branch.disappeared';
  readonly branchRefId: BranchRefId;
  /**
   * Why it stopped being tracked.
   *
   * `deleted` — the branch is gone from the repository.
   * `ignored` — it still exists, and the repository asked to be left alone
   * about it. Without this the two are indistinguishable on replay, and a
   * branch the user merely excluded reads as one that was destroyed.
   */
  readonly reason: 'deleted' | 'ignored';
}

export interface WorkingTreeChanged extends EventBase {
  readonly type: 'worktree.changed';
  readonly branchRefId: BranchRefId;
  readonly changedPaths: readonly string[];
}

export interface ChangeSetComputed extends EventBase {
  readonly type: 'changeset.computed';
  readonly branchRefId: BranchRefId;
  readonly changeSetId: ChangeSetId;
  readonly fileCount: number;
}

// --- Agent sessions ---------------------------------------------------------

export interface SessionRegistered extends EventBase {
  readonly type: 'session.registered';
  readonly sessionId: AgentSessionId;
  readonly kind: AgentKind;
  readonly branchRefId: BranchRefId | null;
}

export interface SessionEnded extends EventBase {
  readonly type: 'session.ended';
  readonly sessionId: AgentSessionId;
}

// --- Scheduler and runs -----------------------------------------------------

export interface PairScheduled extends EventBase {
  readonly type: 'pair.scheduled';
  readonly mergePairId: MergePairId;
  readonly priority: number;
  readonly reason: 'new-pair' | 'branch-moved' | 'overlap' | 'manual' | 'retry';
}

export interface RunStarted extends EventBase {
  readonly type: 'run.started';
  readonly runId: SpeculativeRunId;
  readonly mergePairId: MergePairId;
}

export interface MergeCompleted extends EventBase {
  readonly type: 'run.merge-completed';
  readonly runId: SpeculativeRunId;
  readonly clean: boolean;
  readonly conflictedPaths: readonly string[];
}

export interface AnalyzerCompleted extends EventBase {
  readonly type: 'run.analyzer-completed';
  readonly runId: SpeculativeRunId;
  readonly analyzer: AnalyzerKind;
  readonly verdict: AnalyzerVerdict;
  readonly durationMs: number;
}

export interface RunFinished extends EventBase {
  readonly type: 'run.finished';
  readonly runId: SpeculativeRunId;
  readonly findingCount: number;
  readonly durationMs: number;
}

// --- Findings and advice ----------------------------------------------------

export interface FindingRaised extends EventBase {
  readonly type: 'finding.raised';
  readonly findingId: FindingId;
  readonly runId: SpeculativeRunId;
  readonly kind: AnalyzerKind;
  readonly rule: string;
}

export interface FindingResolved extends EventBase {
  readonly type: 'finding.resolved';
  readonly findingId: FindingId;
  readonly reason: 'no-longer-reproduces' | 'branch-gone' | 'dismissed';
}

export interface AdviceDelivered extends EventBase {
  readonly type: 'advice.delivered';
  readonly adviceId: string;
  readonly audienceBranch: BranchRefId | null;
  readonly channel: 'mcp' | 'cli' | 'dashboard';
}

// --- Daemon lifecycle -------------------------------------------------------

export interface DaemonStarted extends EventBase {
  readonly type: 'daemon.started';
  readonly version: string;
  readonly pid: number;
}

export interface DaemonStopping extends EventBase {
  readonly type: 'daemon.stopping';
  readonly reason: 'signal' | 'request' | 'fatal';
}

/** Environmental failure. Never surfaced as a Finding. */
export interface InfraFailure extends EventBase {
  readonly type: 'infra.failure';
  readonly component: string;
  readonly code: string;
  readonly message: string;
}

export type InterlockEvent =
  | RepoDiscovered
  | BranchAppeared
  | BranchUpdated
  | BranchDisappeared
  | WorkingTreeChanged
  | ChangeSetComputed
  | SessionRegistered
  | SessionEnded
  | PairScheduled
  | RunStarted
  | MergeCompleted
  | AnalyzerCompleted
  | RunFinished
  | FindingRaised
  | FindingResolved
  | AdviceDelivered
  | DaemonStarted
  | DaemonStopping
  | InfraFailure;

export type InterlockEventType = InterlockEvent['type'];

/** Narrow an event union member by its `type` tag. */
export type EventOf<T extends InterlockEventType> = Extract<InterlockEvent, { type: T }>;

/** Handler signature used by the daemon's bus. */
export type EventHandler<T extends InterlockEventType = InterlockEventType> = (
  event: EventOf<T>,
) => void | Promise<void>;
