import { join } from 'node:path';
import { createGitRunner } from '@interlock/core';
import type { GitRunner } from '@interlock/core';
import { INTERLOCK_PROTOCOL_VERSION, notImplemented } from '@interlock/shared';
import type { DaemonRuntime, EventRecord, InterlockConfig, Logger } from '@interlock/shared';
import { createApiServer } from './api/index.js';
import { createChecks } from './check.js';
import type { Checks } from './check.js';
import { holdDataDir, refuseDataDirInRepos } from './data-dir.js';
import type { DataDirHold } from './data-dir.js';
import type { ApiServer } from './api/index.js';
import { EventBus } from './bus/index.js';
import { createSessionRegistry } from './hooks/index.js';
import { createRetention } from './retention.js';
import type { Retention } from './retention.js';
import { publishRuntime, unpublishRuntime } from './runtime-file.js';
import { createScheduler } from './scheduler/index.js';
import type { Scheduler } from './scheduler/index.js';
import { createRunPipeline, SNAPSHOT_COMMIT_REUSE_MS } from './scheduler/run-pipeline.js';
import type { RunPipeline } from './scheduler/run-pipeline.js';
import { createShadowCollector, createShadowRegistry } from './shadows.js';
import { openStore } from './store/index.js';
import type { Store } from './store/index.js';
import { createWatcher } from './watcher/index.js';
import type { WatchFactory, Watcher } from './watcher/index.js';

/**
 * Composition root: the only place the watcher, bus, scheduler, store and API
 * are wired together. Everything else takes its collaborators as arguments,
 * which keeps the rest of the codebase testable without a running system.
 *
 * Startup order matters — data-dir hold → store (migrations must succeed) →
 * bus → API → scheduler → watcher → retention. The scheduler listens before the
 * watcher's first pass, or the branches that pass announces are never planned;
 * retention starts once the daemon is up, and prunes in the background. Shutdown
 * stops the watcher first, so nothing new is scheduled, then lets the runs in
 * flight and a retention pass land before the store closes under them.
 */

export interface DaemonOptions {
  readonly config: InterlockConfig;
  readonly logger: Logger;
  /** The process boundary, injectable so a test can slow git down. */
  readonly runner?: GitRunner;
  /** Overridable so a test does not wait out the reconciliation cadence. */
  readonly sweepIntervalMs?: number;
  /**
   * The filesystem's kernel boundary, injectable so a test can take the
   * signal away and show the budget holding without it.
   */
  readonly watchFactory?: WatchFactory;
  /** Overridable so a test does not wait out the retention cadence. */
  readonly retentionIntervalMs?: number;
}

export interface Daemon {
  start(): Promise<void>;
  /** Graceful stop: drain runs, dispose shadow worktrees, close the store. */
  stop(): Promise<void>;
  /** Stop and delete all Interlock data on this machine. */
  purge(): Promise<void>;
  /**
   * What was published for clients to find, or `null` when not running.
   *
   * Carries the port the listener actually bound, which is the only answer when
   * `daemon.port` is `0`.
   */
  readonly runtime: DaemonRuntime | null;
}

/** The SQLite file, alongside `shadows/` and the runtime file in the data dir. */
const DATABASE_FILENAME = 'interlock.db';

/**
 * How often dead agent sessions are ended when nobody is reading them.
 *
 * The watcher's cadence, for the same reasoning: a pass is cheap — one signal
 * per pid — and nothing downstream is waiting on it.
 */
const DEFAULT_REAP_INTERVAL_MS = 30_000;

export function createDaemon(options: DaemonOptions): Daemon {
  const log = options.logger.child('daemon');
  const { config } = options;

  let hold: DataDirHold | null = null;
  /** A start in flight: a second start is refused, and a stop waits it out. */
  let starting: Promise<void> | null = null;
  let store: Store | null = null;
  let api: ApiServer | null = null;
  let watcher: Watcher | null = null;
  let pipeline: RunPipeline | null = null;
  let scheduler: Scheduler | null = null;
  let runtime: DaemonRuntime | null = null;
  /**
   * Reaps agent sessions on the same cadence the watcher reconciles on.
   *
   * A read reaps too, so a `status` never shows a dead session; the timer is
   * for the store's own view of a branch's owner, which nothing reads between
   * commands and which would otherwise name a dead agent until someone asked.
   */
  let reaper: ReturnType<typeof setInterval> | null = null;
  let retention: Retention | null = null;
  /**
   * Appends, chained so the log stays in the order it was published.
   *
   * `onRecord` is synchronous and `appendEvent` is not, so floating the promises
   * would let two appends land out of order — and the event log is append-only,
   * read back in ULID order, and is the whole basis of replay.
   */
  let appends: Promise<void> = Promise.resolve();
  let stopping: Promise<void> | null = null;

  const append = (record: EventRecord): void => {
    const target = store;
    if (target === null) return;
    appends = appends
      .then(() => target.appendEvent(record))
      .catch((error: unknown) => {
        log.error('could not persist an event', {
          eventId: record.id,
          eventType: record.type,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
  };

  return {
    get runtime(): DaemonRuntime | null {
      return runtime;
    },

    async start(): Promise<void> {
      if (hold !== null || starting !== null) throw new Error('the daemon is already started');
      starting = begin();
      try {
        await starting;
      } finally {
        starting = null;
      }
    },

    stop(): Promise<void> {
      // Idempotent because it is reached from a signal handler, and a second
      // SIGTERM arrives more often than not.
      // After any start in flight, which would otherwise take the lock and bind
      // the port once this had already returned, leaving a daemon running that
      // its caller was told had stopped.
      stopping ??= (async (): Promise<void> => {
        await starting?.catch(() => undefined);
        await shutdown();
      })().finally(() => {
        stopping = null;
      });
      return stopping;
    },

    purge(): Promise<void> {
      // Declared, not written: the kill switch belongs with the daemon UX work.
      // Raised through a promise rather than thrown, because the signature says
      // it returns one and a caller attaching `.catch` would never see it.
      return Promise.resolve().then(() => notImplemented('purge'));
    },
  };

  async function begin(): Promise<void> {
    // Taken before anything that could start a run, so every run this process
    // starts is later than it.
    const startedAt = new Date().toISOString();
    const runner = options.runner ?? createGitRunner();
    // Before the lock, which is the first thing written to the data dir.
    await refuseDataDirInRepos(config.dataDir, config.repos, runner);
    // First of what is written, so a second daemon is turned away before it
    // touches anything the first one owns — the store's migrations included.
    hold = holdDataDir(config.dataDir, log);
    const bus = new EventBus({ logger: options.logger, onRecord: append });

    try {
      store = await openStore({ path: join(config.dataDir, DATABASE_FILENAME), logger: log });
      const sessions = createSessionRegistry({
        store,
        bus,
        logger: options.logger,
        staleAfterMs: config.sessions.staleAfterMs,
      });
      let checks: Checks | null = null;
      api = createApiServer({
        config,
        store,
        sessions,
        checks: () => checks,
        logger: options.logger,
      });
      const bound = await api.start();

      const cadence = options.sweepIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
      reaper = setInterval(() => {
        void sessions.reap().catch((error: unknown) => {
          log.warn('reaping sessions failed', {
            reason: error instanceof Error ? error.message : String(error),
          });
        });
      }, cadence);

      // One shadow per repository for everything that writes objects: the
      // watcher's captures and the commits a run merges must be one store.
      const shadows = createShadowRegistry({ runner, dataDir: config.dataDir });
      const runs = createRunPipeline({ store, bus, runner, shadows, logger: options.logger });
      pipeline = runs;
      runs.attach();
      const scheduling = createScheduler({
        config,
        bus,
        logger: options.logger,
        plan: (repoId, branchRefId) => runs.plan(repoId, branchRefId),
        runPair: (request, signal) => runs.runPair(request, signal),
      });
      scheduler = scheduling;
      scheduling.start();

      watcher = createWatcher({
        config,
        store,
        bus,
        runner,
        shadows,
        logger: options.logger,
        ...(options.sweepIntervalMs === undefined
          ? {}
          : { sweepIntervalMs: options.sweepIntervalMs }),
        ...(options.watchFactory === undefined ? {} : { watchFactory: options.watchFactory }),
      });
      await watcher.start();
      const watching = watcher;
      checks = createChecks({
        store,
        refreshRepo: (rootPath) => watching.refreshRepo(rootPath),
        planPair: (repoId, a, b) => runs.planPair(repoId, a, b),
        check: (candidate) => scheduling.check(candidate),
        logger: options.logger,
      });

      // Published last, so the file appearing means the daemon can answer
      // about the repositories it watches rather than merely accept a socket.
      runtime = {
        protocolVersion: INTERLOCK_PROTOCOL_VERSION,
        port: bound.port,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };
      publishRuntime(config.dataDir, runtime, log);
      log.info('daemon started', { port: runtime.port, repos: config.repos.length });

      // After the daemon is up, never before: a store that has not been pruned
      // in a while holds a backlog, and the first pass clears it in the
      // background, a batch at a time.
      const collector = createShadowCollector({
        shadows,
        store,
        runner,
        heldTrees: (repoId) => runs.heldTrees(repoId),
        marginMs: SNAPSHOT_COMMIT_REUSE_MS,
        quiet: () => scheduling.idle(),
        logger: options.logger,
      });
      retention = createRetention({
        store,
        windowMs: config.retention.windowMs,
        logger: options.logger,
        // Every run this daemon starts is later than this, so an unfinished one
        // started before it was left by a process that is gone.
        abandonedBefore: startedAt,
        // In the same pass, after the store: a verdict is pruned before the
        // objects it names, so none can be served naming what is gone.
        collect: (before, signal) => collector.pass(before, signal),
        ...(options.retentionIntervalMs === undefined
          ? {}
          : { intervalMs: options.retentionIntervalMs }),
      });
      retention.start();
    } catch (error) {
      // A half-started daemon holds a port and a database handle, and the
      // next start would fail on both without saying why.
      await shutdown();
      throw error;
    }
  }

  async function shutdown(): Promise<void> {
    // Reverse of startup, and the order is the point: the watcher stops
    // producing before the listener stops serving, the listener stops serving
    // before the store closes under it, and the runtime file goes last so it
    // never advertises a daemon that has already dropped its port.
    await watcher?.stop();
    watcher = null;

    // Runs in flight write to the store, so they land before it closes.
    await scheduler?.stop();
    scheduler = null;
    pipeline?.detach();
    pipeline = null;

    if (reaper !== null) {
      clearInterval(reaper);
      reaper = null;
    }

    // A pass writes to the store, so it lands before the store closes.
    await retention?.stop();
    retention = null;

    await api?.stop();
    api = null;

    // The bus resolves a publish once its subscribers settle, but a persisted
    // event is one more `await` behind that, so the queue outlives the last
    // publish by a tick and the store must not close in between.
    //
    // Drained in a loop rather than with one `await`. `appends` is re-assigned
    // by every append, so awaiting it pins the tail as it was at that instant
    // and anything chained while that await was pending is left behind — to be
    // rejected by a store that has closed underneath it. Nothing publishes once
    // the watcher has stopped, so the second pass is a check rather than work;
    // what it removes is the assumption, which is not written down anywhere
    // else and stops holding the moment there is a second producer.
    for (;;) {
      const tail = appends;
      await tail;
      if (appends === tail) break;
    }

    await store?.close();
    store = null;

    if (runtime !== null) {
      unpublishRuntime(config.dataDir, log);
      runtime = null;
    }

    // Last: until everything above has let go, the directory is still in use.
    hold?.release();
    hold = null;
    log.info('daemon stopped');
  }
}
