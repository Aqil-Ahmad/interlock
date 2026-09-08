import { join } from 'node:path';
import { createGitRunner } from '@interlock/core';
import type { GitRunner } from '@interlock/core';
import { INTERLOCK_PROTOCOL_VERSION, notImplemented } from '@interlock/shared';
import type { DaemonRuntime, EventRecord, InterlockConfig, Logger } from '@interlock/shared';
import { createApiServer } from './api/index.js';
import type { ApiServer } from './api/index.js';
import { EventBus } from './bus/index.js';
import { publishRuntime, unpublishRuntime } from './runtime-file.js';
import { openStore } from './store/index.js';
import type { Store } from './store/index.js';
import { createWatcher } from './watcher/index.js';
import type { Watcher } from './watcher/index.js';

/**
 * Composition root: the only place the watcher, bus, scheduler, store and API
 * are wired together. Everything else takes its collaborators as arguments,
 * which keeps the rest of the codebase testable without a running system.
 *
 * Startup order matters — store (migrations must succeed) → bus → API →
 * watcher → scheduler. Shutdown is the reverse and must abort in-flight runs
 * and dispose shadow worktrees, or the next start inherits stale locks.
 */

export interface DaemonOptions {
  readonly config: InterlockConfig;
  readonly logger: Logger;
  /** The process boundary, injectable so a test can slow git down. */
  readonly runner?: GitRunner;
  /** Overridable so a test does not wait out the reconciliation cadence. */
  readonly sweepIntervalMs?: number;
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

export function createDaemon(options: DaemonOptions): Daemon {
  const log = options.logger.child('daemon');
  const { config } = options;

  let store: Store | null = null;
  let api: ApiServer | null = null;
  let watcher: Watcher | null = null;
  let runtime: DaemonRuntime | null = null;
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
      if (store !== null) throw new Error('the daemon is already started');

      store = await openStore({ path: join(config.dataDir, DATABASE_FILENAME), logger: log });
      const bus = new EventBus({ logger: options.logger, onRecord: append });
      const runner = options.runner ?? createGitRunner();

      try {
        api = createApiServer({ config, store, logger: options.logger });
        const bound = await api.start();

        watcher = createWatcher({
          config,
          store,
          bus,
          runner,
          logger: options.logger,
          ...(options.sweepIntervalMs === undefined
            ? {}
            : { sweepIntervalMs: options.sweepIntervalMs }),
        });
        await watcher.start();

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
      } catch (error) {
        // A half-started daemon holds a port and a database handle, and the
        // next start would fail on both without saying why.
        await shutdown();
        throw error;
      }
    },

    stop(): Promise<void> {
      // Idempotent because it is reached from a signal handler, and a second
      // SIGTERM arrives more often than not.
      stopping ??= shutdown().finally(() => {
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

  async function shutdown(): Promise<void> {
    // Reverse of startup, and the order is the point: the watcher stops
    // producing before the listener stops serving, the listener stops serving
    // before the store closes under it, and the runtime file goes last so it
    // never advertises a daemon that has already dropped its port.
    await watcher?.stop();
    watcher = null;

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
    log.info('daemon stopped');
  }
}
