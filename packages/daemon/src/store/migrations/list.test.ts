import { describe, expect, it } from 'vitest';
import { MIGRATIONS, SCHEMA_VERSION } from './list.js';

/**
 * Migrations are append-only and identified by number, so the list's shape is
 * itself an invariant: a repeated or out-of-order version silently skips one.
 */
describe('MIGRATIONS', () => {
  it('numbers migrations from 1 upward with no gaps or repeats', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(
      MIGRATIONS.map((_, index) => index + 1),
    );
  });

  it('names every migration', () => {
    for (const migration of MIGRATIONS) expect(migration.name).not.toBe('');
  });

  it('reports the highest version as the schema version', () => {
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });
});
