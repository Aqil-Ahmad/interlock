import type { DatabaseSync } from 'node:sqlite';

/**
 * What a cached verdict needs to stand in for the run it came from.
 *
 * `findings` is the analyzer's output as it produced it. The ids in
 * `finding_ids` are not enough: reconciliation keeps one Finding per conflict
 * and rewrites its evidence on every run, so the Finding a verdict named
 * describes whatever content the pair was checked at last, not the content
 * the verdict is about. A hit reconciles this output the way a run would.
 *
 * `run_id` is the run that produced the verdict. The scheduler decides
 * escalation on whether the merge was clean, which that run's merge outcome
 * says and the verdict does not; and the cascade bounds the cache by the
 * retention that already governs runs.
 *
 * Rows written before this can only have been keyed by snapshot id, which is
 * minted per capture and never repeats, so none of them could ever be hit.
 * They are deleted rather than kept with no run and no output.
 *
 * A function rather than SQL because `ADD COLUMN` has no `IF NOT EXISTS`, and
 * a migration must tolerate being applied to a database that already has it.
 */
export function addAnalyzerCacheRun(db: DatabaseSync): void {
  const present = new Set(
    db
      .prepare("SELECT name FROM pragma_table_info('analyzer_cache')")
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );
  if (!present.has('run_id')) {
    db.exec(
      'ALTER TABLE analyzer_cache ADD COLUMN run_id TEXT REFERENCES speculative_runs(id) ON DELETE CASCADE',
    );
  }
  if (!present.has('findings')) {
    db.exec("ALTER TABLE analyzer_cache ADD COLUMN findings TEXT NOT NULL DEFAULT '[]'");
  }
  db.exec('DELETE FROM analyzer_cache WHERE run_id IS NULL');
  // A run's deletion looks its verdicts up by this column to cascade.
  db.exec('CREATE INDEX IF NOT EXISTS idx_analyzer_cache_run ON analyzer_cache (run_id)');
}
