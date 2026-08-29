import type { DatabaseSync } from 'node:sqlite';
import { InterlockError } from '@interlock/shared';
import type { Logger } from '@interlock/shared';
import { MIGRATIONS, SCHEMA_VERSION } from './list.js';

/**
 * Bring a database up to {@link SCHEMA_VERSION} and return the version reached.
 *
 * Each migration is one transaction covering both its statements and the bump
 * to `user_version`, so a database is never left describing itself as a version
 * it only partly is.
 */
export function runMigrations(db: DatabaseSync, logger: Logger): number {
  const current = readVersion(db);

  // A file written by a newer Interlock has a schema this build does not know.
  // Running an older migration over it would apply nothing and then hand the
  // daemon rows it cannot read, so refuse while the data is still intact.
  if (current > SCHEMA_VERSION) {
    throw new InterlockError(
      'STORE_MIGRATION_FAILED',
      `The store was written by a newer version of Interlock (schema ${String(current)})`,
      {
        details: { schemaVersion: current, supported: SCHEMA_VERSION },
        remedy: 'Upgrade Interlock, or start the daemon against a different data directory.',
        infra: true,
      },
    );
  }

  let version = current;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    try {
      // IMMEDIATE, not deferred. A deferred transaction reads first and asks for
      // the write lock later, so a second daemon starting at the same moment is
      // refused outright once the first commits — SQLITE_BUSY_SNAPSHOT, which
      // the busy handler does not retry. Taking the lock up front makes the
      // loser wait for the winner and then re-apply, which every migration here
      // is required to tolerate.
      db.exec('BEGIN IMMEDIATE');
      db.exec(migration.up);
      // A pragma takes no bound parameter. The value is this module's own
      // integer rather than anything a caller supplies.
      db.exec(`PRAGMA user_version = ${String(migration.version)}`);
      db.exec('COMMIT');
    } catch (error) {
      // A statement that fails inside `exec` leaves the transaction open; the
      // next write would then join a transaction it did not start. A rollback
      // that fails must not replace the error that caused it.
      try {
        if (db.isTransaction) db.exec('ROLLBACK');
      } catch {
        // Reported through the migration failure below.
      }
      throw new InterlockError(
        'STORE_MIGRATION_FAILED',
        `Migration ${String(migration.version)} (${migration.name}) failed`,
        {
          cause: error,
          details: { version: migration.version, name: migration.name },
          remedy: 'Report this with the daemon log; the store was left at the previous version.',
          infra: true,
        },
      );
    }

    logger.info('migration applied', { version: migration.version, name: migration.name });
    version = migration.version;
  }

  return version;
}

function readVersion(db: DatabaseSync): number {
  const value = db.prepare('PRAGMA user_version').get()?.user_version;
  return typeof value === 'number' ? value : 0;
}
