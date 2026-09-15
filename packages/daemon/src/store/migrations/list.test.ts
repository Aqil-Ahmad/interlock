import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('merged migrations do not change', () => {
  // The rule above says never edit a migration once it is merged, and a rule
  // with nothing enforcing it lasts until the first convenient afternoon. A
  // migration is hashed by its source file rather than by its `up` — a
  // function's text depends on whatever transformed it, and a file's does not.
  // A new migration adds a line here; a changed one fails, and the commit that
  // changes the hash is where the reason goes.
  const DIGESTS: Record<number, string> = {
    1: '5ac880112af05020',
    2: '8e093305cdab6bbf',
  };

  it('has a recorded digest for every migration, and every digest matches', () => {
    for (const migration of MIGRATIONS) {
      const file = join(
        import.meta.dirname,
        `${String(migration.version).padStart(3, '0')}-${migration.name}.ts`,
      );
      const digest = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
      expect(DIGESTS[migration.version], `migration ${String(migration.version)}`).toBe(digest);
    }
    expect(Object.keys(DIGESTS)).toHaveLength(MIGRATIONS.length);
  });
});
