import { DEFAULT_POOL_SIZE } from '@interlock/core';
import { isInterlockError } from '@interlock/shared';
import type {
  BranchRefId,
  EventId,
  InterlockConfig,
  Logger,
  MergePair,
  MergePairKey,
  RepoId,
  SpeculativeRunId,
} from '@interlock/shared';
import type { EventBus, Subscription } from '../bus/index.js';
import type { OverlapTier, PairOverlap } from './overlap.js';

/**
 * Decides which branch pairs to re-analyse and when: debouncing edits,
 * prioritising pairs whose changes overlap, invalidating incrementally when a
 * branch moves, and discarding runs that no longer describe current state.
 *
 * This is where the daemon's performance is won or lost. Read notes.md before
 * changing anything here.
 */

export { pairOverlap } from './overlap.js';
export type { OverlapTier, PairOverlap } from './overlap.js';

/** A pair a settled branch takes part in, as the planner found it. */
export interface PairCandidate {
  /** The stored row; its id is what events and runs name. */
  readonly pair: MergePair;
  readonly overlap: PairOverlap;
  /** One side is the repository's default branch — the merge that will happen. */
  readonly target: boolean;
  /**
   * The pair has an open Finding. Only a run can resolve one, so such a pair is
   * run whatever its overlap — including after the edit that caused the
   * conflict is undone, which is exactly when its overlap disappears.
   */
  readonly openFindings: boolean;
}

export interface PairPlan {
  readonly candidates: readonly PairCandidate[];
  /** Pairs with nothing in common, left out before anything was asked of git. */
  readonly declined: number;
}

export interface PairRunRequest {
  readonly candidate: PairCandidate;
  /** Written to the pair's row; what the queue ranked the run at. */
  readonly priority: number;
  /** The `pair.scheduled` event this run answers, so its events trace back. */
  readonly cause: EventId;
  /**
   * False when this pair has already been analysed to completion at this
   * identity: the two sides' trees and the merge base, and what judged them —
   * the key its verdict is cached under.
   */
  isNew(contentKey: string): boolean;
}

export type PairRunResult =
  | {
      readonly kind: 'analysed';
      readonly runId: SpeculativeRunId;
      readonly contentKey: string;
      readonly clean: boolean;
      /** Answered from a verdict reached on the same content; nothing was merged. */
      readonly cached: boolean;
      readonly findingCount: number;
      /** The run's `run.finished`, which an escalation follows from. */
      readonly finished: EventId;
    }
  /** Identified, and already analysed at that content; nothing was merged. */
  | { readonly kind: 'duplicate'; readonly contentKey: string }
  /** Invalidated while it ran; its result was recorded as such and discarded. */
  | { readonly kind: 'superseded' }
  /** Nothing to merge: a side is gone, unreadable, unborn, or the histories are unrelated. */
  | {
      readonly kind: 'skipped';
      readonly reason: 'branch-gone' | 'unreadable' | 'unborn' | 'unrelated';
    }
  /** An analyzer could not run. Never a Finding; backed off like any infrastructure. */
  | { readonly kind: 'infra-failure'; readonly component: string; readonly message: string };

/** The time source, injectable so ordering is testable without waiting. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SchedulerOptions {
  readonly config: InterlockConfig;
  readonly bus: EventBus;
  readonly logger: Logger;
  /** The pairs a settled branch takes part in, with the overlap that ranks them. */
  plan(repoId: RepoId, branchRefId: BranchRefId): Promise<PairPlan>;
  /** Executes one pair. Injected so the scheduler is testable without git. */
  runPair(request: PairRunRequest, signal: AbortSignal): Promise<PairRunResult>;
  readonly clock?: Clock;
  /** Hot pairs kept at once: the worktree pool's size, which they stand for. */
  readonly poolSize?: number;
}

export interface SchedulerStats {
  readonly queueDepth: number;
  readonly running: number;
  /** Branches that went quiet, or hit the ceiling, and were planned. */
  readonly settled: number;
  /** Candidates dropped for having nothing in common. */
  readonly noOverlap: number;
  readonly started: number;
  readonly analysed: number;
  /** Analyses answered from the verdict cache, which merged nothing. */
  readonly cacheHits: number;
  readonly clean: number;
  readonly duplicates: number;
  readonly superseded: number;
  readonly skipped: number;
  readonly failures: number;
  readonly escalations: number;
  /** Clean merges with an overlap reason that did not displace a hot pair. */
  readonly deferred: number;
  readonly evictions: number;
  /** Escalations over clean merges analysed; null before the first. */
  readonly escalationRate: number | null;
  /** Evictions over escalations; null before the first. */
  readonly evictionRate: number | null;
  readonly maxQueueDepth: number;
}

export interface Scheduler {
  /** Subscribe to the bus. Called before the watcher starts, or its first pass goes unheard. */
  start(): void;
  /** Unsubscribe, cancel timers, and wait for runs in flight to land. */
  stop(): Promise<void>;
  /** Queue a pair immediately, bypassing debounce (used by `interlock check`). */
  enqueueNow(candidate: PairCandidate): Promise<void>;
  /** Resolves once nothing is running and nothing queued can start yet. */
  idle(): Promise<void>;
  readonly queueDepth: number;
  readonly stats: SchedulerStats;
}

/**
 * A branch that never goes quiet still settles this long after its first
 * unplanned change, as a multiple of the debounce.
 *
 * Agents edit continuously; a debounce alone would never fire for the branch
 * that matters most. Five debounces is ten seconds by default — inside the
 * 60-second budget from edit to Finding with room for the watcher's own two
 * seconds and the run.
 */
const CEILING_DEBOUNCES = 5;

/**
 * How long a queued pair waits to gain one overlap tier of priority.
 *
 * The only thing that lets a pair with nothing but a target in common outrank
 * a fresh common-file pair, which is what keeps a very active branch from
 * starving every pair it is not in.
 */
const AGING_MS = 30_000;

/** Backoff after an infrastructure failure: doubling from this, to the cap. */
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;

/**
 * Immediate retries for a stale snapshot before it is treated as infrastructure.
 *
 * Stale means capture again, and the retry does; a shadow that stays broken
 * would otherwise loop at full speed.
 */
const STALE_RETRIES = 3;

/**
 * A hot pair unused for this long can be displaced by any escalation.
 *
 * Stickiness is what keeps incremental compiler state alive, but a pair
 * nobody has touched in ten minutes is holding a slot for build state that is
 * going cold anyway.
 */
const HOT_IDLE_MS = 10 * 60_000;

const TIER_SCORE: Readonly<Record<OverlapTier, number>> = {
  file: 3,
  directory: 2,
  unknown: 1,
  none: 0,
};

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

interface PendingSettle {
  readonly repoId: RepoId;
  readonly firstAt: number;
  cause: EventId;
  timer: unknown;
}

interface QueueEntry {
  candidate: PairCandidate;
  cause: EventId;
  readonly enqueuedAt: number;
}

interface Running {
  readonly candidate: PairCandidate;
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

interface HotPair {
  readonly pair: MergePair;
  readonly tier: OverlapTier;
  lastUsedAt: number;
}

interface Backoff {
  failures: number;
  until: number;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const log = options.logger.child('scheduler');
  const { bus, config } = options;
  const clock = options.clock ?? realClock;
  const poolSize = options.poolSize ?? DEFAULT_POOL_SIZE;
  const debounceMs = config.scheduler.debounceMs;
  const boost = config.scheduler.overlapPriorityBoost;

  const pending = new Map<BranchRefId, PendingSettle>();
  /** One entry per pair, however many times it was asked for. */
  const queue = new Map<MergePairKey, QueueEntry>();
  const running = new Map<MergePairKey, Running>();
  /** The content each pair was last analysed to completion at. */
  const analysedAt = new Map<MergePairKey, string>();
  const backoff = new Map<MergePairKey, Backoff>();
  const staleRetries = new Map<MergePairKey, number>();
  /** Escalated pairs, as many as the pool has slots, in the order they were last used. */
  const hot = new Map<MergePairKey, HotPair>();
  /** Work that is not a run — planning — so `stop` and `idle` can wait for it. */
  const planning = new Set<Promise<void>>();
  let subscriptions: Subscription[] = [];
  let wake: unknown = null;
  let active = false;

  const counts = {
    settled: 0,
    noOverlap: 0,
    started: 0,
    analysed: 0,
    cacheHits: 0,
    clean: 0,
    duplicates: 0,
    superseded: 0,
    skipped: 0,
    failures: 0,
    escalations: 0,
    deferred: 0,
    evictions: 0,
    maxQueueDepth: 0,
  };

  const mustRun = (candidate: PairCandidate): boolean =>
    candidate.overlap.tier !== 'none' || candidate.target || candidate.openFindings;

  const involves = (candidate: PairCandidate, branch: BranchRefId): boolean =>
    candidate.pair.a === branch || candidate.pair.b === branch;

  /**
   * Base priority: overlap first, and never below one tier for a pair against
   * the target or one with a Finding to re-verify.
   */
  const priorityOf = (candidate: PairCandidate): number => {
    const tier = TIER_SCORE[candidate.overlap.tier];
    const score = candidate.target || candidate.openFindings ? Math.max(tier, 1) : tier;
    // Prefer re-checking a hot pair: its slot holds warm build state, and a
    // round-robin that let it go cold would pay the cold cost on the next check.
    return score * boost + (hot.has(candidate.pair.key) ? boost : 0);
  };

  const effectivePriority = (entry: QueueEntry, now: number): number =>
    priorityOf(entry.candidate) + Math.floor((now - entry.enqueuedAt) / AGING_MS) * boost;

  const onBranchEvent = (repoId: RepoId | null, branch: BranchRefId, id: EventId): void => {
    if (repoId === null) return;
    // The content a run in flight merged is already gone. Waiting for the
    // branch to settle would let a run that lands inside the debounce save
    // results for it.
    for (const run of running.values()) {
      if (involves(run.candidate, branch)) run.controller.abort();
    }
    const now = clock.now();
    const known = pending.get(branch);
    const entry: PendingSettle = known ?? { repoId, firstAt: now, cause: id, timer: null };
    entry.cause = id;
    if (entry.timer !== null) clock.clearTimeout(entry.timer);
    const at = Math.min(now + debounceMs, entry.firstAt + debounceMs * CEILING_DEBOUNCES);
    entry.timer = clock.setTimeout(
      () => {
        settle(branch);
      },
      Math.max(0, at - now),
    );
    pending.set(branch, entry);
  };

  const settle = (branch: BranchRefId): void => {
    const entry = pending.get(branch);
    if (entry === undefined) return;
    pending.delete(branch);
    counts.settled += 1;

    // What was computed for the old content no longer describes the branch.
    // Nothing below takes a signal, so an abort cannot stop a merge mid-flight;
    // it tells the run to discard its result when it lands.
    for (const run of running.values()) {
      if (involves(run.candidate, branch)) run.controller.abort();
    }

    track(
      options.plan(entry.repoId, branch).then(async ({ candidates, declined }) => {
        counts.noOverlap += declined;
        for (const candidate of candidates) {
          await enqueue(candidate, 'branch-moved', entry.cause);
        }
        pump();
      }),
    );
  };

  const track = (work: Promise<void>): void => {
    const settled: Promise<void> = work
      .catch((error: unknown) => {
        log.warn('planning pairs failed', { reason: reasonOf(error) });
      })
      .finally(() => {
        planning.delete(settled);
      });
    planning.add(settled);
  };

  const enqueue = async (
    candidate: PairCandidate,
    reason: 'branch-moved' | 'manual' | 'retry',
    cause: EventId | null,
  ): Promise<void> => {
    // A run landing after `stop` would otherwise queue its retry, and publish
    // it, into a scheduler nothing will ever pump again.
    if (!active) return;
    // Never merged: git conflicts only where both sides changed a path or its
    // parent, so a pair with nothing in common cannot conflict textually, and
    // without an overlap reason it is not a semantic candidate either.
    if (!mustRun(candidate) && reason !== 'manual') {
      counts.noOverlap += 1;
      return;
    }
    const key = candidate.pair.key;
    const scheduled = await bus.publish(
      {
        type: 'pair.scheduled',
        repoId: candidate.pair.repoId,
        at: new Date(clock.now()).toISOString(),
        mergePairId: candidate.pair.id,
        priority: priorityOf(candidate),
        reason,
      },
      cause === null ? {} : { causedBy: cause },
    );
    const queued = queue.get(key);
    if (queued === undefined) {
      queue.set(key, { candidate, cause: scheduled, enqueuedAt: clock.now() });
    } else {
      // Keeps its place in line: re-asking must not reset a pair's age.
      queued.candidate = candidate;
      queued.cause = scheduled;
    }
    counts.maxQueueDepth = Math.max(counts.maxQueueDepth, queue.size);
  };

  /** Start what can start, and arrange to be woken when a backoff ends. */
  const pump = (): void => {
    if (!active) return;
    const now = clock.now();
    while (running.size < config.scheduler.concurrency) {
      let best: [MergePairKey, QueueEntry] | null = null;
      let bestPriority = -Infinity;
      for (const [key, entry] of queue) {
        // One run per pair at a time; the queued request waits for it.
        if (running.has(key)) continue;
        if ((backoff.get(key)?.until ?? 0) > now) continue;
        const priority = effectivePriority(entry, now);
        if (priority > bestPriority) {
          best = [key, entry];
          bestPriority = priority;
        }
      }
      if (best === null) break;
      queue.delete(best[0]);
      launch(best[1], bestPriority);
    }
    armWake(now);
  };

  const armWake = (now: number): void => {
    if (wake !== null) clock.clearTimeout(wake);
    wake = null;
    let soonest = Infinity;
    for (const key of queue.keys()) {
      const until = backoff.get(key)?.until ?? 0;
      if (until > now && !running.has(key)) soonest = Math.min(soonest, until);
    }
    if (soonest !== Infinity) {
      wake = clock.setTimeout(() => {
        wake = null;
        pump();
      }, soonest - now);
    }
  };

  const launch = (entry: QueueEntry, priority: number): void => {
    const { candidate, cause } = entry;
    const key = candidate.pair.key;
    const controller = new AbortController();
    counts.started += 1;
    const request: PairRunRequest = {
      candidate,
      priority,
      cause,
      isNew: (contentKey) => analysedAt.get(key) !== contentKey,
    };
    // Wrapped so a run that throws before returning a promise lands like one
    // that rejects, rather than escaping the pump and leaving it half-done.
    const done = new Promise<PairRunResult>((resolve) => {
      resolve(options.runPair(request, controller.signal));
    })
      .then(
        (result) => land(candidate, result, cause),
        (error: unknown) => fail(candidate, error, cause),
      )
      .catch((error: unknown) => {
        log.error('handling a run outcome failed', { reason: reasonOf(error) });
      })
      .finally(() => {
        running.delete(key);
        pump();
      });
    running.set(key, { candidate, controller, done });
  };

  /** `cause` is the `pair.scheduled` the run answered, which a retry follows from. */
  const land = async (
    candidate: PairCandidate,
    result: PairRunResult,
    cause: EventId,
  ): Promise<void> => {
    const key = candidate.pair.key;
    if (result.kind !== 'infra-failure') {
      backoff.delete(key);
      staleRetries.delete(key);
    }
    switch (result.kind) {
      case 'analysed':
        counts.analysed += 1;
        if (result.cached) counts.cacheHits += 1;
        analysedAt.set(key, result.contentKey);
        if (result.clean) {
          counts.clean += 1;
          await escalate(candidate, result.runId, result.finished);
        }
        return;
      case 'duplicate':
        counts.duplicates += 1;
        return;
      case 'superseded':
        counts.superseded += 1;
        return;
      case 'skipped':
        counts.skipped += 1;
        log.debug('pair skipped', { mergePairId: candidate.pair.id, reason: result.reason });
        return;
      case 'infra-failure':
        await backOff(candidate, cause, result.component, 'INFRA_FAILURE', result.message);
        return;
    }
  };

  const fail = async (candidate: PairCandidate, error: unknown, cause: EventId): Promise<void> => {
    const key = candidate.pair.key;
    if (isInterlockError(error) && error.code === 'SNAPSHOT_STALE') {
      // Stale means capture again, and the retry does — at once, since waiting
      // makes nothing more likely to be in the shadow.
      const tries = (staleRetries.get(key) ?? 0) + 1;
      staleRetries.set(key, tries);
      if (tries <= STALE_RETRIES) {
        await enqueue(candidate, 'retry', cause);
        return;
      }
    }
    if (isInterlockError(error) && (error.infra || error.code === 'SNAPSHOT_STALE')) {
      await backOff(candidate, cause, 'run-pipeline', error.code, error.message);
      return;
    }
    // Neither the environment nor stale content: a bug. Retrying would repeat
    // it; the pair runs again when a branch in it next moves.
    counts.failures += 1;
    log.error('a run failed', { mergePairId: candidate.pair.id, reason: reasonOf(error) });
  };

  const backOff = async (
    candidate: PairCandidate,
    cause: EventId,
    component: string,
    code: string,
    message: string,
  ): Promise<void> => {
    counts.failures += 1;
    const key = candidate.pair.key;
    const state = backoff.get(key) ?? { failures: 0, until: 0 };
    state.failures += 1;
    state.until =
      clock.now() + Math.min(BACKOFF_BASE_MS * 2 ** (state.failures - 1), BACKOFF_MAX_MS);
    backoff.set(key, state);
    staleRetries.delete(key);
    // Once per streak: an environment that is down stays down across retries,
    // and saying so on every one fills the log with the same sentence.
    if (state.failures === 1) {
      await bus.publish(
        {
          type: 'infra.failure',
          repoId: candidate.pair.repoId,
          at: new Date(clock.now()).toISOString(),
          component,
          code,
          message,
        },
        { causedBy: cause },
      );
    }
    await enqueue(candidate, 'retry', cause);
  };

  /**
   * Give a clean merge with an overlap reason one of the pool's slots.
   *
   * A hot pair keeps its slot against a newcomer unless the newcomer overlaps
   * more, or the hot pair has gone idle: every eviction discards the build state
   * that makes the next check of that pair cheap.
   */
  const escalate = async (
    candidate: PairCandidate,
    runId: SpeculativeRunId,
    finished: EventId,
  ): Promise<void> => {
    const tier = candidate.overlap.tier;
    if (tier !== 'file' && tier !== 'directory') return;
    const key = candidate.pair.key;
    const now = clock.now();

    let evicted: HotPair | null = null;
    const current = hot.get(key);
    if (current !== undefined) {
      current.lastUsedAt = now;
    } else {
      if (hot.size >= poolSize) {
        const victim = weakestHot();
        const displaces =
          victim !== null &&
          (TIER_SCORE[tier] > TIER_SCORE[victim[1].tier] ||
            now - victim[1].lastUsedAt > HOT_IDLE_MS);
        if (victim === null || !displaces) {
          counts.deferred += 1;
          return;
        }
        hot.delete(victim[0]);
        evicted = victim[1];
        counts.evictions += 1;
      }
      hot.set(key, { pair: candidate.pair, tier, lastUsedAt: now });
    }

    counts.escalations += 1;
    await bus.publish(
      {
        type: 'run.escalated',
        repoId: candidate.pair.repoId,
        at: new Date(now).toISOString(),
        runId,
        mergePairId: candidate.pair.id,
        reason: tier === 'file' ? 'common-file' : 'common-directory',
        evicted: evicted?.pair.id ?? null,
      },
      { causedBy: finished },
    );
  };

  /** The hot pair least worth keeping: lowest overlap, then longest unused. */
  const weakestHot = (): [MergePairKey, HotPair] | null => {
    let weakest: [MergePairKey, HotPair] | null = null;
    for (const entry of hot) {
      if (
        weakest === null ||
        TIER_SCORE[entry[1].tier] < TIER_SCORE[weakest[1].tier] ||
        (TIER_SCORE[entry[1].tier] === TIER_SCORE[weakest[1].tier] &&
          entry[1].lastUsedAt < weakest[1].lastUsedAt)
      ) {
        weakest = entry;
      }
    }
    return weakest;
  };

  const forgetBranch = (branch: BranchRefId): void => {
    const settling = pending.get(branch);
    if (settling !== undefined) clock.clearTimeout(settling.timer);
    pending.delete(branch);
    for (const [key, entry] of queue) if (involves(entry.candidate, branch)) queue.delete(key);
    for (const run of running.values()) {
      if (involves(run.candidate, branch)) run.controller.abort();
    }
    for (const [key, entry] of hot) {
      if (entry.pair.a === branch || entry.pair.b === branch) hot.delete(key);
    }
    for (const key of [...analysedAt.keys(), ...backoff.keys(), ...staleRetries.keys()]) {
      if (key.split(':').includes(branch)) {
        analysedAt.delete(key);
        backoff.delete(key);
        staleRetries.delete(key);
      }
    }
  };

  const idle = async (): Promise<void> => {
    for (;;) {
      const waiting = [...planning, ...[...running.values()].map((run) => run.done)];
      if (waiting.length === 0) return;
      await Promise.all(waiting);
    }
  };

  return {
    start(): void {
      if (active) return;
      active = true;
      subscriptions = [
        bus.on('branch.snapshot', (event, id) => {
          // Unknown content is not a change to schedule on; the run would
          // find nothing to merge.
          if (event.treeOid !== null) onBranchEvent(event.repoId, event.branchRefId, id);
        }),
        bus.on('branch.updated', (event, id) => {
          onBranchEvent(event.repoId, event.branchRefId, id);
        }),
        bus.on('branch.appeared', (event, id) => {
          onBranchEvent(event.repoId, event.branchRefId, id);
        }),
        bus.on('branch.disappeared', (event) => {
          forgetBranch(event.branchRefId);
        }),
      ];
      pump();
    },

    async stop(): Promise<void> {
      active = false;
      for (const subscription of subscriptions) subscription.unsubscribe();
      subscriptions = [];
      for (const entry of pending.values()) clock.clearTimeout(entry.timer);
      pending.clear();
      if (wake !== null) clock.clearTimeout(wake);
      wake = null;
      queue.clear();
      for (const run of running.values()) run.controller.abort();
      await idle();
      log.info('scheduler stopped', { ...statsOf() });
    },

    async enqueueNow(candidate: PairCandidate): Promise<void> {
      await enqueue(candidate, 'manual', null);
      pump();
    },

    idle,

    get queueDepth(): number {
      return queue.size;
    },

    get stats(): SchedulerStats {
      return statsOf();
    },
  };

  function statsOf(): SchedulerStats {
    return {
      ...counts,
      queueDepth: queue.size,
      running: running.size,
      escalationRate: counts.clean === 0 ? null : counts.escalations / counts.clean,
      evictionRate: counts.escalations === 0 ? null : counts.evictions / counts.escalations,
    };
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
