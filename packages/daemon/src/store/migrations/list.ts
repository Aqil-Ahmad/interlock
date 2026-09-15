import type { DatabaseSync } from 'node:sqlite';
import { INITIAL_SCHEMA } from './001-initial.js';
import { addSessionLiveness } from './002-session-liveness.js';

/**
 * Schema migrations.
 *
 * Rules:
 *  - append-only; never edit a migration once it is merged;
 *  - each is idempotent and runs inside a transaction;
 *  - the current version lives in SQLite's `user_version` pragma;
 *  - a migration that would lose data is split into expand → migrate → contract
 *    across releases.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  /**
   * Raw SQL, or a function, executed in a single transaction.
   *
   * A function is for what SQL cannot make idempotent on its own: SQLite's
   * `ALTER TABLE … ADD COLUMN` has no `IF NOT EXISTS`, and re-application is
   * part of the contract — the loser of two daemons starting at once applies
   * the migration again after the winner has committed it.
   */
  readonly up: string | ((db: DatabaseSync) => void);
}

/** Ordered list of migrations. Append only. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', up: INITIAL_SCHEMA },
  { version: 2, name: 'session-liveness', up: addSessionLiveness },
];

export const SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
