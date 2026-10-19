import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  DEFAULT_CONFIG,
  InterlockError,
  redact,
  silentLogger,
  TYPECHECK_MIN_HEAP_MB,
} from '@interlock/shared';
import type { Logger, TypecheckConfig } from '@interlock/shared';
import { assertObjectId, runRequired } from '../git/repo-handle.js';
import type { AnyRepo, GitRunner } from '../git/repo-handle.js';
import { DEFAULT_POOL_SIZE } from '../git/worktree-pool.js';
import { DEFAULT_PROJECT, siblingModule } from './typecheck-paths.js';
import type {
  TreeEntry,
  TreeListing,
  TypecheckReport,
  WorkerInit,
  WorkerRequest,
  WorkerResponse,
} from './typecheck-service.js';

// The listing's entry type stays the analyzer's own: core has other tree
// listings, and one name on its surface cannot serve them all.
export type {
  ConfigDiagnostic,
  DiagnosticCategory,
  FileDiagnostic,
  TreeListing,
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

export interface TypecheckRegistryOptions extends Partial<TypecheckConfig> {
  readonly maxServices?: number;
  readonly logger?: Logger;
}

export interface TypecheckRequest {
  /** The tree to check. A service is kept for it until it is released. */
  readonly root: string;
  /** The checkout whose installed `node_modules` the tree borrows. */
  readonly dependencyRoot: string;
  /**
   * What the tree at `root` holds, from {@link listTree} of the tree written
   * there: the compiler sees these files and no others.
   */
  readonly tree: TreeListing;
  /** The tsconfig to start from, relative to `root`; `tsconfig.json` unless given. */
  readonly project?: string;
  /** Aborted to stop a check where it stands; the service survives it. */
  readonly signal?: AbortSignal;
  /**
   * Called once the worker has the check, after any wait for the service:
   * the line between queueing and compiling, for whoever is timing either.
   */
  readonly onStarted?: () => void;
}

/** Why a check could not be run at all, which says nothing about the tree. */
export type TypecheckInfraReason =
  /** The worker did not start, or ended before it took the check. */
  | 'no-worker'
  /** The tree's service was released while the check waited on it or ran. */
  | 'released'
  /** The registry was closed: the daemon is stopping. */
  | 'closed'
  /** The dependency checkout's install changed while the check ran. */
  | 'install-changed';

/**
 * How a check ended. Only `checked` carries diagnostics, and none of the
 * others is ever a Finding: each says the tree could not be judged, and why,
 * so that whoever reports it can say what would fix it.
 */
export type TypecheckOutcome =
  | {
      readonly kind: 'checked';
      readonly report: TypecheckReport;
      readonly durationMs: number;
      /** The service had checked this tree before: its incremental state was reused. */
      readonly warm: boolean;
      /** The worker's heap after the check: what keeping this service costs. */
      readonly heapBytes: number;
      /** Source files the check type-checked rather than answered from what was kept. */
      readonly filesChecked: number;
      /** Projects whose program the check built anew: none when nothing it reads changed. */
      readonly programsBuilt: number;
    }
  /** Superseded: stopped where it stood. The service is kept unless it had to be terminated. */
  | { readonly kind: 'cancelled' }
  /**
   * Still running at its deadline. Stopped within the grace, the service is
   * kept warm; past it, the worker was terminated.
   */
  | { readonly kind: 'timeout'; readonly deadlineMs: number }
  /** The program outgrew the heap limit. The worker is gone; the next check starts a new one. */
  | { readonly kind: 'out-of-memory'; readonly maxHeapMb: number }
  /**
   * The compiler threw — a `Debug Failure`, a stack overflow on input nested
   * deep enough — or its worker ended mid-check. A limit met on the tree's
   * input, which recurs for as long as the tree holds it, and never a
   * conflict. The worker is gone.
   */
  | { readonly kind: 'crashed'; readonly message: string }
  | {
      readonly kind: 'infra-failure';
      readonly reason: TypecheckInfraReason;
      readonly message: string;
    };

export interface TypecheckRegistry {
  /**
   * Check a tree with its service, starting one if it has none.
   *
   * Checks of one tree run one at a time, in the order asked. With every
   * service busy, a check of a new tree waits for one to finish rather than
   * start another. Resolves to an outcome for anything the worker does; it
   * does not reject.
   */
  check(request: TypecheckRequest): Promise<TypecheckOutcome>;
  /** Stop a tree's service, if it has one: its tree is going away. */
  release(root: string): Promise<void>;
  /** Stop every service. Checks asked for afterwards are refused. */
  close(): Promise<void>;
  /** Services alive now. */
  readonly live: number;
}

/** What ended a service, for its check in flight and the checks queued on it. */
interface Ended {
  readonly outcome: TypecheckOutcome;
  /**
   * Stopped for running too long, not broken: a check queued behind it starts
   * a new service rather than share the outcome, since it is usually the
   * newer run's.
   */
  readonly afresh: boolean;
}

type Settlement =
  | { readonly kind: 'result'; readonly response: Extract<WorkerResponse, { type: 'result' }> }
  | { readonly kind: 'ended'; readonly ended: Ended };

interface Pending {
  readonly started: () => void;
  readonly settle: (settlement: Settlement) => void;
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
  /** The worker has taken a check: a death from here on is the compiler's, not the start's. */
  alive: boolean;
  /** Why the service was taken out, for checks still queued on it. */
  ended: Ended | null;
}

/** The worker beside this module: `src` under test, `dist` once built. */
const WORKER_URL = siblingModule(import.meta.url, 'typecheck-worker');

/** Longest worker error kept in an outcome: enough to name the failure, not to carry a stack. */
const MAX_FAILURE_MESSAGE = 500;

export function createTypecheckRegistry(options: TypecheckRegistryOptions = {}): TypecheckRegistry {
  const maxServices = options.maxServices ?? DEFAULT_LIVE_SERVICES;
  const { maxHeapMb, deadlineMs, graceMs } = { ...DEFAULT_CONFIG.typecheck, ...options };
  const log = (options.logger ?? silentLogger).child('typecheck');
  if (!Number.isInteger(maxServices) || maxServices < 1) {
    throw new InterlockError('CONFIG_INVALID', 'The type checker needs at least one service', {
      details: { maxServices },
      remedy: 'Set the number of live services to a whole number of 1 or more.',
    });
  }
  // Checked here as well as when the config is read: V8 aborts the whole
  // process, not the worker, when a worker's heap is too small to start in.
  if (!Number.isInteger(maxHeapMb) || maxHeapMb < TYPECHECK_MIN_HEAP_MB) {
    throw new InterlockError('CONFIG_INVALID', 'The type checker’s heap limit is too small', {
      details: { maxHeapMb, minimum: TYPECHECK_MIN_HEAP_MB },
      remedy: `Set typecheck.maxHeapMb to a whole number of ${String(TYPECHECK_MIN_HEAP_MB)} or more.`,
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

  const infra = (reason: TypecheckInfraReason, message: string): Ended => ({
    outcome: { kind: 'infra-failure', reason, message },
    afresh: false,
  });

  /** Take a service out of the registry and settle whatever was waiting on it. */
  const drop = (service: Service, ended: Ended): void => {
    if (services.get(service.root) === service) services.delete(service.root);
    service.ended ??= ended;
    for (const pending of service.pending.values()) {
      pending.settle({ kind: 'ended', ended: service.ended });
    }
    service.pending.clear();
    wakeWaiters();
  };

  const halt = async (service: Service, ended: Ended, why: string): Promise<void> => {
    drop(service, ended);
    await service.worker.terminate();
    log.debug('type-check service stopped', { checks: service.checks, why });
  };

  /** What a worker's error means for the check it was running. */
  const failureOf = (service: Service, error: Error): Ended => {
    if ((error as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY') {
      return { outcome: { kind: 'out-of-memory', maxHeapMb }, afresh: false };
    }
    const message = redact(error.message).slice(0, MAX_FAILURE_MESSAGE);
    return service.alive
      ? { outcome: { kind: 'crashed', message }, afresh: false }
      : infra('no-worker', `The type-check worker did not start: ${message}`);
  };

  const spawn = (request: TypecheckRequest): Service => {
    const init: WorkerInit = {
      root: request.root,
      dependencyRoot: request.dependencyRoot,
      project: request.project ?? DEFAULT_PROJECT,
    };
    const worker = new Worker(WORKER_URL, {
      workerData: init,
      // No variables: the daemon's environment does not change how the
      // compiler behaves (it reads `NODE_ENV` as it loads), and nothing the
      // daemon was started with is in the thread that reads merged code.
      env: {},
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
      alive: false,
      ended: null,
    };
    // A check is pending until its result: a message for one that is not
    // was settled already, by a release or the worker's end.
    worker.on('message', (response: WorkerResponse) => {
      const pending = service.pending.get(response.id);
      if (response.type === 'started') {
        service.alive = true;
        pending?.started();
        return;
      }
      service.pending.delete(response.id);
      pending?.settle({ kind: 'result', response });
    });
    worker.on('error', (error: Error) => {
      log.warn('type-check worker failed', { reason: redact(error.message) });
      drop(service, failureOf(service, error));
    });
    worker.on('exit', (exitCode) => {
      const message = `The type-check worker exited with code ${String(exitCode)}`;
      drop(
        service,
        service.alive
          ? { outcome: { kind: 'crashed', message }, afresh: false }
          : infra('no-worker', message),
      );
    });
    log.debug('type-check service started', { live: services.size + 1 });
    return service;
  };

  /**
   * The tree's service, making room for it if it has none; null once closed.
   *
   * Claimed with no await between the lookup and the claim, so two checks
   * cannot both start a service for one tree, or both take the last place.
   */
  const claim = async (request: TypecheckRequest): Promise<Service | null> => {
    for (;;) {
      if (closed) return null;
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
        await halt(
          existing,
          infra('released', 'The service was replaced'),
          'its tree is checked against other dependencies or another project',
        );
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
        void halt(victim, infra('released', 'The service was stopped to make room'), 'room');
        continue;
      }
      const service = spawn(request);
      service.holders += 1;
      services.set(service.root, service);
      return service;
    }
  };

  /** The outcome of a check of a service no longer in the registry, or `afresh` to start a new one. */
  const endedOutcome = (service: Service): TypecheckOutcome | 'afresh' => {
    // A service is out of the registry only once something ended it.
    const ended = service.ended!;
    return ended.afresh ? 'afresh' : ended.outcome;
  };

  const send = async (
    service: Service,
    request: TypecheckRequest,
  ): Promise<TypecheckOutcome | 'afresh'> => {
    const { signal } = request;
    // Read before the check is sent, and asked after: the run may be
    // superseded, or the service ended, while it waited here or in the queue.
    const roots = installRoots(request.tree);
    const identify = (): Promise<string | null> => installIdentity(service.dependencyRoot, roots);
    const install = await identify();
    if (services.get(service.root) !== service) return endedOutcome(service);
    if (signal?.aborted === true) return { kind: 'cancelled' };

    const id = (nextId += 1);
    const cancel = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const flag = new Int32Array(cancel);
    const warm = service.checks > 0;
    let stoppedFor: 'superseded' | 'deadline' | null = null;
    const stopped = (): TypecheckOutcome =>
      stoppedFor === 'deadline' ? { kind: 'timeout', deadlineMs } : { kind: 'cancelled' };
    let deadline: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    /**
     * Ask the compiler to stop, keeping its program and every file the builder
     * finished, and terminate the worker only if it is still running once the
     * grace is up: the compiler does not poll while it builds a program, and a
     * worker that never stops holds its tree's queue for good.
     */
    const stop = (why: 'superseded' | 'deadline'): void => {
      if (stoppedFor !== null) return;
      stoppedFor = why;
      Atomics.store(flag, 0, 1);
      log.debug('type-check stopping', { why, graceMs });
      const terminate = (): void => {
        void halt(service, { outcome: stopped(), afresh: true }, 'still running past its grace');
      };
      if (graceMs === 0) terminate();
      else grace = setTimeout(terminate, graceMs);
    };
    const onAbort = (): void => {
      stop('superseded');
    };
    const message: WorkerRequest = { type: 'check', id, tree: request.tree, install, cancel };
    service.worker.ref();
    let settlement: Settlement;
    try {
      settlement = await new Promise<Settlement>((resolve) => {
        service.pending.set(id, { started: () => request.onStarted?.(), settle: resolve });
        signal?.addEventListener('abort', onAbort, { once: true });
        // From the moment it is sent, so a worker that never starts is stopped too.
        deadline = setTimeout(() => {
          stop('deadline');
        }, deadlineMs);
        service.worker.postMessage(message);
      });
    } finally {
      clearTimeout(deadline);
      clearTimeout(grace);
      signal?.removeEventListener('abort', onAbort);
      service.worker.unref();
    }
    if (settlement.kind === 'ended') return settlement.ended.outcome;

    const { response } = settlement;
    service.checks += 1;
    if (response.heapBytes > maxHeapMb * 2 ** 20) {
      // A process-wide `--max-old-space-size`, in `NODE_OPTIONS` say,
      // overrides the worker's own limit, so the bound is enforced here too.
      // The answer stands; the service is not kept to give the next one.
      log.warn('type-check service over its heap bound, stopped', {
        heapBytes: response.heapBytes,
        maxHeapMb,
      });
      void halt(
        service,
        { outcome: { kind: 'out-of-memory', maxHeapMb }, afresh: false },
        'its heap grew past the bound',
      );
    }
    if (response.result.kind === 'cancelled') return stopped();
    // Files under `node_modules` are versioned by the install, so an install
    // that changed under the check may have answered some files from each.
    if ((await identify()) !== install) {
      return infra('install-changed', 'The dependency checkout was reinstalled during the check')
        .outcome;
    }
    return {
      kind: 'checked',
      report: response.result.report,
      durationMs: response.durationMs,
      warm,
      heapBytes: response.heapBytes,
      filesChecked: response.result.filesChecked,
      programsBuilt: response.result.programsBuilt,
    };
  };

  return {
    async check(request: TypecheckRequest): Promise<TypecheckOutcome> {
      if (request.signal?.aborted === true) return { kind: 'cancelled' };
      for (;;) {
        const service = await claim(request);
        if (service === null) return infra('closed', 'The type checker has been closed').outcome;
        let outcome: TypecheckOutcome | 'afresh';
        try {
          const run = service.queue.then(() => send(service, request));
          service.queue = run.catch(() => undefined);
          outcome = await run;
        } finally {
          service.holders -= 1;
          service.lastUsedAt = Date.now();
          wakeWaiters();
        }
        if (outcome === 'afresh') continue;
        if (outcome.kind !== 'checked' && outcome.kind !== 'cancelled') {
          log.warn('type-check did not complete', {
            kind: outcome.kind,
            ...(outcome.kind === 'infra-failure' ? { reason: outcome.reason } : {}),
          });
        }
        return outcome;
      }
    },

    async release(root: string): Promise<void> {
      const service = services.get(root);
      if (service !== undefined) {
        await halt(service, infra('released', 'The tree was released'), 'its tree was released');
      }
    },

    async close(): Promise<void> {
      closed = true;
      wakeWaiters();
      await Promise.all(
        [...services.values()].map((service) =>
          halt(service, infra('closed', 'The type checker has been closed'), 'closed'),
        ),
      );
    },

    get live(): number {
      return services.size;
    },
  };
}

/** One `ls-tree -z` record: mode, type, object id, path. */
const LISTED = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/su;

/**
 * A tree's files, by listing it: what a type check of it may see.
 *
 * A submodule's commit is no file of the tree, and is left out. Run against
 * any repository holding the tree — a pool slot's handle, or the shadow.
 *
 * @throws InterlockError `GIT_COMMAND_FAILED` when the tree cannot be listed.
 */
export async function listTree(
  runner: GitRunner,
  repo: AnyRepo,
  treeOid: string,
): Promise<TreeListing> {
  assertObjectId(treeOid, 'treeOid');
  const listed = await runRequired(runner, repo, ['ls-tree', '-r', '-z', '--full-tree', treeOid]);
  const entries: TreeEntry[] = [];
  for (const record of listed.stdout.split('\0')) {
    const match = LISTED.exec(record);
    if (match?.[2] !== 'blob') continue;
    entries.push({ path: match[4]!, oid: match[3]!, symlink: match[1] === '120000' });
  }
  return { oid: treeOid, entries };
}

/** Lockfiles, each beside the directory its package manager installs into. */
const LOCKFILES: ReadonlySet<string> = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);

/**
 * Install roots read for one check. Past it — a tree full of fixtures, each
 * with a lockfile — every file is versioned by the disk instead.
 */
const MAX_INSTALL_ROOTS = 32;

/**
 * Where a tree's packages are installed, relative to its root: the root, and
 * the directory of each lockfile the tree holds. A workspace installed below
 * the repository's root keeps its records there, not at the root.
 *
 * Null when there are more than {@link MAX_INSTALL_ROOTS}.
 */
export function installRoots(tree: TreeListing): readonly string[] | null {
  const roots = new Set<string>(['']);
  for (const { path } of tree.entries) {
    const parts = path.split('/');
    if (!LOCKFILES.has(parts.at(-1)!) || parts.includes('node_modules')) continue;
    roots.add(parts.slice(0, -1).join('/'));
    if (roots.size > MAX_INSTALL_ROOTS) return null;
  }
  return [...roots].sort();
}

/**
 * Package managers' records of their last install, under an install root:
 * each is rewritten by an install, and by nothing else that a dependency's
 * declarations depend on.
 */
const INSTALL_RECORDS: readonly string[] = [
  'node_modules/.modules.yaml',
  'node_modules/.pnpm/lock.yaml',
  'node_modules/.package-lock.json',
  'node_modules/.yarn-state.yml',
  'node_modules/.yarn-integrity',
];

/** Larger than any real lockfile; a record past it is not read whole into memory. */
const MAX_RECORD_BYTES = 64 * 2 ** 20;

/**
 * A record is opened without following a final symlink or blocking on a
 * FIFO: it sits in a directory the agents' installs write, and is data.
 */
const RECORD_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Names the dependency checkout's installs by the content of their package
 * managers' records, so that its files keep one version while they last
 * rather than each being read from the disk on every check.
 *
 * Read under each of `roots`, relative to the checkout; a root that leads out
 * of the checkout is not one of its installs, and is not read. Null when there
 * is no record to read — a package manager that keeps none, or roots too many
 * to read ({@link installRoots}) — and then every file is versioned by the
 * disk. An install's records do not change when something writes into
 * `node_modules` without installing, such as a client generated there; that is
 * seen only once an install changes or the service starts again.
 */
export async function installIdentity(
  dependencyRoot: string,
  roots: readonly string[] | null = [''],
): Promise<string | null> {
  if (roots === null) return null;
  const checkout = await realpathOf(dependencyRoot);
  if (checkout === null) return null;
  const hash = createHash('sha256');
  let found = 0;
  for (const root of roots) {
    const directory = await realpathOf(join(checkout, root));
    if (directory === null || !inside(checkout, directory)) continue;
    for (const record of INSTALL_RECORDS) {
      const content = await readRecord(join(directory, record));
      if (content === null) continue;
      hash.update(root).update('\0').update(record).update('\0').update(content).update('\0');
      found += 1;
    }
  }
  return found === 0 ? null : hash.digest('hex');
}

async function realpathOf(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** On whole segments, as the confinement judges a path: `..b` is a name, not a way out. */
function inside(root: string, path: string): boolean {
  const between = relative(root, path);
  return (
    between === '' || (between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between))
  );
}

/** A regular file's bytes, or null for one that is missing, not regular, a link or too large. */
async function readRecord(path: string): Promise<Buffer | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, RECORD_FLAGS);
    const stat = await handle.stat();
    return stat.isFile() && stat.size <= MAX_RECORD_BYTES ? await handle.readFile() : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
