import { InterlockError, makePairKey, resolveConfig, silentLogger, ulid } from '@interlock/shared';
import type {
  BranchRefId,
  EventId,
  EventRecord,
  InterlockEvent,
  MergePairId,
  RepoId,
  SpeculativeRunId,
} from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../bus/index.js';
import { createScheduler } from './index.js';
import type {
  Clock,
  PairCandidate,
  PairPlan,
  PairRunRequest,
  PairRunResult,
  Scheduler,
} from './index.js';
import type { OverlapTier } from './overlap.js';

/** Timers that fire only when the test moves time. */
class FakeClock implements Clock {
  time = 0;
  #next = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** Move time forward, firing every timer due on the way, in order. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let due: [number, { at: number; callback: () => void }] | null = null;
      for (const entry of this.#timers) {
        if (entry[1].at <= target && (due === null || entry[1].at < due[1].at)) due = entry;
      }
      if (due === null) break;
      this.#timers.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
    }
    this.time = target;
  }
}

const repoId = ulid<RepoId>();
const branch = (): BranchRefId => ulid<BranchRefId>();

function candidate(
  a: BranchRefId,
  b: BranchRefId,
  tier: OverlapTier,
  target = false,
): PairCandidate {
  const [x, y] = a < b ? [a, b] : [b, a];
  return {
    pair: {
      id: ulid<MergePairId>(),
      repoId,
      a: x,
      b: y,
      key: makePairKey(x, y),
      mergeBaseSha: 'b'.repeat(40),
      priority: 0,
      lastRunAt: null,
      stale: true,
    },
    overlap: { tier, commonFiles: [] },
    target,
    openFindings: false,
  };
}

/** A run the test finishes when it chooses. */
interface Held {
  readonly request: PairRunRequest;
  readonly signal: AbortSignal;
  resolve(result: PairRunResult): void;
  reject(error: unknown): void;
}

describe('scheduler', () => {
  let clock: FakeClock;
  let bus: EventBus;
  let records: EventRecord[];
  let plans: Map<BranchRefId, PairPlan>;
  let planned: BranchRefId[];
  let held: Held[];
  /** When set, runs answer at once instead of being held. */
  let answer: ((request: PairRunRequest, signal: AbortSignal) => PairRunResult) | null;
  let scheduler: Scheduler;

  const make = (overrides: { concurrency?: number; poolSize?: number } = {}): Scheduler => {
    const config = resolveConfig({
      dataDir: '/tmp/unused',
      scheduler: { debounceMs: 2_000, concurrency: overrides.concurrency ?? 1 },
    });
    scheduler = createScheduler({
      config,
      bus,
      logger: silentLogger,
      clock,
      poolSize: overrides.poolSize ?? 4,
      plan: (_repo, moved) => {
        planned.push(moved);
        return Promise.resolve(plans.get(moved) ?? { candidates: [], declined: 0 });
      },
      runPair: (request, signal) => {
        if (answer !== null) return Promise.resolve(answer(request, signal));
        return new Promise((resolve, reject) => {
          held.push({ request, signal, resolve, reject });
        });
      },
    });
    scheduler.start();
    return scheduler;
  };

  const changed = (id: BranchRefId): Promise<EventId> =>
    bus.publish({
      type: 'branch.snapshot',
      repoId,
      at: new Date(clock.now()).toISOString(),
      branchRefId: id,
      treeOid: 'c'.repeat(40),
      headSha: 'd'.repeat(40),
      changeSetId: null,
      fileCount: 1,
    });

  /**
   * Let planning and every run that can finish do so.
   *
   * Not `idle()`, which waits for held runs as well — correctly, and forever,
   * for a run the test has not released.
   */
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 20; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  const analysed = (request: PairRunRequest, contentKey = 'same', clean = false): PairRunResult =>
    request.isNew(contentKey)
      ? {
          kind: 'analysed',
          runId: ulid<SpeculativeRunId>(),
          contentKey,
          clean,
          findingCount: clean ? 0 : 1,
          finished: ulid<EventId>(),
        }
      : { kind: 'duplicate', contentKey };

  const published = (type: InterlockEvent['type']): EventRecord[] =>
    records.filter((record) => record.type === type);

  beforeEach(() => {
    clock = new FakeClock();
    records = [];
    bus = new EventBus({ logger: silentLogger, onRecord: (record) => records.push(record) });
    plans = new Map();
    planned = [];
    held = [];
    answer = null;
  });

  afterEach(async () => {
    for (const run of held) run.resolve({ kind: 'superseded' });
    await scheduler.stop();
  });

  describe('debounce', () => {
    it('plans a branch once it has been quiet for the debounce', async () => {
      make();
      const x = branch();
      await changed(x);
      clock.advance(1_000);
      await changed(x);

      clock.advance(1_999);
      await settle();
      expect(planned).toEqual([]);

      clock.advance(1);
      await settle();
      expect(planned).toEqual([x]);
    });

    it('plans a branch that never goes quiet at the ceiling', async () => {
      make();
      const x = branch();
      for (let second = 0; second < 9; second++) {
        await changed(x);
        clock.advance(1_000);
      }
      await settle();
      expect(planned).toEqual([]);

      await changed(x);
      clock.advance(1_000);
      await settle();
      expect(planned).toEqual([x]);
      expect(clock.now()).toBe(10_000);
    });

    it('ignores a branch event that names no repository', async () => {
      make();
      await bus.publish({
        type: 'branch.snapshot',
        repoId: null,
        at: '',
        branchRefId: branch(),
        treeOid: 'c'.repeat(40),
        headSha: 'd'.repeat(40),
        changeSetId: null,
        fileCount: 1,
      });
      clock.advance(10_000);
      await settle();
      expect(planned).toEqual([]);
    });

    it('listens to heads moving and branches appearing, not to unreadable worktrees', async () => {
      make();
      const [x, y, z] = [branch(), branch(), branch()];
      await bus.publish({
        type: 'branch.updated',
        repoId,
        at: '',
        branchRefId: x,
        headSha: 'a'.repeat(40),
        dirty: false,
      });
      await bus.publish({
        type: 'branch.appeared',
        repoId,
        at: '',
        branchRefId: y,
        name: 'y',
        headSha: 'a'.repeat(40),
        worktreePath: null,
      });
      await bus.publish({
        type: 'branch.snapshot',
        repoId,
        at: '',
        branchRefId: z,
        treeOid: null,
        headSha: null,
        changeSetId: null,
        fileCount: 0,
      });
      await bus.publish({ type: 'daemon.started', repoId: null, at: '', version: '0', pid: 1 });

      clock.advance(2_000);
      await settle();
      expect(planned.sort()).toEqual([x, y].sort());
    });
  });

  describe('ranking', () => {
    it('runs common files first, then common directories, then the rest', async () => {
      make();
      const x = branch();
      const [f, d, u, t] = [branch(), branch(), branch(), branch()];
      plans.set(x, {
        candidates: [
          candidate(x, u, 'unknown'),
          candidate(x, t, 'none', true),
          candidate(x, d, 'directory'),
          candidate(x, f, 'file'),
        ],
        declined: 0,
      });
      answer = (request) => analysed(request);
      const order: BranchRefId[] = [];
      const inner = answer;
      answer = (request, signal) => {
        const { a, b } = request.candidate.pair;
        order.push(a === x ? b : a);
        return inner(request, signal);
      };

      await changed(x);
      clock.advance(2_000);
      await settle();

      expect(order.slice(0, 2)).toEqual([f, d]);
      expect(order.slice(2).sort()).toEqual([u, t].sort());
    });

    it('never merges a pair with nothing in common, and counts what it declined', async () => {
      make();
      const [x, y, z] = [branch(), branch(), branch()];
      plans.set(x, { candidates: [candidate(x, y, 'none')], declined: 2 });
      answer = (request) => analysed(request);

      await changed(x);
      clock.advance(2_000);
      await settle();

      expect(scheduler.stats.started).toBe(0);
      expect(scheduler.stats.noOverlap).toBe(3);
      expect(published('pair.scheduled')).toEqual([]);
      void z;
    });

    it('runs a pair with an open Finding whatever its overlap, since only a run resolves it', async () => {
      make();
      const [x, y] = [branch(), branch()];
      plans.set(x, {
        candidates: [{ ...candidate(x, y, 'none'), openFindings: true }],
        declined: 0,
      });
      answer = (request) => analysed(request);

      await changed(x);
      clock.advance(2_000);
      await settle();

      expect(scheduler.stats.analysed).toBe(1);
      expect(published('pair.scheduled')[0]!.payload).toMatchObject({ priority: 10 });
    });

    it('ages a waiting pair past fresher ones, so an active branch cannot starve it', async () => {
      make();
      const [x, y, t, blocker, f] = [branch(), branch(), branch(), branch(), branch()];
      plans.set(y, { candidates: [candidate(y, blocker, 'file')], declined: 0 });
      plans.set(x, { candidates: [candidate(x, t, 'none', true)], declined: 0 });

      await changed(y);
      clock.advance(2_000);
      await settle();
      expect(held).toHaveLength(1);

      await changed(x);
      clock.advance(2_000);
      await settle();
      clock.advance(90_000);
      plans.set(x, { candidates: [candidate(x, f, 'file')], declined: 0 });
      await changed(x);
      clock.advance(2_000);
      await settle();

      held[0]!.resolve({ kind: 'skipped', reason: 'unrelated' });
      await settle();
      const next = held[1]!.request.candidate.pair;
      expect([next.a, next.b]).toContain(t);
    });

    it('runs pairs of equal priority in the order they were asked for', async () => {
      make();
      const [x, y, z, w] = [branch(), branch(), branch(), branch()];
      plans.set(x, {
        candidates: [candidate(x, y, 'file'), candidate(x, z, 'file'), candidate(x, w, 'file')],
        declined: 0,
      });
      const order: BranchRefId[] = [];
      answer = (request) => {
        const { a, b } = request.candidate.pair;
        order.push(a === x ? b : a);
        return analysed(request);
      };

      await changed(x);
      clock.advance(2_000);
      await settle();

      expect(order).toEqual([y, z, w]);
    });

    it('keeps a pair’s age when it is asked for again', async () => {
      make();
      const [x, t, blocker, f, g] = [branch(), branch(), branch(), branch(), branch()];
      plans.set(blocker, { candidates: [candidate(blocker, g, 'file')], declined: 0 });
      await changed(blocker);
      clock.advance(2_000);
      await settle();

      plans.set(x, { candidates: [candidate(x, t, 'none', true)], declined: 0 });
      await changed(x);
      clock.advance(2_000);
      await settle();
      // Asked again just before the fresh pair arrives: still the older request.
      clock.advance(85_000);
      await changed(x);
      clock.advance(2_000);
      await settle();
      plans.set(f, { candidates: [candidate(f, g, 'file')], declined: 0 });
      await changed(f);
      clock.advance(2_000);
      await settle();

      held[0]!.resolve({ kind: 'skipped', reason: 'unrelated' });
      await settle();
      const next = held[1]!.request.candidate.pair;
      expect([next.a, next.b]).toContain(t);
    });

    it('prefers re-checking a hot pair over a new one of the same overlap', async () => {
      make({ poolSize: 1 });
      const [x, y, z] = [branch(), branch(), branch()];
      const hotPair = candidate(x, y, 'file');
      plans.set(x, { candidates: [hotPair], declined: 0 });
      answer = (request) => analysed(request, `${clock.now()}`, true);
      await changed(x);
      clock.advance(2_000);
      await settle();
      expect(scheduler.stats.escalations).toBe(1);

      answer = null;
      const blocker = candidate(z, branch(), 'file');
      plans.set(z, { candidates: [blocker], declined: 0 });
      await changed(z);
      clock.advance(2_000);
      await settle();

      plans.set(y, { candidates: [candidate(y, z, 'file'), hotPair], declined: 0 });
      await changed(y);
      clock.advance(2_000);
      await settle();

      held[0]!.resolve({ kind: 'skipped', reason: 'unrelated' });
      await settle();
      expect(held[1]!.request.candidate.pair.key).toBe(hotPair.pair.key);
    });
  });

  describe('the queue', () => {
    it('holds a pair once however many times it is asked for, and runs it once', async () => {
      make();
      const [x, y, blocker] = [branch(), branch(), branch()];
      plans.set(blocker, { candidates: [candidate(blocker, branch(), 'file')], declined: 0 });
      await changed(blocker);
      clock.advance(2_000);
      await settle();

      const pair = candidate(x, y, 'file');
      plans.set(x, { candidates: [pair], declined: 0 });
      plans.set(y, { candidates: [pair], declined: 0 });
      await changed(x);
      await changed(y);
      clock.advance(2_000);
      await settle();
      expect(scheduler.queueDepth).toBe(1);
      expect(published('pair.scheduled')).toHaveLength(3);

      answer = (request) => analysed(request);
      held[0]!.resolve({ kind: 'skipped', reason: 'unrelated' });
      await settle();
      expect(scheduler.stats.started).toBe(2);
      expect(scheduler.queueDepth).toBe(0);
      expect(scheduler.stats.maxQueueDepth).toBe(1);
    });

    it('never runs two analyses of one pair at the same content', async () => {
      make();
      const [x, y] = [branch(), branch()];
      plans.set(x, { candidates: [candidate(x, y, 'file')], declined: 0 });
      let content = 'first';
      answer = (request) => analysed(request, content);

      for (const next of ['first', 'first', 'second', 'second']) {
        content = next;
        await changed(x);
        clock.advance(2_000);
        await settle();
      }

      expect(scheduler.stats.analysed).toBe(2);
      expect(scheduler.stats.duplicates).toBe(2);
    });

    it('caps concurrency, and never runs one pair twice at once', async () => {
      make({ concurrency: 2 });
      const [x, y, z, w] = [branch(), branch(), branch(), branch()];
      plans.set(x, {
        candidates: [candidate(x, y, 'file'), candidate(x, z, 'file'), candidate(x, w, 'file')],
        declined: 0,
      });
      await changed(x);
      clock.advance(2_000);
      await settle();
      expect(held).toHaveLength(2);
      expect(scheduler.stats.running).toBe(2);

      await changed(x);
      clock.advance(2_000);
      await settle();
      expect(held).toHaveLength(2);
      expect(scheduler.queueDepth).toBe(3);
    });

    it('holds a second request for a running pair until it lands, even with a slot free', async () => {
      make({ concurrency: 2 });
      const [x, y] = [branch(), branch()];
      plans.set(x, { candidates: [candidate(x, y, 'file')], declined: 0 });
      await changed(x);
      clock.advance(2_000);
      await settle();
      await changed(x);
      clock.advance(2_000);
      await settle();

      expect(held).toHaveLength(1);
      expect(scheduler.queueDepth).toBe(1);
      answer = (request) => analysed(request);
      held[0]!.resolve({ kind: 'superseded' });
      await settle();
      expect(scheduler.stats.started).toBe(2);
    });

    it('names the branch event a scheduled pair follows from', async () => {
      make();
      const [x, y] = [branch(), branch()];
      plans.set(x, { candidates: [candidate(x, y, 'file')], declined: 0 });
      await changed(x);
      const last = await changed(x);
      clock.advance(2_000);
      await settle();

      expect(published('pair.scheduled')[0]!.causedBy).toBe(last);
      expect(held[0]!.request.cause).toBe(published('pair.scheduled')[0]!.id);
    });
  });

  describe('superseding', () => {
    it('tells a run in flight to discard its result when a branch in it moves, then runs again', async () => {
      make();
      const [x, y] = [branch(), branch()];
      const pair = candidate(x, y, 'file');
      plans.set(x, { candidates: [pair], declined: 0 });
      plans.set(y, { candidates: [pair], declined: 0 });
      await changed(x);
      clock.advance(2_000);
      await settle();
      const first = held[0]!;

      await changed(y);
      clock.advance(2_000);
      await settle();
      expect(first.signal.aborted).toBe(true);

      answer = (request) => analysed(request);
      first.resolve({ kind: 'superseded' });
      await settle();

      expect(scheduler.stats.superseded).toBe(1);
      expect(scheduler.stats.analysed).toBe(1);
    });

    it('leaves runs of pairs the moving branch is not in alone', async () => {
      make({ concurrency: 2 });
      const [x, y, z, w] = [branch(), branch(), branch(), branch()];
      plans.set(x, { candidates: [candidate(x, y, 'file')], declined: 0 });
      plans.set(z, { candidates: [candidate(z, w, 'file')], declined: 0 });
      await changed(x);
      await changed(z);
      clock.advance(2_000);
      await settle();

      await changed(w);
      clock.advance(2_000);
      await settle();

      const byPair = (b: BranchRefId): Held =>
        held.find((run) =>
          [run.request.candidate.pair.a, run.request.candidate.pair.b].includes(b),
        )!;
      expect(byPair(y).signal.aborted).toBe(false);
      expect(byPair(w).signal.aborted).toBe(true);
    });
  });

  describe('failures', () => {
    it('backs off an infrastructure failure exponentially, saying so once per streak', async () => {
      make();
      const [x, y] = [branch(), branch()];
      plans.set(x, { candidates: [candidate(x, y, 'file')], declined: 0 });
      answer = () => ({ kind: 'infra-failure', component: 'analyzer:textual', message: 'down' });

      await changed(x);
      clock.advance(2_000);
      await settle();
      expect(scheduler.stats.started).toBe(1);

      clock.advance(4_999);
      await settle();
      expect(scheduler.stats.started).toBe(1);
      clock.advance(1);
      await settle();
      expect(scheduler.stats.started).toBe(2);

      clock.advance(9_999);
      await settle();
      expect(scheduler.stats.started).toBe(2);
      clock.advance(1);
      await settle();
      expect(scheduler.stats.started).toBe(3);
      expect(published('infra.failure')).toHaveLength(1);
      expect(published('infra.failure')[0]!.payload).toMatchObject({
        component: 'analyzer:textual',
        message: 'down',
      });

      // Recovery ends the streak, so the next failure is news again.
      answer = (request) => analysed(request);
      clock.advance(20_000);
      await settle();
      answer = () => ({ kind: 'infra-failure', component: 'analyzer:textual', message: 'down' });
      await changed(x);
      clock.advance(2_000);
      await settle();
      expect(published('infra.failure')).toHaveLength(2);
    });

    it('ends a streak on any result that is not a failure, a duplicate included', async () => {
      make();
      const [x, y] = [branch(), branch()];
      plans.set(x, { candidates: [candidate(x, y, 'file')], declined: 0 });
      const down: PairRunResult = { kind: 'infra-failure', component: 'c', message: 'down' };
      answer = () => down;
      await changed(x);
      clock.advance(2_000);
      await settle();
      answer = () => ({ kind: 'duplicate', contentKey: 'k' });
      clock.advance(5_000);
      await settle();

      answer = () => down;
      await changed(x);
      clock.advance(2_000);
      await settle();

      expect(published('infra.failure')).toHaveLength(2);
    });

    it('caps the backoff', async () => {
      make();
      const [x, y] = [branch(), branch()];
      plans.set(x, { candidates: [candidate(x, y, 'file')], declined: 0 });
      answer = () => {
        throw new InterlockError('MERGE_FAILED', 'no git', { infra: true });
      };
      await changed(x);
      clock.advance(2_000);
      await settle();
      for (let wait = 5_000; wait <= 160_000; wait *= 2) {
        clock.advance(wait);
        await settle();
      }
      const before = scheduler.stats.started;
      clock.advance(5 * 60_000 - 1);
      await settle();
      expect(scheduler.stats.started).toBe(before);
      clock.advance(1);
      await settle();
      expect(scheduler.stats.started).toBe(before + 1);
      expect(published('infra.failure')).toHaveLength(1);
      expect(published('infra.failure')[0]!.payload).toMatchObject({ code: 'MERGE_FAILED' });
    });

    it('retries a stale snapshot at once, and only a few times before backing off', async () => {
      make();
      const [x, y] = [branch(), branch()];
      plans.set(x, { candidates: [candidate(x, y, 'file')], declined: 0 });
      answer = () => {
        throw new InterlockError('SNAPSHOT_STALE', 'gone');
      };

      await changed(x);
      clock.advance(2_000);
      await settle();

      expect(scheduler.stats.started).toBe(4);
      expect(published('infra.failure')).toHaveLength(1);
      expect(published('infra.failure')[0]!.payload).toMatchObject({ code: 'SNAPSHOT_STALE' });
    });

    it('does not retry a failure that is neither the environment nor stale content', async () => {
      make();
      const [x, y] = [branch(), branch()];
      plans.set(x, { candidates: [candidate(x, y, 'file')], declined: 0 });
      answer = () => {
        throw new TypeError('a bug');
      };

      await changed(x);
      clock.advance(2_000);
      await settle();
      clock.advance(10 * 60_000);
      await settle();

      expect(scheduler.stats.started).toBe(1);
      expect(scheduler.stats.failures).toBe(1);
      expect(published('infra.failure')).toEqual([]);
    });

    it('treats a refused command as a bug, not as the environment', async () => {
      make();
      const [x, y] = [branch(), branch()];
      plans.set(x, { candidates: [candidate(x, y, 'file')], declined: 0 });
      answer = () => {
        throw new InterlockError('GIT_COMMAND_REFUSED', 'refused');
      };
      await changed(x);
      clock.advance(2_000);
      await settle();
      clock.advance(10 * 60_000);
      await settle();
      expect(scheduler.stats.started).toBe(1);
      expect(published('infra.failure')).toEqual([]);
    });

    it('keeps planning after a plan fails', async () => {
      make();
      const [x, y, z] = [branch(), branch(), branch()];
      plans.set(z, { candidates: [candidate(z, y, 'file')], declined: 0 });
      answer = (request) => analysed(request);
      const broken = scheduler;
      void broken;
      plans.set(x, Promise.reject(new Error('store gone')) as unknown as PairPlan);
      await changed(x);
      await changed(z);
      clock.advance(2_000);
      await settle();
      expect(scheduler.stats.analysed).toBe(1);
    });
  });

  describe('escalation', () => {
    const clean = (tier: OverlapTier, target = false) => {
      const [x, y] = [branch(), branch()];
      const pair = candidate(x, y, tier, target);
      plans.set(x, { candidates: [pair], declined: 0 });
      return { x, pair };
    };

    it('escalates a clean merge with an overlap reason, naming the run that found it', async () => {
      make();
      const { x, pair } = clean('file');
      let finished: EventId | null = null;
      answer = (request) => {
        const result = analysed(request, 'c', true);
        if (result.kind === 'analysed') finished = result.finished;
        return result;
      };

      await changed(x);
      clock.advance(2_000);
      await settle();

      const escalated = published('run.escalated');
      expect(escalated).toHaveLength(1);
      expect(escalated[0]!.causedBy).toBe(finished);
      expect(escalated[0]!.payload).toMatchObject({
        mergePairId: pair.pair.id,
        reason: 'common-file',
        evicted: null,
      });
      expect(scheduler.stats.escalationRate).toBe(1);
    });

    it('never escalates without an overlap reason, or a conflicted merge', async () => {
      make();
      const cases = [clean('unknown'), clean('none', true)];
      answer = (request) => analysed(request, 'c', true);
      for (const { x } of cases) await changed(x);
      const conflicted = clean('directory');
      await changed(conflicted.x);
      clock.advance(2_000);
      answer = (request) =>
        request.candidate.pair.key === conflicted.pair.pair.key
          ? analysed(request, 'c', false)
          : analysed(request, 'c', true);
      await settle();

      expect(published('run.escalated')).toEqual([]);
      expect(scheduler.stats.escalationRate).toBe(0);
    });

    it('keeps a hot pair against a newcomer of the same overlap, and records the deferral', async () => {
      make({ poolSize: 1 });
      answer = (request) => analysed(request, `${clock.now()}`, true);
      const first = clean('file');
      await changed(first.x);
      clock.advance(2_000);
      await settle();
      const second = clean('file');
      await changed(second.x);
      clock.advance(2_000);
      await settle();

      expect(scheduler.stats.escalations).toBe(1);
      expect(scheduler.stats.deferred).toBe(1);
      expect(scheduler.stats.evictions).toBe(0);

      // The hot one is checked again: still hot, and nothing evicted.
      await changed(first.x);
      clock.advance(2_000);
      await settle();
      expect(scheduler.stats.escalations).toBe(2);
      expect(scheduler.stats.evictions).toBe(0);
    });

    it('lets a newcomer that overlaps more displace a hot pair, and says which', async () => {
      make({ poolSize: 1 });
      answer = (request) => analysed(request, `${clock.now()}`, true);
      const weaker = clean('directory');
      await changed(weaker.x);
      clock.advance(2_000);
      await settle();
      const stronger = clean('file');
      await changed(stronger.x);
      clock.advance(2_000);
      await settle();

      expect(scheduler.stats.evictions).toBe(1);
      expect(published('run.escalated')[1]!.payload).toMatchObject({
        evicted: weaker.pair.pair.id,
        reason: 'common-file',
      });
      expect(scheduler.stats.evictionRate).toBe(0.5);
    });

    it('lets any newcomer displace a hot pair gone idle', async () => {
      make({ poolSize: 1 });
      answer = (request) => analysed(request, `${clock.now()}`, true);
      const idle = clean('file');
      await changed(idle.x);
      clock.advance(2_000);
      await settle();

      clock.advance(10 * 60_000 + 1);
      const newcomer = clean('directory');
      await changed(newcomer.x);
      clock.advance(2_000);
      await settle();

      expect(scheduler.stats.evictions).toBe(1);
      expect(scheduler.stats.deferred).toBe(0);
    });

    it('names a directory overlap as its reason', async () => {
      make();
      const { x } = clean('directory');
      answer = (request) => analysed(request, 'c', true);
      await changed(x);
      clock.advance(2_000);
      await settle();
      expect(published('run.escalated')[0]!.payload).toMatchObject({ reason: 'common-directory' });
    });

    it('counts a hot pair checked again as used, so it does not go idle', async () => {
      make({ poolSize: 1 });
      answer = (request) => analysed(request, `${clock.now()}`, true);
      const kept = clean('file');
      await changed(kept.x);
      clock.advance(2_000);
      await settle();
      clock.advance(9 * 60_000);
      await changed(kept.x);
      clock.advance(2_000);
      await settle();

      clock.advance(2 * 60_000);
      const newcomer = clean('file');
      await changed(newcomer.x);
      clock.advance(2_000);
      await settle();

      expect(scheduler.stats.evictions).toBe(0);
      expect(scheduler.stats.deferred).toBe(1);
    });

    it('evicts the hot pair that overlaps least', async () => {
      make({ poolSize: 2 });
      answer = (request) => analysed(request, `${clock.now()}`, true);
      const weak = clean('directory');
      await changed(weak.x);
      clock.advance(2_000);
      await settle();
      const strong = clean('file');
      await changed(strong.x);
      clock.advance(2_000);
      await settle();

      const newcomer = clean('file');
      await changed(newcomer.x);
      clock.advance(2_000);
      await settle();

      expect(published('run.escalated')[2]!.payload).toMatchObject({
        evicted: weak.pair.pair.id,
      });
    });

    it('among hot pairs that overlap alike, evicts the one unused longest', async () => {
      make({ poolSize: 2 });
      answer = (request) => analysed(request, `${clock.now()}`, true);
      const older = clean('directory');
      await changed(older.x);
      clock.advance(2_000);
      await settle();
      const newer = clean('directory');
      await changed(newer.x);
      clock.advance(2_000);
      await settle();

      const newcomer = clean('file');
      await changed(newcomer.x);
      clock.advance(2_000);
      await settle();

      expect(published('run.escalated')[2]!.payload).toMatchObject({
        evicted: older.pair.pair.id,
      });
    });

    it('frees a hot pair’s slot when one of its branches disappears', async () => {
      make({ poolSize: 1 });
      answer = (request) => analysed(request, `${clock.now()}`, true);
      const gone = clean('file');
      await changed(gone.x);
      clock.advance(2_000);
      await settle();
      await bus.publish({
        type: 'branch.disappeared',
        repoId,
        at: '',
        branchRefId: gone.x,
        reason: 'deleted',
      });

      const newcomer = clean('file');
      await changed(newcomer.x);
      clock.advance(2_000);
      await settle();

      expect(scheduler.stats.escalations).toBe(2);
      expect(scheduler.stats.evictions).toBe(0);
      expect(scheduler.stats.deferred).toBe(0);
    });

    it('reports no rates before there is anything to divide', () => {
      make();
      expect(scheduler.stats.escalationRate).toBeNull();
      expect(scheduler.stats.evictionRate).toBeNull();
    });
  });

  describe('a branch that disappears', () => {
    it('takes its queued pairs, its pending debounce and its running runs with it', async () => {
      make();
      const [x, y, z, blocker] = [branch(), branch(), branch(), branch()];
      plans.set(y, { candidates: [candidate(y, x, 'file')], declined: 0 });
      plans.set(z, {
        candidates: [candidate(z, x, 'file'), candidate(z, blocker, 'file')],
        declined: 0,
      });
      await changed(y);
      clock.advance(2_000);
      await settle();
      await changed(z);
      clock.advance(2_000);
      await settle();
      await changed(x);
      expect(scheduler.queueDepth).toBe(2);

      await bus.publish({
        type: 'branch.disappeared',
        repoId,
        at: '',
        branchRefId: x,
        reason: 'deleted',
      });

      expect(held[0]!.signal.aborted).toBe(true);
      expect(scheduler.queueDepth).toBe(1);
      clock.advance(2_000);
      await settle();
      expect(planned.filter((b) => b === x)).toEqual([]);
    });

    it('forgets what was analysed for it', async () => {
      make();
      const [x, y] = [branch(), branch()];
      plans.set(x, { candidates: [candidate(x, y, 'file')], declined: 0 });
      answer = (request) => analysed(request);
      await changed(x);
      clock.advance(2_000);
      await settle();
      await bus.publish({
        type: 'branch.disappeared',
        repoId,
        at: '',
        branchRefId: y,
        reason: 'deleted',
      });

      await changed(x);
      clock.advance(2_000);
      await settle();
      expect(scheduler.stats.analysed).toBe(2);
    });
  });

  describe('lifecycle', () => {
    it('queues a manual request at once, whatever its overlap', async () => {
      make();
      answer = (request) => analysed(request);
      await scheduler.enqueueNow(candidate(branch(), branch(), 'none'));
      await settle();
      expect(scheduler.stats.analysed).toBe(1);
      expect(published('pair.scheduled')[0]!.payload).toMatchObject({ reason: 'manual' });
    });

    it('stops listening, cancels debounces, and waits for runs in flight', async () => {
      make();
      const [x, y] = [branch(), branch()];
      plans.set(x, { candidates: [candidate(x, y, 'file')], declined: 0 });
      await changed(x);
      clock.advance(2_000);
      await settle();
      await changed(y);

      let stopped = false;
      const stopping = scheduler.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(held[0]!.signal.aborted).toBe(true);
      held[0]!.resolve({ kind: 'superseded' });
      held.length = 0;
      await stopping;

      await changed(x);
      clock.advance(10_000);
      expect(planned).toEqual([x]);
    });

    it('starts once however often it is started, and stops completely', async () => {
      make();
      scheduler.start();
      answer = (request) => analysed(request);
      const [x, y] = [branch(), branch()];
      plans.set(x, { candidates: [candidate(x, y, 'file')], declined: 0 });
      await changed(x);
      clock.advance(2_000);
      await settle();
      expect(planned).toEqual([x]);

      const handlers = bus.handlerCount;
      await scheduler.stop();
      expect(bus.handlerCount).toBe(handlers - 4);
    });
  });
});
