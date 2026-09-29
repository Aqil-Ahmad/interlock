import type { DatabaseSync } from 'node:sqlite';

/**
 * What retention needs to delete in small batches without scanning.
 *
 * **The run an event belongs to**, as a column events can be found by.
 *
 * Pruning keeps a run that still holds an open or stale Finding, and has to
 * keep the events that explain it: the run's own, and everything they lead back
 * to through `caused_by` — the `pair.scheduled` it answered and the edit behind
 * that. The run is in each event's payload and nowhere else, and reading it
 * out of every payload on every pass would be a scan of the whole log.
 *
 * Generated and virtual, so no stored event is rewritten: the log is
 * append-only, and a column computed on read leaves every row as it was
 * written. The index is what makes it a lookup; it is filled for existing rows
 * when it is created.
 *
 * A function rather than SQL because `ADD COLUMN` has no `IF NOT EXISTS`, and
 * a migration must tolerate being applied to a database that already has it. A
 * generated column is listed by `table_xinfo`, not `table_info`.
 */
export function addRetentionIndexes(db: DatabaseSync): void {
  const present = new Set(
    db
      .prepare("SELECT name FROM pragma_table_xinfo('events')")
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );
  if (!present.has('run_id')) {
    db.exec(
      "ALTER TABLE events ADD COLUMN run_id TEXT GENERATED ALWAYS AS (json_extract(payload, '$.runId')) VIRTUAL",
    );
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_run ON events (run_id)');
  // **When a verdict was written and a session ended**: each pass deletes by
  // them a batch at a time, and without an index every batch scans its table.
  db.exec('CREATE INDEX IF NOT EXISTS idx_analyzer_cache_created ON analyzer_cache (created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_sessions_ended ON agent_sessions (ended_at)');
}
