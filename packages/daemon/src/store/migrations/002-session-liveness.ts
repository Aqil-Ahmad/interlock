import type { DatabaseSync } from 'node:sqlite';

/**
 * Liveness and attribution on agent sessions.
 *
 * `pid` is what a hook reports about the process driving the session, so a
 * killed agent can be reaped at the next read rather than at the heartbeat
 * timeout. `attribution` records whether the branch was named by the hook or
 * derived from its working directory; the advisor may claim less about an
 * inferred one. Both default for rows written before this existed: no pid,
 * and a branch that was reported — the only way it could have been set before
 * inference existed.
 *
 * A function rather than SQL because `ADD COLUMN` has no `IF NOT EXISTS`, and
 * a migration must tolerate being applied to a database that already has it.
 */
export function addSessionLiveness(db: DatabaseSync): void {
  const present = new Set(
    db
      .prepare("SELECT name FROM pragma_table_info('agent_sessions')")
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );
  if (!present.has('pid')) {
    db.exec('ALTER TABLE agent_sessions ADD COLUMN pid INTEGER');
  }
  if (!present.has('attribution')) {
    db.exec(`ALTER TABLE agent_sessions ADD COLUMN attribution TEXT NOT NULL DEFAULT 'reported'
      CHECK (attribution IN ('reported', 'inferred'))`);
  }
}
