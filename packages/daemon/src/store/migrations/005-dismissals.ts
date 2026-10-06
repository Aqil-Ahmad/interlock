import type { DatabaseSync } from 'node:sqlite';

/**
 * What the false-positive budget needs: a dismissal on the Finding it is about,
 * a way to find the event that raised a Finding, and counts that outlive both.
 *
 * **The dismissal**, as three nullable columns on `findings` rather than a
 * table of its own: a Finding has at most one, and the row is what retention
 * already keeps or prunes.
 *
 * **The Finding an event concerns**, as a generated column the dismissal's
 * cause is looked up by — `finding.raised` names its Finding in the payload
 * and nowhere else. Virtual, like `run_id`, so no stored event is rewritten.
 *
 * **`finding_counts`**, raised and dismissed per UTC hour, kind and rule. The
 * Findings and events a rate could be read from are pruned after a day by
 * default, and a week's rate cannot be computed from rows that are gone; this
 * table is never pruned. An hour is the bucket so that "the last 24 hours" is
 * what is counted and not a day that started at midnight. Filled here from the
 * Findings still held, so a store upgraded with Findings in it does not start
 * from zero; anything retention took before the upgrade is not counted.
 *
 * A function rather than SQL because `ADD COLUMN` has no `IF NOT EXISTS`, and
 * a migration must tolerate being applied to a database that already has it.
 */
export function addDismissals(db: DatabaseSync): void {
  const columnsOf = (table: string): Set<string> =>
    new Set(
      db
        .prepare(`SELECT name FROM pragma_table_xinfo('${table}')`)
        .all()
        .map((row) => String((row as { name: unknown }).name)),
    );

  const findings = columnsOf('findings');
  for (const column of ['dismissal_reason', 'dismissal_note', 'dismissed_at']) {
    if (!findings.has(column)) db.exec(`ALTER TABLE findings ADD COLUMN ${column} TEXT`);
  }

  if (!columnsOf('events').has('finding_id')) {
    db.exec(
      "ALTER TABLE events ADD COLUMN finding_id TEXT GENERATED ALWAYS AS (json_extract(payload, '$.findingId')) VIRTUAL",
    );
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_finding ON events (finding_id)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS finding_counts (
      -- The UTC hour, as the first 13 characters of an ISO timestamp: it
      -- sorts as time does, and a window is a range of it.
      hour            TEXT NOT NULL,
      kind            TEXT NOT NULL,
      rule            TEXT NOT NULL,
      raised          INTEGER NOT NULL DEFAULT 0,
      -- Counted in the hour the Finding was first raised, not the hour it was
      -- dismissed, so an hour's dismissals are of that hour's raises.
      dismissed_wrong INTEGER NOT NULL DEFAULT 0,
      dismissed_known INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (hour, kind, rule)
    ) STRICT`);
  db.exec(`
    INSERT INTO finding_counts (hour, kind, rule, raised)
    SELECT substr(first_seen_at, 1, 13), kind, rule, count(*) FROM findings
    GROUP BY 1, 2, 3
    ON CONFLICT (hour, kind, rule) DO NOTHING`);
}
