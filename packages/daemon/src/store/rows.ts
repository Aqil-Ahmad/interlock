import {
  AGENT_KINDS,
  ANALYZER_KINDS,
  ANALYZER_VERDICTS,
  FINDING_STATUSES,
  InterlockError,
  RUN_STATUSES,
  SEVERITIES,
} from '@interlock/shared';
import type {
  AgentSession,
  AgentSessionId,
  AnalyzerResult,
  BranchRef,
  BranchRefId,
  ChangeSet,
  ChangeSetId,
  DirtyState,
  Evidence,
  FileChange,
  Finding,
  FindingId,
  InterlockEvent,
  MergeOutcome,
  MergePair,
  MergePairId,
  MergePairKey,
  Repo,
  RepoConfigOverride,
  RepoId,
  SnapshotId,
  SpeculativeRun,
  SpeculativeRunId,
  EventId,
  EventRecord,
} from '@interlock/shared';

/**
 * Translation between SQLite rows and the models in `@interlock/shared`.
 *
 * Separate from the statements that produce those rows because this is where a
 * distinction gets lost quietly: an unknown dirty state read back as clean, a
 * boolean stored as text, a JSON column that no longer parses. Pure functions,
 * so each of those is a unit test rather than a database.
 *
 * Scalar and enumerated columns are checked rather than cast. The schema is
 * STRICT, so a column of the wrong type means the file was written by something
 * other than this code, and a value that reaches a model unchecked fails
 * somewhere with no bearing on where the damage is. An unrecognised verdict is
 * the worse case: it reads as a real answer.
 *
 * JSON columns are parsed and trusted. Validating each would be a schema
 * library, and the shapes they hold are the models this process wrote — the
 * check that matters is that the text still parses at all.
 */

export type Row = Record<string, unknown>;

/** What a bound parameter may be. SQLite has no boolean and no `undefined`. */
export type Param = string | number | null;

export type Params = Record<string, Param>;

function corrupt(column: string, expected: string): InterlockError {
  return new InterlockError('STORE_UNAVAILABLE', `Column ${column} is not ${expected}`, {
    details: { column, expected },
    remedy: 'Stop the daemon and delete the store; it is rebuilt from the watched repositories.',
    infra: true,
  });
}

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw corrupt(column, 'text');
  return value;
}

export function textOrNull(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== 'string') throw corrupt(column, 'text or null');
  return value;
}

export function num(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number') throw corrupt(column, 'a number');
  return value;
}

export function numOrNull(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== 'number') throw corrupt(column, 'a number or null');
  return value;
}

/** SQLite stores booleans as 0 or 1; the schema constrains the column to both. */
export function bool(row: Row, column: string): boolean {
  return num(row, column) !== 0;
}

/**
 * Read a column whose value must come from a known set.
 *
 * The set is the model's own list, so a value that is not in it was written by
 * a different build. Refusing it is what keeps an unrecognised verdict from
 * reaching the scheduler as though an analyzer had returned it.
 */
export function oneOf<T extends string>(row: Row, column: string, allowed: readonly T[]): T {
  const value = text(row, column);
  if (!(allowed as readonly string[]).includes(value)) {
    throw corrupt(column, `one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/** The parsed shape is trusted; only the parse itself is checked. */
export function json<T>(row: Row, column: string): T {
  const raw = text(row, column);
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new InterlockError('STORE_UNAVAILABLE', `Column ${column} does not hold valid JSON`, {
      cause: error,
      details: { column },
      remedy: 'Stop the daemon and delete the store; it is rebuilt from the watched repositories.',
      infra: true,
    });
  }
}

export function jsonOrNull<T>(row: Row, column: string): T | null {
  return row[column] === null ? null : json<T>(row, column);
}

// --- Repo -------------------------------------------------------------------

export function toRepo(row: Row): Repo {
  return {
    id: text(row, 'id') as RepoId,
    rootPath: text(row, 'root_path'),
    defaultBranch: text(row, 'default_branch'),
    shadowPath: text(row, 'shadow_path'),
    config: json<RepoConfigOverride>(row, 'config'),
    discoveredAt: text(row, 'discovered_at'),
    lastSeenAt: text(row, 'last_seen_at'),
  };
}

export function repoParams(repo: Repo): Params {
  return {
    id: repo.id,
    root_path: repo.rootPath,
    default_branch: repo.defaultBranch,
    shadow_path: repo.shadowPath,
    config: JSON.stringify(repo.config),
    discovered_at: repo.discoveredAt,
    last_seen_at: repo.lastSeenAt,
  };
}

// --- BranchRef --------------------------------------------------------------

/**
 * `session_id` is not a column of `branch_refs`; the query that produces this
 * row derives it from the sessions pointing at the branch.
 */
export function toBranchRef(row: Row): BranchRef {
  return {
    id: text(row, 'id') as BranchRefId,
    repoId: text(row, 'repo_id') as RepoId,
    ref: text(row, 'ref'),
    name: text(row, 'name'),
    headSha: text(row, 'head_sha'),
    worktreePath: textOrNull(row, 'worktree_path'),
    dirty: jsonOrNull<DirtyState>(row, 'dirty'),
    sessionId: textOrNull(row, 'session_id') as AgentSessionId | null,
    firstSeenAt: text(row, 'first_seen_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

export function branchRefParams(ref: BranchRef): Params {
  return {
    id: ref.id,
    repo_id: ref.repoId,
    ref: ref.ref,
    name: ref.name,
    head_sha: ref.headSha,
    worktree_path: ref.worktreePath,
    // `null` survives as `null`: an unread worktree is not a clean one, and a
    // `JSON.stringify(null)` here would store the string "null" and read back
    // as a state rather than as the absence of one.
    dirty: ref.dirty === null ? null : JSON.stringify(ref.dirty),
    first_seen_at: ref.firstSeenAt,
    updated_at: ref.updatedAt,
  };
}

// --- AgentSession -----------------------------------------------------------

export function toSession(row: Row): AgentSession {
  return {
    id: text(row, 'id') as AgentSessionId,
    repoId: text(row, 'repo_id') as RepoId,
    kind: oneOf(row, 'kind', AGENT_KINDS),
    externalSessionId: textOrNull(row, 'external_session_id'),
    branchRefId: textOrNull(row, 'branch_ref_id') as BranchRefId | null,
    cwd: textOrNull(row, 'cwd'),
    startedAt: text(row, 'started_at'),
    lastActiveAt: text(row, 'last_active_at'),
    endedAt: textOrNull(row, 'ended_at'),
  };
}

export function sessionParams(session: AgentSession): Params {
  return {
    id: session.id,
    repo_id: session.repoId,
    kind: session.kind,
    external_session_id: session.externalSessionId,
    branch_ref_id: session.branchRefId,
    cwd: session.cwd,
    started_at: session.startedAt,
    last_active_at: session.lastActiveAt,
    ended_at: session.endedAt,
  };
}

// --- ChangeSet --------------------------------------------------------------

export function toChangeSet(row: Row): ChangeSet {
  return {
    id: text(row, 'id') as ChangeSetId,
    branchRefId: text(row, 'branch_ref_id') as BranchRefId,
    snapshotId: textOrNull(row, 'snapshot_id') as SnapshotId | null,
    mergeBaseSha: text(row, 'merge_base_sha'),
    headSha: text(row, 'head_sha'),
    files: json<FileChange[]>(row, 'files'),
    computedAt: text(row, 'computed_at'),
  };
}

export function changeSetParams(changeSet: ChangeSet): Params {
  return {
    id: changeSet.id,
    branch_ref_id: changeSet.branchRefId,
    snapshot_id: changeSet.snapshotId,
    merge_base_sha: changeSet.mergeBaseSha,
    head_sha: changeSet.headSha,
    files: JSON.stringify(changeSet.files),
    computed_at: changeSet.computedAt,
  };
}

// --- MergePair --------------------------------------------------------------

export function toMergePair(row: Row): MergePair {
  return {
    id: text(row, 'id') as MergePairId,
    repoId: text(row, 'repo_id') as RepoId,
    a: text(row, 'branch_a') as BranchRefId,
    b: text(row, 'branch_b') as BranchRefId,
    key: text(row, 'pair_key') as MergePairKey,
    mergeBaseSha: text(row, 'merge_base_sha'),
    priority: num(row, 'priority'),
    lastRunAt: textOrNull(row, 'last_run_at'),
    stale: bool(row, 'stale'),
  };
}

export function mergePairParams(pair: MergePair): Params {
  return {
    id: pair.id,
    repo_id: pair.repoId,
    branch_a: pair.a,
    branch_b: pair.b,
    pair_key: pair.key,
    merge_base_sha: pair.mergeBaseSha,
    priority: pair.priority,
    last_run_at: pair.lastRunAt,
    stale: pair.stale ? 1 : 0,
  };
}

// --- SpeculativeRun ---------------------------------------------------------

/** `findingIds` comes from the findings table, which is where it is recorded. */
export function toRun(row: Row, findingIds: readonly FindingId[]): SpeculativeRun {
  return {
    id: text(row, 'id') as SpeculativeRunId,
    mergePairId: text(row, 'merge_pair_id') as MergePairId,
    snapshotA: text(row, 'snapshot_a') as SnapshotId,
    snapshotB: text(row, 'snapshot_b') as SnapshotId,
    status: oneOf(row, 'status', RUN_STATUSES),
    mergeOutcome: jsonOrNull<MergeOutcome>(row, 'merge_outcome'),
    analyzerResults: json<AnalyzerResult[]>(row, 'analyzer_results'),
    findingIds,
    startedAt: text(row, 'started_at'),
    finishedAt: textOrNull(row, 'finished_at'),
    durationMs: numOrNull(row, 'duration_ms'),
  };
}

export function runParams(run: SpeculativeRun): Params {
  return {
    id: run.id,
    merge_pair_id: run.mergePairId,
    snapshot_a: run.snapshotA,
    snapshot_b: run.snapshotB,
    status: run.status,
    merge_outcome: run.mergeOutcome === null ? null : JSON.stringify(run.mergeOutcome),
    analyzer_results: JSON.stringify(run.analyzerResults),
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    duration_ms: run.durationMs,
  };
}

// --- Finding ----------------------------------------------------------------

export function toFinding(row: Row, evidence: readonly Evidence[]): Finding {
  return {
    id: text(row, 'id') as FindingId,
    runId: text(row, 'run_id') as SpeculativeRunId,
    kind: oneOf(row, 'kind', ANALYZER_KINDS),
    rule: text(row, 'rule'),
    severity: oneOf(row, 'severity', SEVERITIES),
    confidence: num(row, 'confidence'),
    status: oneOf(row, 'status', FINDING_STATUSES),
    title: text(row, 'title'),
    description: text(row, 'description'),
    attribution: {
      branchA: text(row, 'branch_a') as BranchRefId,
      branchB: text(row, 'branch_b') as BranchRefId,
      originBranch: textOrNull(row, 'origin_branch') as BranchRefId | null,
      rationale: text(row, 'attribution_rationale'),
    },
    evidence,
    firstSeenAt: text(row, 'first_seen_at'),
    updatedAt: text(row, 'updated_at'),
    resolvedAt: textOrNull(row, 'resolved_at'),
  };
}

export function findingParams(finding: Finding): Params {
  return {
    id: finding.id,
    run_id: finding.runId,
    kind: finding.kind,
    rule: finding.rule,
    severity: finding.severity,
    confidence: finding.confidence,
    status: finding.status,
    title: finding.title,
    description: finding.description,
    branch_a: finding.attribution.branchA,
    branch_b: finding.attribution.branchB,
    origin_branch: finding.attribution.originBranch,
    attribution_rationale: finding.attribution.rationale,
    first_seen_at: finding.firstSeenAt,
    updated_at: finding.updatedAt,
    resolved_at: finding.resolvedAt,
  };
}

export function toEvidence(row: Row): Evidence {
  return json<Evidence>(row, 'body');
}

export function evidenceParams(findingId: FindingId, ordinal: number, evidence: Evidence): Params {
  return {
    finding_id: findingId,
    ordinal,
    // Duplicated out of the body so a query can count evidence by type without
    // parsing every row.
    type: evidence.type,
    body: JSON.stringify(evidence),
  };
}

// --- EventRecord ------------------------------------------------------------

export function toEventRecord(row: Row): EventRecord {
  return {
    id: text(row, 'id') as EventId,
    repoId: textOrNull(row, 'repo_id') as RepoId | null,
    type: text(row, 'type') as InterlockEvent['type'],
    payload: json<InterlockEvent>(row, 'payload'),
    at: text(row, 'at'),
    causedBy: textOrNull(row, 'caused_by') as EventId | null,
  };
}

export function eventParams(record: EventRecord): Params {
  return {
    id: record.id,
    repo_id: record.repoId,
    type: record.type,
    payload: JSON.stringify(record.payload),
    at: record.at,
    caused_by: record.causedBy,
  };
}

// --- Analyzer cache ---------------------------------------------------------

/**
 * `cached` is true for every result read from here — it describes how the
 * caller obtained the result, not what the result was, so it is answered rather
 * than stored.
 */
export function toAnalyzerResult(row: Row): AnalyzerResult {
  return {
    analyzer: oneOf(row, 'analyzer', ANALYZER_KINDS),
    verdict: oneOf(row, 'verdict', ANALYZER_VERDICTS),
    findingIds: json<FindingId[]>(row, 'finding_ids'),
    durationMs: num(row, 'duration_ms'),
    cached: true,
    diagnostic: textOrNull(row, 'diagnostic'),
  };
}

export function analyzerCacheParams(
  key: string,
  result: AnalyzerResult,
  createdAt: string,
): Params {
  return {
    key,
    analyzer: result.analyzer,
    verdict: result.verdict,
    finding_ids: JSON.stringify(result.findingIds),
    duration_ms: result.durationMs,
    diagnostic: result.diagnostic,
    created_at: createdAt,
  };
}
