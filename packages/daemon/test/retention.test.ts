import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLogger, ulid } from '@interlock/shared';
import type { EventId, EventRecord, LogRecord } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRetention } from '../src/retention.js';
import type { Retention } from '../src/retention.js';
import { openStore } from '../src/store/index.js';
import type { Store } from '../src/store/index.js';

/**
 * The retention timer against a real store on a real file: what it prunes is
 * decided by the store, so what is checked here is when it runs, what it says,
 * and that a pass never outlives the daemon's hold on the store.
 */
describe('retention', () => {
  const DAY = 24 * 60 * 60_000;
  /** The clock the retention reads, fixed so its cutoff is exact. */
  const NOW = Date.parse('2026-06-15T00:00:00.000Z');

  let base: string;
  let dbPath: string;
  let store: Store;
  let logs: LogRecord[];
  let retention: Retention | null;

  const event = (at: number): EventRecord => {
    const iso = new Date(at).toISOString();
    return {
      id: ulid<EventId>(),
      repoId: null,
      type: 'daemon.started',
      payload: { type: 'daemon.started', repoId: null, at: iso, version: '0', pid: 1 },
      at: iso,
      causedBy: null,
    };
  };

  const count = async (): Promise<number> => {
    let n = 0;
    for await (const _ of store.readEvents()) n += 1;
    return n;
  };

  const make = (intervalMs = 60_000): Retention => {
    retention = createRetention({
      store,
      windowMs: 7 * DAY,
      logger: createLogger('test', { level: 'debug', sink: (record) => logs.push(record) }),
      intervalMs,
      now: () => NOW,
    });
    return retention;
  };

  const passesLogged = (): LogRecord[] => logs.filter((l) => l.msg === 'pruned the store');

  const until = async (probe: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!probe()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'interlock-retention-'));
    dbPath = join(base, 'data', 'interlock.db');
    store = await openStore({ path: dbPath });
    logs = [];
    retention = null;
    await store.appendEvent(event(NOW - 8 * DAY));
    await store.appendEvent(event(NOW - 6 * DAY));
  });

  afterEach(async () => {
    await retention?.stop();
    await store.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('prunes once shortly after start, without holding up whoever started it', async () => {
    make().start();
    // Started synchronously and returned; nothing has run yet.
    expect(passesLogged()).toEqual([]);

    await until(() => passesLogged().length === 1, 'the first pass');

    expect(await count()).toBe(1);
    expect(passesLogged()[0]).toMatchObject({
      level: 'info',
      component: 'test.retention',
      before: new Date(NOW - 7 * DAY).toISOString(),
      windowMs: 7 * DAY,
      events: 1,
      complete: true,
    });
  });

  it('prunes again on the timer', async () => {
    make(50).start();
    await until(() => passesLogged().length >= 3, 'three passes');
  });

  it('starts once however often it is started', async () => {
    const started = make(60_000);
    started.start();
    started.start();
    await until(() => passesLogged().length >= 1, 'the first pass');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(passesLogged()).toHaveLength(1);
  });

  it('joins a pass already running', async () => {
    const retain = make();
    const first = retain.pass();
    expect(retain.pass()).toBe(first);
    expect(await first).toMatchObject({ events: 1 });
  });

  it('logs a pass that failed and runs the next one all the same', async () => {
    // Another writer holding the lock past the store's busy timeout is a real
    // failure a pass can meet.
    const other = new DatabaseSync(dbPath);
    other.exec('BEGIN IMMEDIATE');
    try {
      const retain = make();
      expect(await retain.pass()).toBeNull();
      expect(logs).toContainEqual(
        expect.objectContaining({ level: 'warn', msg: 'pruning the store failed' }),
      );
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }

    expect(await retention!.pass()).toMatchObject({ events: 1 });
  }, 20_000);

  it('resolves a pass whose cutoff is no date, rather than rejecting out of the timer', async () => {
    // Validation refuses such a window; this is the pass's own guard, since a
    // rejection from the timer's pass has nothing to catch it and ends the
    // process.
    retention = createRetention({
      store,
      windowMs: Number.MAX_SAFE_INTEGER,
      logger: createLogger('test', { level: 'debug', sink: (record) => logs.push(record) }),
      now: () => NOW,
    });

    expect(await retention.pass()).toBeNull();
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'pruning the store failed' }),
    );
    expect(await count()).toBe(2);
  });

  it('waits for a pass in flight when stopped, and runs none after', async () => {
    for (let n = 0; n < 50; n++) await store.appendEvent(event(NOW - 9 * DAY));
    const retain = make(20);
    let settled = false;
    void retain.pass().then(() => {
      settled = true;
    });

    await retain.stop();

    // Stopped means settled: the store can close now under nothing.
    expect(settled).toBe(true);
    const passes = passesLogged().length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(passesLogged()).toHaveLength(passes);
  });

  it('never runs the first pass if stopped before it began', async () => {
    const retain = make();
    retain.start();
    await retain.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(passesLogged()).toEqual([]);
  });
});
