import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLogger, makePairKey, silentLogger, ulid } from '@interlock/shared';
import type {
  AgentSession,
  AgentSessionId,
  AnalyzerResult,
  BranchRef,
  BranchRefId,
  ChangeSet,
  ChangeSetId,
  DirtyState,
  EventId,
  EventRecord,
  LogRecord,
  Finding,
  FindingId,
  MergePair,
  MergePairId,
  Repo,
  RepoId,
  SnapshotId,
  SpeculativeRun,
  SpeculativeRunId,
} from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, openStore, runMigrations } from '../src/store/index.js';
import type { Store } from '../src/store/index.js';
import { rejection } from './support/rejection.js';

/**
 * The store against a real SQLite file, because everything this task can get
 * wrong — reconciliation on the natural key, an unknown dirty state read back
 * as clean, replay order across a restart, the file's permissions — is a
 * property of the database rather than of the mapping above it.
 */

const T = {
  early: '2026-01-01T00:00:00.000Z',
  mid: '2026-02-01T00:00:00.000Z',
  late: '2026-03-01T00:00:00.000Z',
} as const;

function repo(overrides: Partial<Repo> = {}): Repo {
  const id = overrides.id ?? ulid<RepoId>();
  return {
    id,
    rootPath: '/repos/main',
    defaultBranch: 'main',
    shadowPath: `/data/shadows/${id}`,
    config: {},
    discoveredAt: T.early,
    lastSeenAt: T.early,
    ...overrides,
  };
}

function branch(repoId: RepoId, overrides: Partial<BranchRef> = {}): BranchRef {
  return {
    id: ulid<BranchRefId>(),
    repoId,
    ref: 'refs/heads/feature',
    name: 'feature',
    headSha: 'a'.repeat(40),
    worktreePath: '/repos/wt-feature',
    dirty: null,
    sessionId: null,
    firstSeenAt: T.early,
    updatedAt: T.early,
    ...overrides,
  };
}

const dirtyState = (overrides: Partial<DirtyState> = {}): DirtyState => ({
  isDirty: true,
  snapshotId: ulid<SnapshotId>(),
  stagedFiles: ['src/a.ts'],
  unstagedFiles: [],
  untrackedFiles: ['notes with space.md'],
  capturedAt: T.mid,
  ...overrides,
});

function session(repoId: RepoId, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: ulid<AgentSessionId>(),
    repoId,
    kind: 'claude-code',
    externalSessionId: 'ext-1',
    branchRefId: null,
    cwd: '/repos/wt-feature',
    startedAt: T.early,
    lastActiveAt: T.early,
    endedAt: null,
    ...overrides,
  };
}

function changeSet(branchRefId: BranchRefId, overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    id: ulid<ChangeSetId>(),
    branchRefId,
    snapshotId: null,
    mergeBaseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
    files: [
      {
        // A newline and a space in one path: both survive git's `-z` output, so
        // both have to survive the column they are stored in.
        path: 'src/od\nd name.ts',
        previousPath: 'src/old name.ts',
        kind: 'renamed',
        hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 }],
        symbols: [],
        binary: false,
      },
    ],
    computedAt: T.mid,
    ...overrides,
  };
}

function pair(repoId: RepoId, a: BranchRefId, b: BranchRefId, over: Partial<MergePair> = {}) {
  const merged: MergePair = {
    id: ulid<MergePairId>(),
    repoId,
    a,
    b,
    key: makePairKey(a, b),
    mergeBaseSha: 'd'.repeat(40),
    priority: 5,
    lastRunAt: null,
    stale: false,
    ...over,
  };
  return merged;
}

function run(mergePairId: MergePairId, overrides: Partial<SpeculativeRun> = {}): SpeculativeRun {
  return {
    id: ulid<SpeculativeRunId>(),
    mergePairId,
    snapshotA: ulid<SnapshotId>(),
    snapshotB: ulid<SnapshotId>(),
    status: 'complete',
    mergeOutcome: { clean: false, conflictedPaths: ['src/a.ts'], mergedSha: null },
    analyzerResults: [
      {
        analyzer: 'textual',
        verdict: 'findings',
        findingIds: [],
        durationMs: 12,
        cached: false,
        diagnostic: null,
      },
    ],
    findingIds: [],
    startedAt: T.early,
    finishedAt: T.mid,
    durationMs: 40,
    ...overrides,
  };
}

function finding(
  runId: SpeculativeRunId,
  a: BranchRefId,
  b: BranchRefId,
  overrides: Partial<Finding> = {},
): Finding {
  return {
    id: ulid<FindingId>(),
    runId,
    kind: 'textual',
    rule: 'overlapping-hunks',
    severity: 'high',
    confidence: 0.9,
    status: 'open',
    title: 'Both branches rewrote the same block',
    description: 'src/a.ts, lines 10-20',
    attribution: { branchA: a, branchB: b, originBranch: a, rationale: 'A moved it first' },
    evidence: [
      {
        type: 'span',
        branchRefId: a,
        path: 'src/a.ts',
        startLine: 10,
        endLine: 20,
        excerpt: 'const x = 1;',
      },
      { type: 'test', testId: 't1', status: 'failed', message: 'boom', location: null },
    ],
    firstSeenAt: T.early,
    updatedAt: T.mid,
    resolvedAt: null,
    ...overrides,
  };
}

function event(overrides: Partial<EventRecord> = {}): EventRecord {
  const id = overrides.id ?? ulid<EventId>();
  return {
    id,
    repoId: null,
    type: 'daemon.started',
    payload: { type: 'daemon.started', repoId: null, at: T.early, version: '0.0.0', pid: 1 },
    at: T.early,
    causedBy: null,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<EventRecord>): Promise<EventRecord[]> {
  const out: EventRecord[] = [];
  for await (const record of events) out.push(record);
  return out;
}

describe('store', () => {
  let dataDir: string;
  let dbPath: string;
  let store: Store;

  beforeEach(async () => {
    dataDir = join(mkdtempSync(join(tmpdir(), 'interlock-store-')), 'data');
    dbPath = join(dataDir, 'interlock.db');
    store = await openStore({ path: dbPath });
  });

  afterEach(async () => {
    await store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Rows a cascade should have taken; the store exposes no reader for them. */
  const countRows = (table: string): number => {
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get();
      return typeof row?.n === 'number' ? row.n : -1;
    } finally {
      db.close();
    }
  };

  describe('the database file', () => {
    it('leaves a directory it did not create alone', async () => {
      // `openStore` takes any path. A database dropped in a home or a shared
      // directory must not tighten that directory for everything else using it.
      const existing = join(mkdtempSync(join(tmpdir(), 'interlock-shared-')), 'shared');
      mkdirSync(existing, { mode: 0o755 });
      const records: LogRecord[] = [];
      const logger = createLogger('test', { level: 'trace', sink: (r) => records.push(r) });

      const opened = await openStore({ path: join(existing, 'interlock.db'), logger });
      try {
        expect(statSync(existing).mode & 0o777).toBe(0o755);
        // Silence would leave a loose directory looking deliberate.
        expect(records.map((r) => r.msg)).toContain(
          'the directory holding the store is readable beyond its owner',
        );
        // The database itself is owner-only wherever it lands.
        expect(statSync(join(existing, 'interlock.db')).mode & 0o777).toBe(0o600);
      } finally {
        await opened.close();
        rmSync(existing, { recursive: true, force: true });
      }
    });

    it('sets the mode on a directory it creates under a hostile umask', async () => {
      const root = mkdtempSync(join(tmpdir(), 'interlock-umask-'));
      // `mkdir`'s mode is masked, and 0700 survives an ordinary umask untouched
      // — only one clearing owner bits shows whether the mode is set as well as
      // requested.
      const previous = process.umask(0o0300);
      try {
        const nested = join(root, 'data');
        const opened = await openStore({ path: join(nested, 'interlock.db') });
        await opened.close();

        expect(statSync(nested).mode & 0o777).toBe(0o700);
      } finally {
        process.umask(previous);
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('is owner-only, and so is every file SQLite writes beside it', async () => {
      // The `-wal` holds rows that have not reached the database yet, so a mode
      // applied only to the main file leaks exactly the most recent state.
      await store.appendEvent(event());

      const modes = Object.fromEntries(
        readdirSync(dataDir).map((name) => [name, statSync(join(dataDir, name)).mode & 0o777]),
      );

      expect(modes).toEqual({
        'interlock.db': 0o600,
        'interlock.db-wal': 0o600,
        'interlock.db-shm': 0o600,
      });
      // The data dir is Interlock's own — this call created it.
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    });

    it('runs in write-ahead logging mode with foreign keys enforced', async () => {
      const db = new DatabaseSync(dbPath);
      try {
        expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      } finally {
        db.close();
      }

      // Foreign keys are per connection, so this is asserted through the store:
      // a branch naming a repository that was never stored has to be refused.
      await expect(store.upsertBranchRef(branch(ulid<RepoId>()))).rejects.toThrow(/FOREIGN KEY/u);
    });

    it('refuses a relative path rather than creating one next to the daemon', async () => {
      const error = await rejection(openStore({ path: 'interlock.db' }));
      expect(error.code).toBe('CONFIG_INVALID');
    });

    it('gives each in-memory store a database of its own', async () => {
      const one = await openStore({ path: ':memory:' });
      const two = await openStore({ path: ':memory:' });
      try {
        await one.upsertRepo(repo());

        expect(await one.listRepos()).toHaveLength(1);
        // Two tests running in one worker must not see each other's rows, which
        // is the whole reason the in-memory path is offered.
        expect(await two.listRepos()).toEqual([]);
      } finally {
        await one.close();
        await two.close();
      }
    });
  });

  describe('migrations', () => {
    it('applies cleanly to a database that already holds the schema', () => {
      const db = new DatabaseSync(join(dataDir, 'twice.db'));
      try {
        expect(runMigrations(db, silentLogger)).toBe(SCHEMA_VERSION);

        // As if the version bump had been lost while the statements survived:
        // the schema is there, and 001 has to be applicable to it anyway.
        db.exec('PRAGMA user_version = 0');
        expect(runMigrations(db, silentLogger)).toBe(SCHEMA_VERSION);
        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
      } finally {
        db.close();
      }
    });

    it('does nothing on a database already at the current version', () => {
      const db = new DatabaseSync(dbPath);
      try {
        expect(runMigrations(db, silentLogger)).toBe(SCHEMA_VERSION);
      } finally {
        db.close();
      }
    });

    it('leaves nothing behind when a migration fails partway', () => {
      const path = join(dataDir, 'blocked.db');
      const db = new DatabaseSync(path);
      try {
        // A view collides with `CREATE TABLE IF NOT EXISTS`, which no `IF NOT
        // EXISTS` skips — and it sits far enough down the schema that earlier
        // tables have already been created when it throws.
        db.exec('CREATE VIEW findings AS SELECT 1 AS x');

        expect(() => runMigrations(db, silentLogger)).toThrow(/Migration 1/u);

        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
        const tables = (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
            name: string;
          }[]
        ).map((row) => row.name);
        expect(tables).not.toContain('repos');
      } finally {
        db.close();
      }
    });

    it('refuses a store written by a newer Interlock', async () => {
      const path = join(dataDir, 'future.db');
      const db = new DatabaseSync(path);
      db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION + 1)}`);
      db.close();

      const error = await rejection(openStore({ path }));
      expect(error.code).toBe('STORE_MIGRATION_FAILED');
      expect(error.remedy).toContain('Upgrade');
    });
  });

  describe('repos', () => {
    it('reconciles a second sighting onto the first row', async () => {
      const first = await store.upsertRepo(repo());
      const resighted = repo({
        defaultBranch: 'trunk',
        config: { ignore: ['dist/**'] },
        discoveredAt: T.late,
        lastSeenAt: T.late,
      });
      expect(resighted.shadowPath).not.toBe(first.shadowPath);
      const second = await store.upsertRepo(resighted);

      expect(await store.listRepos()).toHaveLength(1);
      // Discovery mints a fresh ULID per sweep; keying on it would insert a row
      // each time, and every branch written against the new id would orphan.
      expect(second.id).toBe(first.id);
      // Derived from the id that won: the incoming one names a directory built
      // from a ULID that was discarded, while the clone sits at the stored one.
      // The fixture derives it from the id, so the two genuinely differ — a
      // change that made them equal would leave this assertion vacuous.
      expect(second.shadowPath).toBe(first.shadowPath);
      expect(second.discoveredAt).toBe(T.early);
      expect(second.lastSeenAt).toBe(T.late);
      expect(second.defaultBranch).toBe('trunk');
    });

    it('updates the cached `.interlock.json` in place', async () => {
      await store.upsertRepo(repo({ config: { ignoreBranches: ['release/*'] } }));
      await store.upsertRepo(repo({ config: { ignore: ['vendor/**'] } }));

      const [stored] = await store.listRepos();
      // The row is a cache of a file that changes underneath it, so re-reading
      // the file has to be able to replace it without deleting the repository.
      expect(stored?.config).toEqual({ ignore: ['vendor/**'] });
    });

    it('keeps two repositories apart', async () => {
      await store.upsertRepo(repo({ rootPath: '/repos/one' }));
      await store.upsertRepo(repo({ rootPath: '/repos/two' }));

      expect((await store.listRepos()).map((each) => each.rootPath)).toEqual([
        '/repos/one',
        '/repos/two',
      ]);
    });
  });

  describe('branch refs', () => {
    let repoId: RepoId;

    beforeEach(async () => {
      repoId = (await store.upsertRepo(repo())).id;
    });

    it('leaves one row when the same branch is listed twice', async () => {
      const first = await store.upsertBranchRef(branch(repoId));
      const second = await store.upsertBranchRef(
        branch(repoId, { headSha: 'e'.repeat(40), firstSeenAt: T.late, updatedAt: T.late }),
      );

      expect(await store.listBranchRefs(repoId)).toHaveLength(1);
      expect(second.id).toBe(first.id);
      expect(second.headSha).toBe('e'.repeat(40));
      // First seen is a property of the first sighting, not of this one.
      expect(second.firstSeenAt).toBe(T.early);
      expect(second.updatedAt).toBe(T.late);
    });

    it('reads an unknown dirty state back as unknown, not as clean', async () => {
      const stored = await store.upsertBranchRef(branch(repoId, { dirty: null }));

      expect(stored.dirty).toBeNull();
      const [listed] = await store.listBranchRefs(repoId);
      expect(listed?.dirty).toBeNull();
    });

    it('keeps a clean observation distinct from an unread worktree', async () => {
      const clean: DirtyState = dirtyState({
        isDirty: false,
        snapshotId: null,
        stagedFiles: [],
        untrackedFiles: [],
      });
      const observed = await store.upsertBranchRef(
        branch(repoId, { ref: 'refs/heads/clean', name: 'clean', dirty: clean }),
      );
      const unknown = await store.upsertBranchRef(
        branch(repoId, { ref: 'refs/heads/gone', name: 'gone', dirty: null }),
      );

      expect(observed.dirty).toEqual(clean);
      expect(unknown.dirty).toBeNull();
    });

    it('round-trips every field of a branch', async () => {
      const ref = branch(repoId, { dirty: dirtyState() });

      // Whole-object equality, not a field at a time: a model that gains a field
      // without a column to hold it fails here, which is the drift a schema
      // generated from the models would have caught at build time.
      expect(await store.upsertBranchRef(ref)).toEqual(ref);
    });

    it('forgets a dirty state when the worktree becomes unreadable', async () => {
      await store.upsertBranchRef(branch(repoId, { dirty: dirtyState() }));
      const later = await store.upsertBranchRef(branch(repoId, { dirty: null }));

      // Unknown is a positive observation and overwrites what was known; keeping
      // the last reading would report a vanished worktree as still dirty.
      expect(later.dirty).toBeNull();
    });
  });

  describe('agent sessions', () => {
    let repoId: RepoId;
    let branchRefId: BranchRefId;

    beforeEach(async () => {
      repoId = (await store.upsertRepo(repo())).id;
      branchRefId = (await store.upsertBranchRef(branch(repoId))).id;
    });

    it('attributes a branch to the session driving it', async () => {
      const driver = session(repoId, { branchRefId });
      await store.upsertSession(driver);

      const [listed] = await store.listBranchRefs(repoId);
      expect(listed?.sessionId).toBe(driver.id);
    });

    it('survives a sweep that re-lists the branch with no session', async () => {
      const driver = session(repoId, { branchRefId });
      await store.upsertSession(driver);

      // Discovery always reports `sessionId: null`; a stored copy on the branch
      // row would be cleared here and attribution would never outlive a sweep.
      await store.upsertBranchRef(branch(repoId, { sessionId: null, updatedAt: T.late }));

      const [listed] = await store.listBranchRefs(repoId);
      expect(listed?.sessionId).toBe(driver.id);
    });

    it('drops the attribution when the session ends', async () => {
      const driver = session(repoId, { branchRefId });
      await store.upsertSession(driver);
      await store.upsertSession({ ...driver, endedAt: T.late });

      const [listed] = await store.listBranchRefs(repoId);
      expect(listed?.sessionId).toBeNull();
    });

    it('prefers the most recently active of two live sessions', async () => {
      const stale = session(repoId, { branchRefId, lastActiveAt: T.early });
      const active = session(repoId, { branchRefId, lastActiveAt: T.late });
      await store.upsertSession(stale);
      await store.upsertSession(active);

      const [listed] = await store.listBranchRefs(repoId);
      // A wedged agent that never fires its end hook still holds a live row; the
      // model has room for one answer and this is the less wrong one.
      expect(listed?.sessionId).toBe(active.id);
      expect(await store.listSessions(repoId)).toHaveLength(2);
    });

    it('updates a session in place on its id, round-tripping every field', async () => {
      const driver = session(repoId);
      await store.upsertSession(driver);
      const moved = { ...driver, branchRefId, lastActiveAt: T.late };
      await store.upsertSession(moved);

      expect(await store.listSessions(repoId)).toEqual([moved]);
    });
  });

  describe('change sets', () => {
    it('round-trips file changes, including a path with a newline', async () => {
      const repoId = (await store.upsertRepo(repo())).id;
      const branchRefId = (await store.upsertBranchRef(branch(repoId))).id;
      const set = changeSet(branchRefId, { snapshotId: ulid<SnapshotId>() });

      await store.upsertChangeSet(set);

      expect(await store.getChangeSet(set.id)).toEqual(set);
    });

    it('returns null for a change set that was never stored', async () => {
      expect(await store.getChangeSet(ulid<ChangeSetId>())).toBeNull();
    });
  });

  describe('merge pairs', () => {
    let repoId: RepoId;
    let a: BranchRefId;
    let b: BranchRefId;

    beforeEach(async () => {
      repoId = (await store.upsertRepo(repo())).id;
      a = (await store.upsertBranchRef(branch(repoId, { ref: 'refs/heads/a', name: 'a' }))).id;
      b = (await store.upsertBranchRef(branch(repoId, { ref: 'refs/heads/b', name: 'b' }))).id;
    });

    it('treats (A,B) and (B,A) as one row', async () => {
      const first = await store.upsertMergePair(pair(repoId, a, b));
      const reversed = pair(repoId, b, a, { priority: 9, stale: true });
      const second = await store.upsertMergePair(reversed);

      expect(await store.listMergePairs(repoId)).toHaveLength(1);
      // Unordered is load-bearing: two rows would mean two cache entries for one
      // pair, and the second would never see the first's results. The stored
      // orientation wins; everything else is this sighting's.
      expect(second).toEqual({ ...reversed, id: first.id, a: first.a, b: first.b });
    });

    it('orders by priority so the scheduler reads the queue as it stands', async () => {
      const c = (await store.upsertBranchRef(branch(repoId, { ref: 'refs/heads/c', name: 'c' })))
        .id;
      await store.upsertMergePair(pair(repoId, a, b, { priority: 1 }));
      await store.upsertMergePair(pair(repoId, a, c, { priority: 7 }));

      expect((await store.listMergePairs(repoId)).map((each) => each.priority)).toEqual([7, 1]);
    });
  });

  describe('runs and findings', () => {
    let repoId: RepoId;
    let a: BranchRefId;
    let b: BranchRefId;
    let pairId: MergePairId;

    beforeEach(async () => {
      repoId = (await store.upsertRepo(repo())).id;
      a = (await store.upsertBranchRef(branch(repoId, { ref: 'refs/heads/a', name: 'a' }))).id;
      b = (await store.upsertBranchRef(branch(repoId, { ref: 'refs/heads/b', name: 'b' }))).id;
      pairId = (await store.upsertMergePair(pair(repoId, a, b))).id;
    });

    it('round-trips a run and its merge outcome', async () => {
      const speculative = run(pairId);
      await store.upsertRun(speculative);

      expect(await store.getRun(speculative.id)).toEqual(speculative);
    });

    it('reads a run with no merge outcome back as having none', async () => {
      const queued = run(pairId, {
        status: 'queued',
        mergeOutcome: null,
        finishedAt: null,
        durationMs: null,
      });
      await store.upsertRun(queued);

      expect(await store.getRun(queued.id)).toEqual(queued);
    });

    it('takes a run’s finding ids from the findings themselves', async () => {
      const speculative = run(pairId);
      await store.upsertRun(speculative);
      const raised = finding(speculative.id, a, b);
      await store.upsertFinding(raised);

      // The run was stored before the finding existed and named none. A stored
      // copy of the list would still say so.
      expect((await store.getRun(speculative.id))?.findingIds).toEqual([raised.id]);
    });

    it('round-trips a finding with its evidence in order', async () => {
      const speculative = run(pairId);
      await store.upsertRun(speculative);
      const raised = finding(speculative.id, a, b);
      await store.upsertFinding(raised);

      expect(await store.getFinding(raised.id)).toEqual(raised);
    });

    it('replaces evidence rather than merging it', async () => {
      const speculative = run(pairId);
      await store.upsertRun(speculative);
      const raised = finding(speculative.id, a, b);
      await store.upsertFinding(raised);

      const narrowed: Finding = { ...raised, evidence: [raised.evidence[0]!] };
      await store.upsertFinding(narrowed);

      // Evidence is addressed by position, so a shorter list left to merge would
      // keep the tail of the longer one it replaced.
      expect((await store.getFinding(raised.id))?.evidence).toEqual(narrowed.evidence);
    });

    it('lists open findings for a repository and nothing else', async () => {
      const speculative = run(pairId);
      await store.upsertRun(speculative);
      const open = finding(speculative.id, a, b);
      const stale = finding(speculative.id, a, b, { status: 'stale' });
      const resolved = finding(speculative.id, a, b, { status: 'resolved', resolvedAt: T.late });
      await store.upsertFinding(open);
      await store.upsertFinding(stale);
      await store.upsertFinding(resolved);

      const listed = await store.listOpenFindings(repoId);

      // Stale means "the branches moved and this has not been re-verified", so
      // showing it as current is the false positive the project refuses.
      expect(listed.map((each) => each.id)).toEqual([open.id]);
      expect(listed[0]?.evidence).toEqual(open.evidence);
    });

    it('leaves nothing behind when a finding cannot be stored', async () => {
      const orphan = finding(ulid<SpeculativeRunId>(), a, b);

      await expect(store.upsertFinding(orphan)).rejects.toThrow(/FOREIGN KEY/u);

      // The evidence rows go in after the finding, so a transaction that was not
      // rolled back would leave them pointing at a finding that does not exist.
      expect(await store.getFinding(orphan.id)).toBeNull();
      const speculative = run(pairId);
      await store.upsertRun(speculative);
      await store.upsertFinding({ ...orphan, runId: speculative.id, evidence: [] });
      expect((await store.getFinding(orphan.id))?.evidence).toEqual([]);
    });

    it('does not leak findings across repositories', async () => {
      const speculative = run(pairId);
      await store.upsertRun(speculative);
      await store.upsertFinding(finding(speculative.id, a, b));

      const otherRepo = (await store.upsertRepo(repo({ rootPath: '/repos/other' }))).id;
      expect(await store.listOpenFindings(otherRepo)).toEqual([]);
    });
  });

  describe('the analyzer cache', () => {
    const result: AnalyzerResult = {
      analyzer: 'typecheck',
      verdict: 'clean',
      findingIds: [],
      durationMs: 900,
      cached: false,
      diagnostic: null,
    };

    it('reports a stored verdict as cached however it was stored', async () => {
      await store.putCachedVerdict('snapA:snapB:typecheck:node24', result);

      expect(await store.getCachedVerdict('snapA:snapB:typecheck:node24')).toEqual({
        ...result,
        cached: true,
      });
    });

    it('returns null for a key that was never written', async () => {
      expect(await store.getCachedVerdict('missing')).toBeNull();
    });

    it('overwrites a verdict for the same key', async () => {
      await store.putCachedVerdict('k', result);
      await store.putCachedVerdict('k', { ...result, verdict: 'timeout', diagnostic: 'gave up' });

      const stored = await store.getCachedVerdict('k');
      expect(stored?.verdict).toBe('timeout');
      expect(stored?.diagnostic).toBe('gave up');
    });
  });

  it('names the column when a JSON payload no longer parses', async () => {
    await store.upsertRepo(repo());
    await store.close();

    const db = new DatabaseSync(dbPath);
    db.exec("UPDATE repos SET config = '{'");
    db.close();
    store = await openStore({ path: dbPath });

    const error = await rejection(store.listRepos());

    expect(error.code).toBe('STORE_UNAVAILABLE');
    expect(error.details).toEqual({ column: 'config' });
    expect(error.infra).toBe(true);
  });

  /**
   * A file written by a build that knew a value this one does not. Passing it
   * through would put a verdict no analyzer produced, or a status no rule
   * assigned, in front of the scheduler as though it were real.
   */
  describe('enumerated columns', () => {
    let repoId: RepoId;
    let findingId: FindingId;
    let runId: SpeculativeRunId;

    beforeEach(async () => {
      repoId = (await store.upsertRepo(repo())).id;
      const a = (await store.upsertBranchRef(branch(repoId, { ref: 'refs/heads/a', name: 'a' })))
        .id;
      const b = (await store.upsertBranchRef(branch(repoId, { ref: 'refs/heads/b', name: 'b' })))
        .id;
      const pairId = (await store.upsertMergePair(pair(repoId, a, b))).id;
      const speculative = run(pairId);
      runId = speculative.id;
      await store.upsertRun(speculative);
      const raised = finding(runId, a, b);
      findingId = raised.id;
      await store.upsertFinding(raised);
      await store.upsertSession(session(repoId, { branchRefId: a }));
      await store.putCachedVerdict('k', {
        analyzer: 'build',
        verdict: 'clean',
        findingIds: [],
        durationMs: 1,
        cached: false,
        diagnostic: null,
      });
    });

    const columns: readonly [string, string, (open: Store) => Promise<unknown>][] = [
      ['agent_sessions', 'kind', (open) => open.listSessions(repoId)],
      ['speculative_runs', 'status', (open) => open.getRun(runId)],
      ['findings', 'kind', (open) => open.getFinding(findingId)],
      ['findings', 'severity', (open) => open.getFinding(findingId)],
      ['findings', 'status', (open) => open.getFinding(findingId)],
      ['analyzer_cache', 'analyzer', (open) => open.getCachedVerdict('k')],
      ['analyzer_cache', 'verdict', (open) => open.getCachedVerdict('k')],
    ];

    it.each(columns)('refuses an unrecognised %s.%s', async (table, column, read) => {
      await store.close();
      const db = new DatabaseSync(dbPath);
      db.exec(`UPDATE ${table} SET ${column} = 'not-a-value'`);
      db.close();
      store = await openStore({ path: dbPath });

      const error = await rejection(read(store));

      expect(error.code).toBe('STORE_UNAVAILABLE');
      expect(error.message).toContain(column);
    });
  });

  describe('the event log', () => {
    it('replays in id order regardless of insertion order', async () => {
      const first = event();
      const second = event();
      const third = event();
      await store.appendEvent(third);
      await store.appendEvent(first);
      await store.appendEvent(second);

      expect((await collect(store.readEvents())).map((each) => each.id)).toEqual([
        first.id,
        second.id,
        third.id,
      ]);
    });

    it('replays from a cursor, exclusive', async () => {
      const records = [event(), event(), event()];
      for (const record of records) await store.appendEvent(record);

      const replayed = await collect(store.readEvents(records[0]!.id));
      expect(replayed.map((each) => each.id)).toEqual([records[1]!.id, records[2]!.id]);
    });

    it('round-trips the payload and the causal link', async () => {
      const cause = event();
      const caused = event({
        repoId: ulid<RepoId>(),
        type: 'branch.appeared',
        payload: {
          type: 'branch.appeared',
          repoId: null,
          at: T.mid,
          branchRefId: ulid<BranchRefId>(),
          name: 'feature',
          headSha: 'f'.repeat(40),
          worktreePath: null,
        },
        causedBy: cause.id,
      });
      await store.appendEvent(cause);
      await store.appendEvent(caused);

      expect(await collect(store.readEvents(cause.id))).toEqual([caused]);
    });

    it('accepts an event naming a repository that was never stored', async () => {
      // The log records what happened. A foreign key here would reject a record
      // because another table lagged, which is a hole in the audit trail.
      await store.appendEvent(event({ repoId: ulid<RepoId>() }));

      expect(await collect(store.readEvents())).toHaveLength(1);
    });

    it('pages through a log longer than one batch', async () => {
      const ids: EventId[] = [];
      for (let i = 0; i < 620; i++) {
        const record = event();
        ids.push(record.id);
        await store.appendEvent(record);
      }

      expect((await collect(store.readEvents())).map((each) => each.id)).toEqual(ids);
    });

    it('can be abandoned partway', async () => {
      for (let i = 0; i < 620; i++) await store.appendEvent(event());

      const seen: EventId[] = [];
      for await (const record of store.readEvents()) {
        seen.push(record.id);
        // `interlock status` reads until it has enough and stops; the generator
        // behind the iterable has to be closed by that rather than left open.
        if (seen.length === 3) break;
      }

      expect(seen).toHaveLength(3);
      expect(await collect(store.readEvents())).toHaveLength(620);
    });

    it('stops at the end the log had when the replay began', async () => {
      for (let i = 0; i < 620; i++) await store.appendEvent(event());

      const seen: EventId[] = [];
      let appendedDuringReplay: EventId | null = null;
      for await (const record of store.readEvents()) {
        if (seen.length === 0) {
          // Published after iteration started and sorting after everything in
          // it. Without a fixed upper bound the second page would pick it up and
          // a replay against a live daemon would never terminate.
          const later = event();
          appendedDuringReplay = later.id;
          await store.appendEvent(later);
        }
        seen.push(record.id);
      }

      expect(seen).toHaveLength(620);
      expect(seen).not.toContain(appendedDuringReplay);
    });
  });

  describe('restart', () => {
    it('reproduces the previous state', async () => {
      const stored = await store.upsertRepo(repo({ config: { ignore: ['dist/**'] } }));
      const dirty = dirtyState();
      await store.upsertBranchRef(branch(stored.id, { dirty }));
      await store.upsertBranchRef(
        branch(stored.id, { ref: 'refs/heads/gone', name: 'gone', dirty: null }),
      );
      const records = [event(), event()];
      for (const record of records) await store.appendEvent(record);

      await store.close();
      store = await openStore({ path: dbPath });

      expect(await store.listRepos()).toEqual([stored]);
      const branches = await store.listBranchRefs(stored.id);
      expect(branches.map((each) => each.dirty)).toEqual([dirty, null]);
      expect((await collect(store.readEvents())).map((each) => each.id)).toEqual(
        records.map((each) => each.id),
      );
    });

    it('closes more than once without complaint', async () => {
      await store.close();
      await expect(store.close()).resolves.toBeUndefined();
    });
  });

  describe('prune', () => {
    it('drops events older than the cutoff and keeps the rest', async () => {
      await store.appendEvent(event({ at: T.early }));
      await store.appendEvent(event({ at: T.late }));

      expect(await store.prune(T.mid)).toBe(1);
      expect((await collect(store.readEvents())).map((each) => each.at)).toEqual([T.late]);
    });

    it('keeps a run that still carries an open or stale finding', async () => {
      const repoId = (await store.upsertRepo(repo())).id;
      const a = (await store.upsertBranchRef(branch(repoId, { ref: 'refs/heads/a', name: 'a' })))
        .id;
      const b = (await store.upsertBranchRef(branch(repoId, { ref: 'refs/heads/b', name: 'b' })))
        .id;
      const pairId = (await store.upsertMergePair(pair(repoId, a, b))).id;

      const held = run(pairId, { finishedAt: T.early });
      const spent = run(pairId, { finishedAt: T.early });
      await store.upsertRun(held);
      await store.upsertRun(spent);
      await store.upsertFinding(finding(held.id, a, b, { status: 'stale' }));
      const dropped = finding(spent.id, a, b, { status: 'resolved', resolvedAt: T.early });
      await store.upsertFinding(dropped);

      await store.prune(T.mid);

      // Stale is "not re-verified yet", so pruning it would retract a warning
      // rather than resolve it.
      expect(await store.getRun(held.id)).not.toBeNull();
      expect(await store.getRun(spent.id)).toBeNull();
      // `prune` deletes runs and counts only those, so the findings and evidence
      // underneath them leave by cascade or not at all.
      expect(await store.getFinding(dropped.id)).toBeNull();
      expect(countRows('evidence')).toBe(dropped.evidence.length);
    });

    it('keeps an unfinished run whatever its age', async () => {
      const repoId = (await store.upsertRepo(repo())).id;
      const a = (await store.upsertBranchRef(branch(repoId, { ref: 'refs/heads/a', name: 'a' })))
        .id;
      const b = (await store.upsertBranchRef(branch(repoId, { ref: 'refs/heads/b', name: 'b' })))
        .id;
      const pairId = (await store.upsertMergePair(pair(repoId, a, b))).id;
      const running = run(pairId, { status: 'running', finishedAt: null, durationMs: null });
      await store.upsertRun(running);

      await store.prune(T.late);

      expect(await store.getRun(running.id)).not.toBeNull();
    });

    it('drops superseded change sets but keeps the newest for each branch', async () => {
      const repoId = (await store.upsertRepo(repo())).id;
      const branchRefId = (await store.upsertBranchRef(branch(repoId))).id;
      const older = changeSet(branchRefId, { computedAt: T.early });
      const newer = changeSet(branchRefId, { computedAt: T.mid });
      const idle = (
        await store.upsertBranchRef(branch(repoId, { ref: 'refs/heads/idle', name: 'idle' }))
      ).id;
      const only = changeSet(idle, { computedAt: T.early });
      for (const set of [older, newer, only]) await store.upsertChangeSet(set);

      await store.prune(T.late);

      expect(await store.getChangeSet(older.id)).toBeNull();
      expect(await store.getChangeSet(newer.id)).not.toBeNull();
      // A branch idle for longer than the window still has a current change set,
      // and it is the only record of what that branch is carrying.
      expect(await store.getChangeSet(only.id)).not.toBeNull();
    });

    it('keeps change sets that share a timestamp until a newer one arrives', async () => {
      const repoId = (await store.upsertRepo(repo())).id;
      const branchRefId = (await store.upsertBranchRef(branch(repoId))).id;
      const twin = changeSet(branchRefId, { computedAt: T.early });
      const sibling = changeSet(branchRefId, { computedAt: T.early });
      await store.upsertChangeSet(twin);
      await store.upsertChangeSet(sibling);

      await store.prune(T.late);

      // "Superseded" is strictly newer, so two computed in the same millisecond
      // supersede nothing and both stay. Conservative on purpose: the wrong way
      // round would drop a branch's only surviving record of its work.
      expect(await store.getChangeSet(twin.id)).not.toBeNull();
      expect(await store.getChangeSet(sibling.id)).not.toBeNull();

      await store.upsertChangeSet(changeSet(branchRefId, { computedAt: T.mid }));
      await store.prune(T.late);
      expect(await store.getChangeSet(twin.id)).toBeNull();
      expect(await store.getChangeSet(sibling.id)).toBeNull();
    });

    it('drops cached verdicts past the window', async () => {
      await store.putCachedVerdict('k', {
        analyzer: 'build',
        verdict: 'clean',
        findingIds: [],
        durationMs: 1,
        cached: false,
        diagnostic: null,
      });

      // Written now, so a cutoff in the future is what puts it out of window.
      expect(await store.prune('2099-01-01T00:00:00.000Z')).toBe(1);
      expect(await store.getCachedVerdict('k')).toBeNull();
    });

    it('refuses a cutoff that is not a timestamp', async () => {
      await store.appendEvent(event());

      const error = await rejection(store.prune('last tuesday'));

      expect(error.code).toBe('CONFIG_INVALID');
      // Comparison is lexical, so an unparsed cutoff would delete everything or
      // nothing depending on which side of "2" the string fell.
      expect(await collect(store.readEvents())).toHaveLength(1);
    });

    it('compares an offset-bearing cutoff as the instant it names', async () => {
      await store.appendEvent(event({ at: '2026-02-01T00:30:00.000Z' }));

      // 02:00+02:00 is 00:00Z, which sorts before the event; compared as written
      // it would sort after it and take the event with it.
      expect(await store.prune('2026-02-01T02:00:00.000+02:00')).toBe(0);
    });
  });
});
