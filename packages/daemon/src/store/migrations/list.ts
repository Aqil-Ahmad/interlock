import { INITIAL_SCHEMA } from './001-initial.js';

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
  /** Raw SQL, executed in a single transaction. */
  readonly up: string;
}

/** Ordered list of migrations. Append only. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', up: INITIAL_SCHEMA },
];

export const SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
