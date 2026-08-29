/**
 * The first schema: every entity in `@interlock/shared`'s models.
 *
 * A TypeScript module rather than a `.sql` file beside it, because `tsc` emits
 * only TypeScript — a `.sql` would be present in the source tree and missing
 * from `dist`, which is the one shape a migration must never take.
 *
 * Every statement is `IF NOT EXISTS`, so this applies cleanly to a database
 * that already holds the schema as well as to an empty one.
 */
export const INITIAL_SCHEMA = `
-- Every table is STRICT. Under SQLite's default affinity a number written into
-- a TEXT id is stored and read back as a number, which turns a ULID into
-- something that no longer compares or sorts against its siblings.

CREATE TABLE IF NOT EXISTS repos (
  id             TEXT PRIMARY KEY,
  -- The reconciliation key. Discovery mints a fresh ULID for every observation,
  -- so an upsert keyed on the id would insert a row per sweep.
  root_path      TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  -- Derived from whichever id won, so it is preserved alongside the id rather
  -- than overwritten: the incoming value names a directory built from a ULID
  -- that was discarded, while the clone on disk sits at the stored one.
  shadow_path    TEXT NOT NULL,
  -- A copy of '.interlock.json', which changes underneath it. Whatever re-reads
  -- the file overwrites this column; the row is a cache, not the truth.
  config         TEXT NOT NULL,
  discovered_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS branch_refs (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  ref           TEXT NOT NULL,
  name          TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  worktree_path TEXT,
  -- NULL is "the worktree could not be read", which is not "clean" — a clean
  -- worktree stores a DirtyState whose isDirty is false. Folding the two
  -- together would be permanent, because nothing re-reads a branch that
  -- reported no changes.
  dirty         TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (repo_id, ref)
) STRICT;

CREATE TABLE IF NOT EXISTS agent_sessions (
  id                  TEXT PRIMARY KEY,
  repo_id             TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,
  external_session_id TEXT,
  -- Attribution lives here and nowhere else. BranchRef.sessionId is derived
  -- from this column on read: discovery re-lists every branch with no session
  -- attached, so a copy stored on branch_refs would be cleared by the next
  -- sweep and attribution would never survive one.
  branch_ref_id       TEXT REFERENCES branch_refs(id) ON DELETE SET NULL,
  cwd                 TEXT,
  started_at          TEXT NOT NULL,
  last_active_at      TEXT NOT NULL,
  ended_at            TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS change_sets (
  id             TEXT PRIMARY KEY,
  branch_ref_id  TEXT NOT NULL REFERENCES branch_refs(id) ON DELETE CASCADE,
  -- Which side was compared, never whether uncommitted work existed.
  snapshot_id    TEXT,
  merge_base_sha TEXT NOT NULL,
  head_sha       TEXT NOT NULL,
  files          TEXT NOT NULL,
  computed_at    TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS merge_pairs (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  branch_a       TEXT NOT NULL REFERENCES branch_refs(id) ON DELETE CASCADE,
  branch_b       TEXT NOT NULL REFERENCES branch_refs(id) ON DELETE CASCADE,
  -- (A,B) and (B,A) are one pair, and this is what makes them one, so it is the
  -- reconciliation key here for the reason root_path is one in repos.
  pair_key       TEXT NOT NULL UNIQUE,
  merge_base_sha TEXT NOT NULL,
  priority       INTEGER NOT NULL,
  last_run_at    TEXT,
  stale          INTEGER NOT NULL CHECK (stale IN (0, 1))
) STRICT;

-- SpeculativeRun.findingIds has no column: findings.run_id already records that
-- relationship, and two copies of one relationship can disagree.
CREATE TABLE IF NOT EXISTS speculative_runs (
  id               TEXT PRIMARY KEY,
  merge_pair_id    TEXT NOT NULL REFERENCES merge_pairs(id) ON DELETE CASCADE,
  snapshot_a       TEXT NOT NULL,
  snapshot_b       TEXT NOT NULL,
  status           TEXT NOT NULL,
  merge_outcome    TEXT,
  analyzer_results TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  duration_ms      INTEGER
) STRICT;

-- No repo_id: a Finding carries none, and a denormalised copy could disagree
-- with the pair it came from. Queries reach the repository through the run.
CREATE TABLE IF NOT EXISTS findings (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES speculative_runs(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL,
  rule                  TEXT NOT NULL,
  severity              TEXT NOT NULL,
  confidence            REAL NOT NULL,
  status                TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL,
  branch_a              TEXT NOT NULL REFERENCES branch_refs(id) ON DELETE CASCADE,
  branch_b              TEXT NOT NULL REFERENCES branch_refs(id) ON DELETE CASCADE,
  origin_branch         TEXT REFERENCES branch_refs(id) ON DELETE SET NULL,
  attribution_rationale TEXT NOT NULL,
  first_seen_at         TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  resolved_at           TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS evidence (
  finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  -- Position within Finding.evidence. The order is the order a reader is shown,
  -- so it is stored rather than left to whatever the query planner returns.
  ordinal    INTEGER NOT NULL,
  type       TEXT NOT NULL,
  body       TEXT NOT NULL,
  PRIMARY KEY (finding_id, ordinal)
) STRICT;

CREATE TABLE IF NOT EXISTS advice (
  id              TEXT PRIMARY KEY,
  repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  audience_branch TEXT REFERENCES branch_refs(id) ON DELETE CASCADE,
  -- A JSON array rather than a join table: retention prunes findings, and a
  -- foreign key would take the delivery record with them — which is the record
  -- rate limiting reads.
  finding_ids     TEXT NOT NULL,
  headline        TEXT NOT NULL,
  detail          TEXT NOT NULL,
  payload         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  delivered_at    TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  -- ULID: replay runs in id order, and ULIDs sort by creation time.
  id        TEXT PRIMARY KEY,
  -- No foreign keys in this table at all. The log records what happened, so a
  -- record must never be rejected because the entity it names has not been
  -- written yet. caused_by is left dangling past the retention window for the
  -- same reason: repairing it would mean rewriting rows in an append-only log.
  repo_id   TEXT,
  type      TEXT NOT NULL,
  payload   TEXT NOT NULL,
  at        TEXT NOT NULL,
  caused_by TEXT
) STRICT;

-- AnalyzerResult.cached has no column: it says how the caller obtained the
-- result rather than what the result was, and a read from this table is cached
-- by definition.
CREATE TABLE IF NOT EXISTS analyzer_cache (
  key         TEXT PRIMARY KEY,
  analyzer    TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  finding_ids TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  diagnostic  TEXT,
  created_at  TEXT NOT NULL
) STRICT;

-- branch_refs(repo_id) needs no index of its own: it is the left prefix of the
-- unique constraint that reconciles the table.
CREATE INDEX IF NOT EXISTS idx_agent_sessions_repo ON agent_sessions (repo_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_branch ON agent_sessions (branch_ref_id);
CREATE INDEX IF NOT EXISTS idx_change_sets_branch ON change_sets (branch_ref_id, computed_at);
CREATE INDEX IF NOT EXISTS idx_merge_pairs_repo ON merge_pairs (repo_id);
CREATE INDEX IF NOT EXISTS idx_speculative_runs_pair ON speculative_runs (merge_pair_id);
CREATE INDEX IF NOT EXISTS idx_speculative_runs_finished ON speculative_runs (finished_at);
CREATE INDEX IF NOT EXISTS idx_findings_run ON findings (run_id);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings (status);
CREATE INDEX IF NOT EXISTS idx_advice_repo ON advice (repo_id);
CREATE INDEX IF NOT EXISTS idx_events_at ON events (at);
`;
