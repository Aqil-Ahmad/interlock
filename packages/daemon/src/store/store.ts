import { chmodSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { InterlockError, isInterlockError, silentLogger } from '@interlock/shared';
import type {
  AgentSession,
  AnalyzerResult,
  BranchRef,
  ChangeSet,
  EventRecord,
  Evidence,
  Finding,
  FindingId,
  Logger,
  MergePair,
  Repo,
  SpeculativeRun,
} from '@interlock/shared';
import { ensureDataDir } from '../data-dir.js';
import { runMigrations } from './migrations/index.js';
import {
  analyzerCacheParams,
  branchRefParams,
  changeSetParams,
  eventParams,
  evidenceParams,
  findingParams,
  mergePairParams,
  repoParams,
  runParams,
  sessionParams,
  text,
  toCachedVerdict,
  toBranchRef,
  toChangeSet,
  toEventRecord,
  toEvidence,
  toFinding,
  toMergePair,
  toRepo,
  toRun,
  toSession,
} from './rows.js';
import type { CachedVerdict, Row } from './rows.js';

export type { CachedVerdict } from './rows.js';

/**
 * SQLite persistence.
 *
 * Migrations exist from the first schema onward: the store outlives every
 * refactor, and a corrupt local database costs an afternoon.
 *
 * Built on `node:sqlite`, which ships with Node and keeps the daemon free of a
 * native dependency. Its API is synchronous while this interface is not, so a
 * later move to a driver that does real I/O off-thread does not become a change
 * to every caller.
 *
 * The database lives under the Interlock data dir with owner-only permissions.
 * It holds no secrets and no full file contents — evidence stores spans and
 * truncated excerpts.
 *
 * A constraint violation reaches the caller as the driver's own error rather
 * than an {@link InterlockError}: it means this code wrote a row naming a
 * parent that does not exist, which is a bug here, and `infra` would file it as
 * an environment failure. The message names the constraint that refused it.
 */

export interface Store {
  /**
   * Insert or reconcile a repository, returning the stored row.
   *
   * Reconciliation is on `rootPath`, because discovery mints a fresh ULID for
   * every observation. The returned repo carries the id and `shadowPath` that
   * won, which is what later writes have to reference — the argument's id may
   * have been discarded.
   */
  upsertRepo(repo: Repo): Promise<Repo>;
  listRepos(): Promise<Repo[]>;
  /** One indexed lookup on the unique key, for a sweep that asks per repository. */
  getRepoByPath(rootPath: Repo['rootPath']): Promise<Repo | null>;

  /**
   * Insert or reconcile a branch, returning the stored row.
   *
   * Reconciliation is on `(repoId, ref)`. `firstSeenAt` is a property of the
   * first observation and survives later ones; `sessionId` is ignored, since
   * attribution is written through {@link Store.upsertSession} and derived back
   * from it — discovery re-lists every branch with no session attached.
   */
  upsertBranchRef(ref: BranchRef): Promise<BranchRef>;
  listBranchRefs(repoId: Repo['id']): Promise<BranchRef[]>;
  /**
   * Remove a branch that no longer exists, and with it — by cascade — its merge
   * pairs and its change sets.
   *
   * Reconciliation is otherwise upsert-only, so without this a branch deleted
   * after it was merged keeps its rows for good: `prune` deliberately keeps each
   * branch's newest change set, so retention never reaches them either.
   */
  deleteBranchRef(id: BranchRef['id']): Promise<void>;

  upsertSession(session: AgentSession): Promise<void>;
  listSessions(repoId: Repo['id']): Promise<AgentSession[]>;

  upsertChangeSet(changeSet: ChangeSet): Promise<void>;
  getChangeSet(id: ChangeSet['id']): Promise<ChangeSet | null>;

  /** Reconciled on `key`, so `(A,B)` and `(B,A)` remain one row. */
  upsertMergePair(pair: MergePair): Promise<MergePair>;
  listMergePairs(repoId: Repo['id']): Promise<MergePair[]>;

  upsertRun(run: SpeculativeRun): Promise<void>;
  getRun(id: SpeculativeRun['id']): Promise<SpeculativeRun | null>;

  upsertFinding(finding: Finding): Promise<void>;
  getFinding(id: Finding['id']): Promise<Finding | null>;
  /** Findings that reproduce on the latest snapshots; stale ones are excluded. */
  listOpenFindings(repoId: Repo['id']): Promise<Finding[]>;
  /**
   * Findings still in play, open or stale: what retention keeps however old,
   * and so what a shadow must keep the evidence of.
   */
  listLiveFindings(repoId: Repo['id']): Promise<Finding[]>;

  /** Append-only: there is no update or delete path for events. */
  appendEvent(record: EventRecord): Promise<void>;
  /**
   * Replay in id order; ULIDs sort by creation time.
   *
   * Paged, so a {@link Store.prune} running against a long replay can remove
   * rows the iteration has not reached. That is retention doing its job, and a
   * replay older than the window was already incomplete.
   */
  readEvents(since?: EventRecord['id']): AsyncIterable<EventRecord>;

  /**
   * The verdict an analyzer reached on some content, keyed by `verdictKey`:
   * the pair in its own order, each side's tree, the merge base, the analyzer
   * and its toolchain fingerprint. Content never goes stale — another tree is
   * another key — so an entry is invalidated only by a new fingerprint, and
   * removed with the run it came from or by {@link Store.prune}.
   */
  getCachedVerdict(key: string): Promise<CachedVerdict | null>;
  /**
   * Remember a verdict, and say whether it was worth remembering.
   *
   * Only a verdict about the content is: `clean` or `findings`. An
   * `infra-failure` or a `timeout` describes the environment at one moment, and
   * cached it would turn a transient outage into a permanent answer for that
   * content; `skipped` describes nothing. Those are refused here, once, rather
   * than at every call site.
   */
  putCachedVerdict(key: string, verdict: CachedVerdict): Promise<boolean>;

  /**
   * Enforce retention: delete what is older than `before` and nothing still in
   * use — a run holding an open or stale Finding, the events that trace it back
   * to the edit behind it, a branch's newest change set.
   *
   * In small batches, each its own transaction, yielding between them: SQLite
   * has one writer, and one transaction over a window's worth of rows would
   * hold the run pipeline's writes for as long as it took. A call made while a
   * pass is running joins it rather than starting another, and gets that pass's
   * report — its cutoff, not the one it asked for.
   */
  prune(before: string, options?: PruneOptions): Promise<PruneReport>;

  close(): Promise<void>;
}

export interface PruneOptions {
  /** Rows per transaction. A test lowers it to see a pass split into batches. */
  readonly batchSize?: number;
  /**
   * When the process that owns the store started.
   *
   * A run is `running` from its start until it records how it ended, so the
   * row of one still in flight and the row of one a crashed daemon left behind
   * look alike, however old. Only one process holds a data dir at a time, so a
   * run started before this one was can be in flight in nothing: it is
   * abandoned, and only such a run is pruned unfinished. Left out, none is.
   */
  readonly abandonedBefore?: string;
}

/** What one pass deleted, by the table retention targets; cascades are not counted. */
export interface PruneReport {
  readonly events: number;
  /** Finished runs, and runs a daemon that died mid-run left unfinished. */
  readonly runs: number;
  readonly changeSets: number;
  readonly verdicts: number;
  readonly sessions: number;
  /** Transactions the pass took. */
  readonly batches: number;
  /** The longest any one of them held the writer. */
  readonly longestBatchMs: number;
  readonly durationMs: number;
  /** False when the store closed part-way; the next pass carries on. */
  readonly complete: boolean;
}

export interface StoreOptions {
  /** Absolute path to the SQLite file, or `:memory:` in tests. */
  readonly path: string;
  readonly logger?: Logger;
}

/** The verdicts {@link Store.putCachedVerdict} keeps: the ones about the content. */
const CACHEABLE_VERDICTS: ReadonlySet<AnalyzerResult['verdict']> = new Set(['clean', 'findings']);

/** The in-memory database SQLite recognises by name rather than by path. */
const MEMORY_PATH = ':memory:';

/** Owner-only. An executable bit means nothing on a database. */
const DB_FILE_MODE = 0o600;

/**
 * A second daemon overlapping a restart should wait for the first to finish its
 * transaction rather than fail instantly. Everything else reaches the store
 * through the API, so contention beyond that is a bug rather than a load level.
 */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Rows each retention transaction deletes, per table.
 *
 * Small enough that a batch holds the writer for milliseconds — the run
 * pipeline writes a run, its events and its Findings between batches — and
 * large enough that a pass over one timer interval's worth of aged rows is a
 * handful of batches.
 */
const PRUNE_BATCH = 500;

/**
 * Rows per batch when replaying the event log.
 *
 * The log is read as an async iterable, so a consumer holds it open across
 * ticks. Paginating keeps memory bounded and, more importantly, keeps a read
 * snapshot from being pinned for as long as the slowest consumer takes.
 */
const EVENT_REPLAY_BATCH = 500;

/**
 * The row a `RETURNING` clause produced.
 *
 * It always produces one; the driver's signature cannot say so, and reading
 * `undefined` as an empty row reports the failure as a corrupt column
 * somewhere downstream.
 */
function returned(row: Row | undefined): Row {
  if (row === undefined) {
    throw new InterlockError('STORE_UNAVAILABLE', 'An upsert returned no row', {
      remedy: 'Report this with the daemon log.',
      infra: true,
    });
  }
  return row;
}

/**
 * Run synchronous work as a promise.
 *
 * `node:sqlite` is synchronous while this interface is not, and a method that
 * throws where it says it rejects breaks every caller attaching `.catch`.
 */
function settled<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

export function openStore(options: StoreOptions): Promise<Store> {
  try {
    return Promise.resolve(open(options));
  } catch (error) {
    if (isInterlockError(error)) return Promise.reject(error);
    return Promise.reject(
      new InterlockError('STORE_UNAVAILABLE', 'The store could not be opened', {
        cause: error,
        details: { path: options.path },
        remedy: 'Check that the data directory exists and is writable by this user.',
        infra: true,
      }),
    );
  }
}

function open(options: StoreOptions): Store {
  const log = (options.logger ?? silentLogger).child('store');
  const path = options.path;

  if (path !== MEMORY_PATH && !isAbsolute(path)) {
    throw new InterlockError('CONFIG_INVALID', 'The store path must be absolute', {
      details: { path },
      remedy: `Pass an absolute path, or "${MEMORY_PATH}" for a database that is not persisted.`,
    });
  }

  // `openStore` takes any path, so the directory it lands in is not necessarily
  // Interlock's own; the shared helper is what keeps this and the token file
  // from disagreeing about the mode of a directory they both create.
  if (path !== MEMORY_PATH) ensureDataDir(dirname(path), log);

  // Foreign keys are on by default; pinning it here keeps a change to that
  // default from quietly turning the cascades into dangling rows.
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });

  if (path !== MEMORY_PATH) {
    // Before write-ahead logging is enabled, because SQLite creates `-wal` and
    // `-shm` with the mode the database file has at the time — and the `-wal`
    // holds recently written rows.
    chmodSync(path, DB_FILE_MODE);
  }

  const journalRow = db.prepare('PRAGMA journal_mode = WAL').get() ?? {};
  const journalMode = text(journalRow, 'journal_mode');
  if (path !== MEMORY_PATH && journalMode !== 'wal') {
    // Some filesystems — network mounts in particular — cannot do WAL. That is
    // slower and noisier, not broken, so it is reported rather than fatal.
    log.warn('write-ahead logging unavailable', { journalMode });
  }

  db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
  // With WAL, NORMAL loses at most the last transaction to a power cut. The
  // store is a record of observable git state, which the next sweep re-derives.
  db.exec('PRAGMA synchronous = NORMAL');

  const version = runMigrations(db, log);
  log.info('store opened', { schemaVersion: version, journalMode });

  return new SqliteStore(db, log);
}

/**
 * `branch_refs` has no `session_id` column: the owning session is whichever
 * live session points at the branch, most recently active first. Two sessions
 * can claim one branch — a stale one that never fired its end hook and the one
 * really driving it — and the model has room for a single answer.
 */
const BRANCH_REF_COLUMNS = `
  b.*,
  (SELECT s.id FROM agent_sessions s
    WHERE s.branch_ref_id = b.id AND s.ended_at IS NULL
    ORDER BY s.last_active_at DESC, s.id DESC
    LIMIT 1) AS session_id
`;

class SqliteStore implements Store {
  readonly #db: DatabaseSync;
  readonly #log: Logger;
  #closed = false;

  /**
   * Every statement is prepared at open time so a mistake in one is a startup
   * failure rather than a crash on whichever path first reaches it.
   */
  readonly #statements: {
    readonly upsertRepo: StatementSync;
    readonly listRepos: StatementSync;
    readonly repoByPath: StatementSync;
    readonly upsertBranchRef: StatementSync;
    readonly branchRefById: StatementSync;
    readonly listBranchRefs: StatementSync;
    readonly deleteBranchRef: StatementSync;
    readonly upsertSession: StatementSync;
    readonly listSessions: StatementSync;
    readonly upsertChangeSet: StatementSync;
    readonly changeSetById: StatementSync;
    readonly upsertMergePair: StatementSync;
    readonly listMergePairs: StatementSync;
    readonly upsertRun: StatementSync;
    readonly runById: StatementSync;
    readonly findingIdsForRun: StatementSync;
    readonly upsertFinding: StatementSync;
    readonly deleteEvidence: StatementSync;
    readonly insertEvidence: StatementSync;
    readonly findingById: StatementSync;
    readonly evidenceForFinding: StatementSync;
    readonly openFindings: StatementSync;
    readonly openFindingEvidence: StatementSync;
    readonly liveFindings: StatementSync;
    readonly liveFindingEvidence: StatementSync;
    readonly appendEvent: StatementSync;
    readonly maxEventId: StatementSync;
    readonly eventPage: StatementSync;
    readonly getVerdict: StatementSync;
    readonly putVerdict: StatementSync;
    readonly pruneEvents: StatementSync;
    readonly pruneRuns: StatementSync;
    readonly pruneUnfinishedRuns: StatementSync;
    readonly pruneChangeSets: StatementSync;
    readonly pruneVerdicts: StatementSync;
    readonly pruneSessions: StatementSync;
  };
  /** The pass in progress, which a second call joins. */
  #pruning: Promise<PruneReport> | null = null;

  constructor(db: DatabaseSync, log: Logger) {
    this.#db = db;
    this.#log = log;
    this.#statements = {
      upsertRepo: db.prepare(`
        INSERT INTO repos (id, root_path, default_branch, shadow_path, config, discovered_at, last_seen_at)
        VALUES (:id, :root_path, :default_branch, :shadow_path, :config, :discovered_at, :last_seen_at)
        ON CONFLICT (root_path) DO UPDATE SET
          default_branch = excluded.default_branch,
          config         = excluded.config,
          last_seen_at   = excluded.last_seen_at
        RETURNING *`),
      listRepos: db.prepare('SELECT * FROM repos ORDER BY root_path'),
      repoByPath: db.prepare('SELECT * FROM repos WHERE root_path = ?'),

      upsertBranchRef: db.prepare(`
        INSERT INTO branch_refs (id, repo_id, ref, name, head_sha, worktree_path, dirty, first_seen_at, updated_at)
        VALUES (:id, :repo_id, :ref, :name, :head_sha, :worktree_path, :dirty, :first_seen_at, :updated_at)
        ON CONFLICT (repo_id, ref) DO UPDATE SET
          name          = excluded.name,
          head_sha      = excluded.head_sha,
          worktree_path = excluded.worktree_path,
          dirty         = excluded.dirty,
          updated_at    = excluded.updated_at
        RETURNING id`),
      branchRefById: db.prepare(`SELECT ${BRANCH_REF_COLUMNS} FROM branch_refs b WHERE b.id = ?`),
      listBranchRefs: db.prepare(
        `SELECT ${BRANCH_REF_COLUMNS} FROM branch_refs b WHERE b.repo_id = ? ORDER BY b.name`,
      ),

      deleteBranchRef: db.prepare('DELETE FROM branch_refs WHERE id = ?'),

      upsertSession: db.prepare(`
        INSERT INTO agent_sessions (id, repo_id, kind, external_session_id, branch_ref_id, attribution, cwd, pid, started_at, last_active_at, ended_at)
        VALUES (:id, :repo_id, :kind, :external_session_id, :branch_ref_id, :attribution, :cwd, :pid, :started_at, :last_active_at, :ended_at)
        ON CONFLICT (id) DO UPDATE SET
          kind                = excluded.kind,
          external_session_id = excluded.external_session_id,
          branch_ref_id       = excluded.branch_ref_id,
          attribution         = excluded.attribution,
          cwd                 = excluded.cwd,
          pid                 = excluded.pid,
          last_active_at      = excluded.last_active_at,
          ended_at            = excluded.ended_at`),
      listSessions: db.prepare(
        'SELECT * FROM agent_sessions WHERE repo_id = ? ORDER BY started_at, id',
      ),

      upsertChangeSet: db.prepare(`
        INSERT INTO change_sets (id, branch_ref_id, snapshot_id, merge_base_sha, head_sha, files, computed_at)
        VALUES (:id, :branch_ref_id, :snapshot_id, :merge_base_sha, :head_sha, :files, :computed_at)
        ON CONFLICT (id) DO UPDATE SET
          snapshot_id    = excluded.snapshot_id,
          merge_base_sha = excluded.merge_base_sha,
          head_sha       = excluded.head_sha,
          files          = excluded.files,
          computed_at    = excluded.computed_at`),
      changeSetById: db.prepare('SELECT * FROM change_sets WHERE id = ?'),

      upsertMergePair: db.prepare(`
        INSERT INTO merge_pairs (id, repo_id, branch_a, branch_b, pair_key, merge_base_sha, priority, last_run_at, stale)
        VALUES (:id, :repo_id, :branch_a, :branch_b, :pair_key, :merge_base_sha, :priority, :last_run_at, :stale)
        ON CONFLICT (pair_key) DO UPDATE SET
          merge_base_sha = excluded.merge_base_sha,
          priority       = excluded.priority,
          last_run_at    = excluded.last_run_at,
          stale          = excluded.stale
        RETURNING *`),
      listMergePairs: db.prepare(
        'SELECT * FROM merge_pairs WHERE repo_id = ? ORDER BY priority DESC, pair_key',
      ),

      upsertRun: db.prepare(`
        INSERT INTO speculative_runs (id, merge_pair_id, snapshot_a, snapshot_b, status, merge_outcome, analyzer_results, started_at, finished_at, duration_ms)
        VALUES (:id, :merge_pair_id, :snapshot_a, :snapshot_b, :status, :merge_outcome, :analyzer_results, :started_at, :finished_at, :duration_ms)
        ON CONFLICT (id) DO UPDATE SET
          status           = excluded.status,
          merge_outcome    = excluded.merge_outcome,
          analyzer_results = excluded.analyzer_results,
          finished_at      = excluded.finished_at,
          duration_ms      = excluded.duration_ms`),
      runById: db.prepare('SELECT * FROM speculative_runs WHERE id = ?'),
      findingIdsForRun: db.prepare(
        'SELECT id FROM findings WHERE run_id = ? ORDER BY first_seen_at, id',
      ),

      upsertFinding: db.prepare(`
        INSERT INTO findings (id, run_id, kind, rule, severity, confidence, status, title, description, branch_a, branch_b, origin_branch, attribution_rationale, first_seen_at, updated_at, resolved_at)
        VALUES (:id, :run_id, :kind, :rule, :severity, :confidence, :status, :title, :description, :branch_a, :branch_b, :origin_branch, :attribution_rationale, :first_seen_at, :updated_at, :resolved_at)
        ON CONFLICT (id) DO UPDATE SET
          kind                  = excluded.kind,
          rule                  = excluded.rule,
          severity              = excluded.severity,
          confidence            = excluded.confidence,
          status                = excluded.status,
          title                 = excluded.title,
          description           = excluded.description,
          branch_a              = excluded.branch_a,
          branch_b              = excluded.branch_b,
          origin_branch         = excluded.origin_branch,
          attribution_rationale = excluded.attribution_rationale,
          updated_at            = excluded.updated_at,
          resolved_at           = excluded.resolved_at`),
      deleteEvidence: db.prepare('DELETE FROM evidence WHERE finding_id = ?'),
      insertEvidence: db.prepare(
        'INSERT INTO evidence (finding_id, ordinal, type, body) VALUES (:finding_id, :ordinal, :type, :body)',
      ),
      findingById: db.prepare('SELECT * FROM findings WHERE id = ?'),
      evidenceForFinding: db.prepare(
        'SELECT body FROM evidence WHERE finding_id = ? ORDER BY ordinal',
      ),
      openFindings: db.prepare(`
        SELECT f.* FROM findings f
          JOIN speculative_runs r ON r.id = f.run_id
          JOIN merge_pairs p ON p.id = r.merge_pair_id
        WHERE p.repo_id = ? AND f.status = 'open'
        ORDER BY f.first_seen_at, f.id`),
      // One query for every finding's evidence rather than one per finding.
      openFindingEvidence: db.prepare(`
        SELECT e.finding_id, e.body FROM evidence e
          JOIN findings f ON f.id = e.finding_id
          JOIN speculative_runs r ON r.id = f.run_id
          JOIN merge_pairs p ON p.id = r.merge_pair_id
        WHERE p.repo_id = ? AND f.status = 'open'
        ORDER BY e.finding_id, e.ordinal`),
      liveFindings: db.prepare(`
        SELECT f.* FROM findings f
          JOIN speculative_runs r ON r.id = f.run_id
          JOIN merge_pairs p ON p.id = r.merge_pair_id
        WHERE p.repo_id = ? AND f.status IN ('open', 'stale')
        ORDER BY f.first_seen_at, f.id`),
      liveFindingEvidence: db.prepare(`
        SELECT e.finding_id, e.body FROM evidence e
          JOIN findings f ON f.id = e.finding_id
          JOIN speculative_runs r ON r.id = f.run_id
          JOIN merge_pairs p ON p.id = r.merge_pair_id
        WHERE p.repo_id = ? AND f.status IN ('open', 'stale')
        ORDER BY e.finding_id, e.ordinal`),

      appendEvent: db.prepare(
        'INSERT INTO events (id, repo_id, type, payload, at, caused_by) VALUES (:id, :repo_id, :type, :payload, :at, :caused_by)',
      ),
      maxEventId: db.prepare('SELECT max(id) AS id FROM events'),
      eventPage: db.prepare('SELECT * FROM events WHERE id > ? AND id <= ? ORDER BY id LIMIT ?'),

      getVerdict: db.prepare('SELECT * FROM analyzer_cache WHERE key = ?'),
      putVerdict: db.prepare(`
        INSERT INTO analyzer_cache (key, analyzer, verdict, finding_ids, duration_ms, diagnostic, run_id, findings, created_at)
        VALUES (:key, :analyzer, :verdict, :finding_ids, :duration_ms, :diagnostic, :run_id, :findings, :created_at)
        ON CONFLICT (key) DO UPDATE SET
          analyzer    = excluded.analyzer,
          verdict     = excluded.verdict,
          finding_ids = excluded.finding_ids,
          duration_ms = excluded.duration_ms,
          diagnostic  = excluded.diagnostic,
          run_id      = excluded.run_id,
          findings    = excluded.findings,
          created_at  = excluded.created_at`),

      // The events a run that still holds an open or stale Finding needs are its
      // own and everything they lead back to through `caused_by`: the
      // `pair.scheduled` it answered and the edit behind that. Without them an
      // old open Finding keeps its run and loses its explanation. Computed in
      // the statement that deletes, so a Finding opened between batches is seen
      // by the next one — though an earlier batch of the same pass may already
      // have taken any of its chain that was past the window; a new Finding's
      // chain is the edit and run just published, so in practice none is. The
      // kept set is small, since open Findings are few.
      pruneEvents: db.prepare(`
        WITH RECURSIVE kept(id) AS (
          SELECT id FROM events
          WHERE run_id IN (SELECT run_id FROM findings WHERE status IN ('open', 'stale'))
          UNION
          SELECT e.caused_by FROM events e JOIN kept k ON e.id = k.id
          WHERE e.caused_by IS NOT NULL)
        DELETE FROM events WHERE id IN (
          SELECT id FROM events
          WHERE at < :cutoff AND id NOT IN (SELECT id FROM kept)
          ORDER BY at LIMIT :limit)`),
      // A run holding an open or stale finding is live state, however old it is:
      // stale means "not re-verified yet", so dropping it would silently retract
      // a warning rather than resolve it.
      pruneRuns: db.prepare(`
        DELETE FROM speculative_runs WHERE id IN (
          SELECT r.id FROM speculative_runs r
          WHERE r.finished_at IS NOT NULL AND r.finished_at < :cutoff
            AND NOT EXISTS (
              SELECT 1 FROM findings f
              WHERE f.run_id = r.id AND f.status IN ('open', 'stale'))
          LIMIT :limit)`),
      // Unfinished, and started before both the cutoff and the process that owns
      // the store — so abandoned by a daemon that died mid-run, not in flight.
      // A run writes its Findings before it records itself complete, so one cut
      // off in between holds them, and is kept as a finished one would be.
      pruneUnfinishedRuns: db.prepare(`
        DELETE FROM speculative_runs WHERE id IN (
          SELECT r.id FROM speculative_runs r
          WHERE r.finished_at IS NULL AND r.started_at < :cutoff
            AND NOT EXISTS (
              SELECT 1 FROM findings f
              WHERE f.run_id = r.id AND f.status IN ('open', 'stale'))
          LIMIT :limit)`),
      // Only superseded ones. A branch that has been idle longer than the
      // retention window still has a current change set, and it is the one thing
      // describing what that branch is carrying.
      pruneChangeSets: db.prepare(`
        DELETE FROM change_sets WHERE id IN (
          SELECT c.id FROM change_sets c
          WHERE c.computed_at < :cutoff
            AND EXISTS (
              SELECT 1 FROM change_sets newer
              WHERE newer.branch_ref_id = c.branch_ref_id
                AND newer.computed_at > c.computed_at)
          LIMIT :limit)`),
      // By when it was written, never when it was last used: a hit does not
      // refresh it. Its evidence names the commits of the run that reached it,
      // and the shadow's collection keeps objects younger than the window — safe
      // only if no verdict can outlive the window those commits were made in.
      pruneVerdicts: db.prepare(`
        DELETE FROM analyzer_cache WHERE key IN (
          SELECT key FROM analyzer_cache WHERE created_at < :cutoff LIMIT :limit)`),
      // Ended ones only. A live session is what attributes a branch, and one an
      // agent never ended is ended by the reaper once it goes quiet.
      pruneSessions: db.prepare(`
        DELETE FROM agent_sessions WHERE id IN (
          SELECT id FROM agent_sessions
          WHERE ended_at IS NOT NULL AND ended_at < :cutoff
          LIMIT :limit)`),
    };
  }

  upsertRepo(repo: Repo): Promise<Repo> {
    return settled(() => toRepo(returned(this.#statements.upsertRepo.get(repoParams(repo)))));
  }

  listRepos(): Promise<Repo[]> {
    return settled(() => this.#statements.listRepos.all().map(toRepo));
  }

  getRepoByPath(rootPath: Repo['rootPath']): Promise<Repo | null> {
    return settled(() => {
      const row = this.#statements.repoByPath.get(rootPath);
      return row === undefined ? null : toRepo(row);
    });
  }

  upsertBranchRef(ref: BranchRef): Promise<BranchRef> {
    return settled(() => {
      const inserted = returned(this.#statements.upsertBranchRef.get(branchRefParams(ref)));
      return toBranchRef(returned(this.#statements.branchRefById.get(text(inserted, 'id'))));
    });
  }

  listBranchRefs(repoId: Repo['id']): Promise<BranchRef[]> {
    return settled(() => this.#statements.listBranchRefs.all(repoId).map(toBranchRef));
  }

  deleteBranchRef(id: BranchRef['id']): Promise<void> {
    return settled(() => {
      this.#statements.deleteBranchRef.run(id);
    });
  }

  upsertSession(session: AgentSession): Promise<void> {
    return settled(() => {
      this.#statements.upsertSession.run(sessionParams(session));
    });
  }

  listSessions(repoId: Repo['id']): Promise<AgentSession[]> {
    return settled(() => this.#statements.listSessions.all(repoId).map(toSession));
  }

  upsertChangeSet(changeSet: ChangeSet): Promise<void> {
    return settled(() => {
      this.#statements.upsertChangeSet.run(changeSetParams(changeSet));
    });
  }

  getChangeSet(id: ChangeSet['id']): Promise<ChangeSet | null> {
    return settled(() => {
      const row = this.#statements.changeSetById.get(id);
      return row === undefined ? null : toChangeSet(row);
    });
  }

  upsertMergePair(pair: MergePair): Promise<MergePair> {
    return settled(() =>
      toMergePair(returned(this.#statements.upsertMergePair.get(mergePairParams(pair)))),
    );
  }

  listMergePairs(repoId: Repo['id']): Promise<MergePair[]> {
    return settled(() => this.#statements.listMergePairs.all(repoId).map(toMergePair));
  }

  upsertRun(run: SpeculativeRun): Promise<void> {
    return settled(() => {
      this.#statements.upsertRun.run(runParams(run));
    });
  }

  getRun(id: SpeculativeRun['id']): Promise<SpeculativeRun | null> {
    return settled(() => {
      const row = this.#statements.runById.get(id);
      if (row === undefined) return null;
      const findingIds = this.#statements.findingIdsForRun
        .all(id)
        .map((found) => text(found, 'id') as FindingId);
      return toRun(row, findingIds);
    });
  }

  upsertFinding(finding: Finding): Promise<void> {
    return settled(() => {
      this.#transaction(() => {
        this.#statements.upsertFinding.run(findingParams(finding));
        // Replaced rather than merged: evidence is owned by the finding and
        // addressed by position, so a shorter list would otherwise keep the tail
        // of the longer one it replaced.
        this.#statements.deleteEvidence.run(finding.id);
        finding.evidence.forEach((evidence, ordinal) => {
          this.#statements.insertEvidence.run(evidenceParams(finding.id, ordinal, evidence));
        });
      });
    });
  }

  getFinding(id: Finding['id']): Promise<Finding | null> {
    return settled(() => {
      const row = this.#statements.findingById.get(id);
      if (row === undefined) return null;
      const evidence = this.#statements.evidenceForFinding.all(id).map(toEvidence);
      return toFinding(row, evidence);
    });
  }

  listOpenFindings(repoId: Repo['id']): Promise<Finding[]> {
    return settled(() =>
      this.#findingsWith(
        this.#statements.openFindings,
        this.#statements.openFindingEvidence,
        repoId,
      ),
    );
  }

  listLiveFindings(repoId: Repo['id']): Promise<Finding[]> {
    return settled(() =>
      this.#findingsWith(
        this.#statements.liveFindings,
        this.#statements.liveFindingEvidence,
        repoId,
      ),
    );
  }

  /** One query for the Findings and one for all their evidence, rather than one per Finding. */
  #findingsWith(findings: StatementSync, evidenceOf: StatementSync, repoId: Repo['id']): Finding[] {
    const rows = findings.all(repoId);
    const evidence = new Map<string, Evidence[]>();
    for (const row of evidenceOf.all(repoId)) {
      const findingId = text(row, 'finding_id');
      const list = evidence.get(findingId) ?? [];
      list.push(toEvidence(row));
      evidence.set(findingId, list);
    }
    return rows.map((row) => toFinding(row, evidence.get(text(row, 'id')) ?? []));
  }

  appendEvent(record: EventRecord): Promise<void> {
    return settled(() => {
      this.#statements.appendEvent.run(eventParams(record));
    });
  }

  readEvents(since?: EventRecord['id']): AsyncIterable<EventRecord> {
    // Synchronous behind the asynchronous interface: `node:sqlite` reads without
    // yielding, so an async generator here would be async only in its type.
    const pages = this.#replay(since);
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<EventRecord> => ({
        next: () => Promise.resolve(pages.next()),
        // Closes the generator when a consumer stops early.
        return: () => Promise.resolve(pages.return(undefined)),
      }),
    };
  }

  getCachedVerdict(key: string): Promise<CachedVerdict | null> {
    return settled(() => {
      const row = this.#statements.getVerdict.get(key);
      return row === undefined ? null : toCachedVerdict(row);
    });
  }

  putCachedVerdict(key: string, verdict: CachedVerdict): Promise<boolean> {
    return settled(() => {
      if (!CACHEABLE_VERDICTS.has(verdict.result.verdict)) return false;
      this.#statements.putVerdict.run(analyzerCacheParams(key, verdict, new Date().toISOString()));
      return true;
    });
  }

  prune(before: string, options: PruneOptions = {}): Promise<PruneReport> {
    const cutoff = instant(before);
    const owner = options.abandonedBefore === undefined ? null : instant(options.abandonedBefore);
    if (cutoff === null || (owner === null && options.abandonedBefore !== undefined)) {
      return Promise.reject(
        new InterlockError('CONFIG_INVALID', 'A retention bound is not a timestamp', {
          details: { before, abandonedBefore: options.abandonedBefore ?? null },
          remedy: 'Pass an ISO-8601 timestamp, as `new Date().toISOString()` produces.',
        }),
      );
    }
    const limit = options.batchSize ?? PRUNE_BATCH;
    if (!Number.isInteger(limit) || limit < 1) {
      return Promise.reject(new RangeError('batchSize must be a positive integer'));
    }

    // Abandoned means started before the cutoff and before the owner both.
    const abandoned = owner === null ? null : owner < cutoff ? owner : cutoff;
    this.#pruning ??= this.#prune(cutoff, limit, abandoned).finally(() => {
      this.#pruning = null;
    });
    return this.#pruning;
  }

  async #prune(cutoff: string, limit: number, abandoned: string | null): Promise<PruneReport> {
    const startedAt = performance.now();
    const deleted = { events: 0, runs: 0, changeSets: 0, verdicts: 0, sessions: 0 };
    let batches = 0;
    let longestBatchMs = 0;
    let complete = true;

    // Runs first: what they take by cascade — resolved Findings, their
    // evidence, verdicts — is then gone before the events are weighed.
    type Pass = [keyof typeof deleted, StatementSync, string];
    // Unfinished runs only with proof of which were abandoned.
    const unfinished: Pass[] =
      abandoned === null ? [] : [['runs', this.#statements.pruneUnfinishedRuns, abandoned]];
    const passes: Pass[] = [
      ['runs', this.#statements.pruneRuns, cutoff],
      ...unfinished,
      ['changeSets', this.#statements.pruneChangeSets, cutoff],
      ['verdicts', this.#statements.pruneVerdicts, cutoff],
      ['sessions', this.#statements.pruneSessions, cutoff],
      ['events', this.#statements.pruneEvents, cutoff],
    ];
    passing: for (const [table, statement, bound] of passes) {
      for (;;) {
        // The daemon waits for a pass before closing, so this is a caller that
        // did not; what is left is the next pass's.
        if (this.#closed) {
          complete = false;
          break passing;
        }
        const batchStartedAt = performance.now();
        // `changes` is a bigint only for a statement that could touch more rows
        // than a double addresses, which a batch cannot.
        const removed = this.#transaction(() =>
          Number(statement.run({ cutoff: bound, limit }).changes),
        );
        longestBatchMs = Math.max(longestBatchMs, performance.now() - batchStartedAt);
        batches += 1;
        deleted[table] += removed;
        if (removed < limit) break;
        // Let the writes queued behind this batch through before the next.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
    }

    const report: PruneReport = {
      ...deleted,
      batches,
      longestBatchMs: Math.round(longestBatchMs * 10) / 10,
      durationMs: Math.round(performance.now() - startedAt),
      complete,
    };
    this.#log.debug('pruned', { before: cutoff, ...report });
    return report;
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    this.#db.close();
    return Promise.resolve();
  }

  /**
   * The upper bound is fixed before the first page: pagination reads committed
   * rows as it goes, so a replay against a live daemon would otherwise keep
   * picking up events published while it ran and never reach the end.
   */
  *#replay(since: EventRecord['id'] | undefined): Generator<EventRecord, void, undefined> {
    const upper = this.#maxEventId();
    if (upper === null) return;

    // Every ULID sorts after the empty string, so an absent cursor is the start.
    let cursor: string = since ?? '';
    for (;;) {
      const rows = this.#statements.eventPage.all(cursor, upper, EVENT_REPLAY_BATCH);
      for (const row of rows) yield toEventRecord(row);
      if (rows.length < EVENT_REPLAY_BATCH) return;
      cursor = text(rows[rows.length - 1]!, 'id');
    }
  }

  #maxEventId(): string | null {
    const value = this.#statements.maxEventId.get()?.id;
    return typeof value === 'string' ? value : null;
  }

  #transaction<T>(work: () => T): T {
    // IMMEDIATE: every transaction here writes, and a deferred one takes its
    // read snapshot first — so a second daemon that commits in between refuses
    // this one outright with a lock error the busy handler does not retry.
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  /** A failed statement leaves the transaction open for the next write to join. */
  #rollback(): void {
    try {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
    } catch {
      // The error that caused the rollback is the diagnosis; this one would
      // replace it with a symptom.
    }
  }
}

/**
 * An instant in the shape stored timestamps have, or null for none.
 *
 * Stored timestamps are `toISOString()` output, whose fixed shape is what makes
 * a lexical comparison an ordering; normalising to it keeps an offset-bearing
 * argument from comparing as another date.
 */
function instant(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
