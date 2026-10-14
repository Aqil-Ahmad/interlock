import { Worker } from 'node:worker_threads';
import { InterlockError, silentLogger } from '@interlock/shared';
import type { Logger } from '@interlock/shared';
import { DEFAULT_POOL_SIZE } from '../git/worktree-pool.js';
import { DEFAULT_PROJECT, siblingModule } from './typecheck-paths.js';
import type {
  TypecheckReport,
  WorkerInit,
  WorkerRequest,
  WorkerResponse,
} from './typecheck-service.js';

export type {
  ConfigDiagnostic,
  DiagnosticCategory,
  FileDiagnostic,
  TypecheckReport,
} from './typecheck-service.js';

/**
 * The type-check services the daemon keeps warm: one per tree, each in a
 * worker thread of its own.
 *
 * A check is synchronous inside the compiler and takes seconds on a large
 * repository; on the daemon's main thread it would hold off the watcher, the
 * API and every other run for as long. In a worker it costs the main thread a
 * message each way, and the compiler's incremental state — parsed files,
 * resolved modules, cached diagnostics — stays alive between checks of the same
 * tree, which is what makes the second check cost the change rather than the
 * repository.
 *
 * Keyed by the tree's path. A pool slot is released when the pool evicts it;
 * a merge base or one side of a pair is a tree like any other.
 */

/** Live services kept at once when the caller does not say: one per pool slot. */
export const DEFAULT_LIVE_SERVICES = DEFAULT_POOL_SIZE;

/**
 * The old-generation heap a service may grow to before its worker is stopped.
 *
 * A bound, not a target: past it the check fails as infrastructure rather than
 * growing the daemon without limit, four services at a time. Enforced twice,
 * because Node lets a process-wide `--max-old-space-size` — in `NODE_OPTIONS`,
 * say — override a worker's own limit: as the worker's heap limit, and by
 * stopping a service whose heap is over it once a check is done.
 */
export const DEFAULT_SERVICE_HEAP_MB = 3072;

export interface TypecheckRegistryOptions {
  readonly maxServices?: number;
  readonly maxHeapMb?: number;
  readonly logger?: Logger;
}

export interface TypecheckRequest {
  /** The tree to check. A service is kept for it until it is released. */
  readonly root: string;
  /** The checkout whose installed `node_modules` the tree borrows. */
  readonly dependencyRoot: string;
  /** The tsconfig to start from, relative to `root`; `tsconfig.json` unless given. */
  readonly project?: string;
  /**
   * How the tree was last written. `cold` — a slot filled whole — invalidates
   * every file the service holds, since a rewritten file's size and times can
   * match what was there before.
   */
  readonly fill?: 'cold' | 'delta';
  /** Aborted to stop a check where it stands; the service survives it. */
  readonly signal?: AbortSignal;
  /**
   * Called once the worker has the check, after any wait for the service:
   * the line between queueing and compiling, for whoever is timing either.
   */
  readonly onStarted?: () => void;
}

export type TypecheckOutcome =
  | {
      readonly kind: 'checked';
      readonly report: TypecheckReport;
      readonly durationMs: number;
      /** The service had checked this tree before: its incremental state was reused. */
      readonly warm: boolean;
      /** The worker's heap after the check: what keeping this service costs. */
      readonly heapBytes: number;
    }
  | { readonly kind: 'cancelled' };

export interface TypecheckRegistry {
  /**
   * Check a tree with its service, starting one if it has none.
   *
   * Checks of one tree run one at a time, in the order asked. With every
   * service busy, a check of a new tree waits for one to finish rather than
   * start another.
   *
   * @throws InterlockError `ANALYZER_INFRA_FAILURE`, infra, when the worker
   *         dies, runs out of heap or the compiler throws; the service is gone
   *         and the next check starts a new one.
   */
  check(request: TypecheckRequest): Promise<TypecheckOutcome>;
  /** Stop a tree's service, if it has one: its tree is going away. */
  release(root: string): Promise<void>;
  /** Stop every service. Checks asked for afterwards are refused. */
  close(): Promise<void>;
  /** Services alive now. */
  readonly live: number;
}

interface Pending {
  readonly started: () => void;
  readonly resolve: (response: Extract<WorkerResponse, { type: 'result' }>) => void;
  readonly reject: (error: Error) => void;
}

interface Service {
  readonly root: string;
  readonly dependencyRoot: string;
  readonly project: string;
  readonly worker: Worker;
  readonly pending: Map<number, Pending>;
  /** The tail of this service's checks: each runs after the one before has settled. */
  queue: Promise<unknown>;
  /** Checks holding or waiting for the service. A service with any is never stopped to make room. */
  holders: number;
  checks: number;
  lastUsedAt: number;
  /**
   * A slot filled whole that no check has told the worker about yet. Kept on
   * the service rather than the request: a cold check cancelled before it was
   * sent leaves the tree just as rewritten for the next one.
   */
  coldPending: boolean;
  /** Why the service was taken out, for checks still queued on it. */
  ended: InterlockError | null;
}

/** The worker beside this module: `src` under test, `dist` once built. */
const WORKER_URL = siblingModule(import.meta.url, 'typecheck-worker');

export function createTypecheckRegistry(options: TypecheckRegistryOptions = {}): TypecheckRegistry {
  const maxServices = options.maxServices ?? DEFAULT_LIVE_SERVICES;
  const maxHeapMb = options.maxHeapMb ?? DEFAULT_SERVICE_HEAP_MB;
  const log = (options.logger ?? silentLogger).child('typecheck');
  if (!Number.isInteger(maxServices) || maxServices < 1) {
    throw new InterlockError('CONFIG_INVALID', 'The type checker needs at least one service', {
      details: { maxServices },
      remedy: 'Set the number of live services to a whole number of 1 or more.',
    });
  }

  // Insertion order is recency: a use moves a service to the end.
  const services = new Map<string, Service>();
  let waiters: (() => void)[] = [];
  let nextId = 0;
  let closed = false;

  const wakeWaiters = (): void => {
    const woken = waiters;
    waiters = [];
    for (const wake of woken) wake();
  };

  const failure = (service: Service, reason: string, cause?: unknown): InterlockError =>
    new InterlockError('ANALYZER_INFRA_FAILURE', `The type checker stopped: ${reason}`, {
      ...(cause === undefined ? {} : { cause }),
      details: { maxHeapMb, checks: service.checks },
      remedy:
        'Check the daemon log for the worker error; a repository too large for the heap bound needs a larger one.',
      infra: true,
    });

  /** Take a service out of the registry and fail whatever was waiting on it. */
  const drop = (service: Service, error: InterlockError): void => {
    if (services.get(service.root) === service) services.delete(service.root);
    service.ended ??= error;
    for (const pending of service.pending.values()) pending.reject(error);
    service.pending.clear();
    wakeWaiters();
  };

  const stop = async (service: Service, why: string): Promise<void> => {
    drop(service, failure(service, why));
    await service.worker.terminate();
    log.debug('type-check service stopped', { checks: service.checks, why });
  };

  const spawn = (request: TypecheckRequest): Service => {
    const init: WorkerInit = {
      root: request.root,
      dependencyRoot: request.dependencyRoot,
      project: request.project ?? DEFAULT_PROJECT,
    };
    const worker = new Worker(WORKER_URL, {
      workerData: init,
      resourceLimits: { maxOldGenerationSizeMb: maxHeapMb },
    });
    // Idle, a worker does not keep the process alive; a check refs it.
    worker.unref();
    const service: Service = {
      ...init,
      worker,
      pending: new Map(),
      queue: Promise.resolve(),
      holders: 0,
      checks: 0,
      lastUsedAt: Date.now(),
      coldPending: false,
      ended: null,
    };
    // A check is pending until its result: a message for one that is not
    // was failed already, by a release or the worker's death.
    worker.on('message', (response: WorkerResponse) => {
      const pending = service.pending.get(response.id);
      if (response.type === 'started') {
        pending?.started();
        return;
      }
      service.pending.delete(response.id);
      pending?.resolve(response);
    });
    worker.on('error', (error: Error) => {
      log.warn('type-check worker failed', { reason: error.message });
      drop(service, failure(service, error.message, error));
    });
    worker.on('exit', (exitCode) => {
      drop(service, failure(service, `the worker exited with code ${exitCode}`));
    });
    log.debug('type-check service started', { live: services.size + 1 });
    return service;
  };

  /**
   * The tree's service, making room for it if it has none.
   *
   * Claimed with no await between the lookup and the claim, so two checks
   * cannot both start a service for one tree, or both take the last place.
   */
  const claim = async (request: TypecheckRequest): Promise<Service> => {
    for (;;) {
      if (closed) {
        throw new InterlockError('ANALYZER_INFRA_FAILURE', 'The type checker has been closed', {
          remedy: 'The daemon is stopping; the check is not needed.',
          infra: true,
        });
      }
      const existing = services.get(request.root);
      if (
        existing !== undefined &&
        (existing.dependencyRoot !== request.dependencyRoot ||
          existing.project !== (request.project ?? DEFAULT_PROJECT))
      ) {
        if (existing.holders > 0) {
          await new Promise<void>((resolve) => waiters.push(resolve));
          continue;
        }
        await stop(existing, 'its tree is checked against other dependencies or another project');
        continue;
      }
      if (existing !== undefined) {
        existing.holders += 1;
        services.delete(existing.root);
        services.set(existing.root, existing);
        return existing;
      }
      if (services.size >= maxServices) {
        const victim = [...services.values()].find((candidate) => candidate.holders === 0);
        if (victim === undefined) {
          await new Promise<void>((resolve) => waiters.push(resolve));
          continue;
        }
        void stop(victim, 'room was needed for another tree');
        continue;
      }
      const service = spawn(request);
      service.holders += 1;
      services.set(service.root, service);
      return service;
    }
  };

  const send = async (service: Service, request: TypecheckRequest): Promise<TypecheckOutcome> => {
    const { signal } = request;
    if (signal?.aborted === true) return { kind: 'cancelled' };
    if (services.get(service.root) !== service) {
      throw service.ended ?? failure(service, 'it was released');
    }
    const id = (nextId += 1);
    const cancel = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const flag = new Int32Array(cancel);
    const onAbort = (): void => {
      Atomics.store(flag, 0, 1);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const warm = service.checks > 0;
    const message: WorkerRequest = {
      type: 'check',
      id,
      // A fresh service reads every file anyway.
      cold: warm && service.coldPending,
      cancel,
    };
    service.worker.ref();
    try {
      const response = await new Promise<Extract<WorkerResponse, { type: 'result' }>>(
        (resolve, reject) => {
          service.pending.set(id, { started: () => request.onStarted?.(), resolve, reject });
          service.worker.postMessage(message);
          service.coldPending = false;
        },
      );
      service.checks += 1;
      if (response.heapBytes > maxHeapMb * 2 ** 20) {
        log.warn('type-check service over its heap bound, stopped', {
          heapBytes: response.heapBytes,
          maxHeapMb,
        });
        void stop(service, 'its heap grew past the bound');
      }
      if (response.result.kind === 'cancelled') return { kind: 'cancelled' };
      return {
        kind: 'checked',
        report: response.result.report,
        durationMs: response.durationMs,
        warm,
        heapBytes: response.heapBytes,
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      service.worker.unref();
    }
  };

  return {
    async check(request: TypecheckRequest): Promise<TypecheckOutcome> {
      if (request.fill === 'cold') {
        const existing = services.get(request.root);
        if (existing !== undefined) existing.coldPending = true;
      }
      if (request.signal?.aborted === true) return { kind: 'cancelled' };
      const service = await claim(request);
      try {
        const run = service.queue.then(() => send(service, request));
        service.queue = run.catch(() => undefined);
        return await run;
      } finally {
        service.holders -= 1;
        service.lastUsedAt = Date.now();
        wakeWaiters();
      }
    },

    async release(root: string): Promise<void> {
      const service = services.get(root);
      if (service !== undefined) await stop(service, 'its tree was released');
    },

    async close(): Promise<void> {
      closed = true;
      await Promise.all([...services.values()].map((service) => stop(service, 'closed')));
    },

    get live(): number {
      return services.size;
    },
  };
}
