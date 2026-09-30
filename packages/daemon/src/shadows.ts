import { collectShadow, ensureShadow, isObjectId, openUserRepo, pinKeep } from '@interlock/core';
import type { GitRunner, ShadowRepo, ShadowStoreSize, UserRepo } from '@interlock/core';
import type { Logger, Repo, RepoId } from '@interlock/shared';
import type { Store } from './store/index.js';

/**
 * One shadow handle per repository, shared by everything that writes objects.
 *
 * `ensureShadow` refreshes the clone's refs on every call — a fetch — and
 * nothing here needs those refs: the shadow borrows the user's object store
 * through alternates, so a commit the user made a second ago is already
 * readable by id. What the daemon needs is the handle, once, so it is resolved
 * once per repository and reused.
 *
 * The watcher's captures and the run pipeline's commits both land in this
 * shadow. A tree captured into the user's own store would be unreferenced there,
 * and their `gc` could reap it from under a commit made here.
 */
export interface ShadowRegistry {
  get(handle: UserRepo, repoId: RepoId): Promise<ShadowRepo>;
  /**
   * Run `work` against the shadow while nothing collects it.
   *
   * Shared: any number of captures and runs hold it at once. What it excludes
   * is {@link ShadowRegistry.collect}, which decides an object is unreachable
   * and old and then deletes it — and a capture between the two that writes
   * the same object finds it present, writes nothing, and names an object that
   * is about to go.
   */
  use<T>(handle: UserRepo, repoId: RepoId, work: (shadow: ShadowRepo) => Promise<T>): Promise<T>;
  /**
   * Refresh the shadow, pin what it must keep, and collect it.
   *
   * Everything up to the collection proper runs beside the checks writing to
   * the shadow: the refresh and the keep refs move refs and delete nothing, and
   * anything a check writes meanwhile is younger than any expiry. Only
   * `repack` and `prune` hold the shadow alone. For that part the collection
   * waits for everything holding the shadow to finish, and holds off anything
   * that asks after it: a steady stream of runs would otherwise keep it
   * waiting forever. One collection per repository at a time.
   */
  collect(
    handle: UserRepo,
    repoId: RepoId,
    options: {
      readonly expireBefore: Date;
      readonly keep: () => Promise<readonly string[]>;
      /**
       * Settles when now is a good time to hold the shadow alone: checks go
       * on meanwhile, and the collection waits for them rather than they for
       * it. Its caller bounds it; left out, the shadow is taken at once.
       */
      readonly quiet?: () => Promise<void>;
      /** Stops the collection, and git with it; the gate is released either way. */
      readonly signal?: AbortSignal;
    },
  ): Promise<ShadowCollection>;
  /**
   * Drop a handle that failed, so the next caller resolves it afresh.
   *
   * `ensureShadow` rebuilds a clone that is missing or no longer borrows the
   * right store, which is the whole repair; a cached handle would keep
   * pointing every caller at the broken one.
   */
  forget(repoId: RepoId): void;
}

/** What one collection kept, what it left, and what it cost the checks. */
export interface ShadowCollection {
  readonly kept: number;
  /** Candidates whose history the user's `gc` removed, left out of the keep refs. */
  readonly unkeepable: readonly string[];
  readonly before: ShadowStoreSize;
  readonly after: ShadowStoreSize;
  /** How long the collection waited for a quiet moment, checks running meanwhile. */
  readonly quietMs: number;
  /**
   * How long checks and captures of the repository were held off: from the
   * collection asking for the shadow alone, through waiting for those holding
   * it, to the end of `repack` and `prune`. The delay an edit can meet.
   */
  readonly pausedMs: number;
  readonly durationMs: number;
}

export interface ShadowRegistryOptions {
  readonly runner: GitRunner;
  readonly dataDir: string;
}

/**
 * Many holders or one collector, per repository, with the collector first in
 * line once it asks.
 */
interface Gate {
  holders: number;
  /** Settles when the collection before this one is done, pinning included. */
  serial: Promise<void>;
  /** Settles when the collection holding or awaiting the gate is done. */
  collecting: Promise<void> | null;
  /** Wakes a waiting collection when the last holder leaves. */
  drained: (() => void) | null;
}

/**
 * Run `work` with the shadow to itself: new holders wait from the moment this
 * asks, and `work` starts once the holders already in have left.
 */
async function alone<T>(gate: Gate, work: () => Promise<T>): Promise<T> {
  while (gate.collecting !== null) await gate.collecting;
  let release!: () => void;
  gate.collecting = new Promise((resolve) => {
    release = resolve;
  });
  try {
    if (gate.holders > 0) {
      await new Promise<void>((resolve) => {
        gate.drained = resolve;
      });
      gate.drained = null;
    }
    return await work();
  } finally {
    gate.collecting = null;
    release();
  }
}

export function createShadowRegistry(options: ShadowRegistryOptions): ShadowRegistry {
  const handles = new Map<RepoId, Promise<ShadowRepo>>();
  const gates = new Map<RepoId, Gate>();

  const gateOf = (repoId: RepoId): Gate => {
    let gate = gates.get(repoId);
    if (gate === undefined) {
      gate = { holders: 0, serial: Promise.resolve(), collecting: null, drained: null };
      gates.set(repoId, gate);
    }
    return gate;
  };

  const get = (handle: UserRepo, repoId: RepoId): Promise<ShadowRepo> => {
    const known = handles.get(repoId);
    if (known !== undefined) return known;
    const resolving = ensureShadow(handle, { ...options, repoId });
    handles.set(repoId, resolving);
    // A failure is not remembered: the next caller tries again rather than
    // inheriting a rejection for as long as the daemon runs.
    resolving.catch(() => {
      if (handles.get(repoId) === resolving) handles.delete(repoId);
    });
    return resolving;
  };

  return {
    get,

    async use<T>(
      handle: UserRepo,
      repoId: RepoId,
      work: (shadow: ShadowRepo) => Promise<T>,
    ): Promise<T> {
      const gate = gateOf(repoId);
      // A loop, not one wait: a second collection can take the gate between
      // the first settling and this continuing.
      while (gate.collecting !== null) await gate.collecting;
      gate.holders += 1;
      try {
        return await work(await get(handle, repoId));
      } finally {
        gate.holders -= 1;
        if (gate.holders === 0 && gate.drained !== null) gate.drained();
      }
    },

    async collect(
      handle,
      repoId,
      { expireBefore, keep, quiet, signal },
    ): Promise<ShadowCollection> {
      const gate = gateOf(repoId);
      const previous = gate.serial;
      let finished!: () => void;
      gate.serial = new Promise((resolve) => {
        finished = resolve;
      });
      await previous;
      try {
        const startedAt = Date.now();
        // Refreshed, not the cached handle: the fetch prunes a ref naming a
        // branch the user deleted, whose commit their `gc` may since have
        // removed — and one such ref stops the collection walking at all. A
        // clone rebuilt by this call is the handle from now on.
        const refreshing = ensureShadow(handle, { ...options, repoId });
        handles.set(repoId, refreshing);
        refreshing.catch(() => {
          if (handles.get(repoId) === refreshing) handles.delete(repoId);
        });
        const shadow = await refreshing;
        const pinned = await pinKeep(shadow, {
          runner: options.runner,
          keep: await keep(),
          ...(signal === undefined ? {} : { signal }),
        });

        const quietFrom = Date.now();
        if (quiet !== undefined) await quiet();
        signal?.throwIfAborted();
        const pausedFrom = Date.now();
        const collected = await alone(gate, () =>
          collectShadow(shadow, {
            runner: options.runner,
            expireBefore,
            ...(signal === undefined ? {} : { signal }),
          }),
        );
        return {
          kept: pinned.kept.length,
          unkeepable: pinned.unkeepable,
          before: collected.before,
          after: collected.after,
          quietMs: pausedFrom - quietFrom,
          pausedMs: Date.now() - pausedFrom,
          durationMs: Date.now() - startedAt,
        };
      } finally {
        finished();
      }
    },

    forget(repoId: RepoId): void {
      handles.delete(repoId);
    },
  };
}

/**
 * Collect every repository's shadow, each backing off on its own after a
 * failure.
 *
 * A failure is infrastructure — a repository moved, a disk full, a race with
 * the user's own `gc` — and never a run's: runs go on writing to the shadow
 * uncollected, which costs disk and nothing else, until a pass succeeds.
 */
export interface ShadowCollector {
  /**
   * Collect with the retention pass's cutoff: whatever the store no longer
   * holds a verdict for, collection no longer has to keep.
   */
  pass(before: string, signal?: AbortSignal): Promise<void>;
}

export interface ShadowCollectorOptions {
  readonly shadows: ShadowRegistry;
  readonly store: Store;
  readonly runner: GitRunner;
  /** A repository's trees a queued check would merge. */
  readonly heldTrees: (repoId: RepoId) => readonly string[];
  /**
   * How far below the cutoff the expiry sits: how much older than its verdict
   * a commit the verdict names can be.
   */
  readonly marginMs: number;
  /**
   * Settles when no check is queued or running — the scheduler's `idle`. A
   * collection holds the repository's checks off while it repacks, so it
   * starts in a lull where there is one, and edits in a burst are not the ones
   * kept waiting. Waited for {@link COLLECTION_QUIET_WAIT_MS} at most.
   */
  readonly quiet?: () => Promise<void>;
  /** {@link COLLECTION_QUIET_WAIT_MS} unless given, so a test need not wait it out. */
  readonly quietWaitMs?: number;
  readonly logger: Logger;
  readonly now?: () => number;
}

/**
 * The longest a collection waits for a lull before holding the checks off
 * anyway: under edits that never pause, waiting longer only lets the shadow
 * grow, and the checks wait the same once it starts.
 */
export const COLLECTION_QUIET_WAIT_MS = 5 * 60_000;

/** The wait after a first failure, doubling with each one after it. */
export const COLLECTION_BACKOFF_MS = 60 * 60_000;
/** The longest wait: a repository that recovers is collected again within a day. */
export const COLLECTION_BACKOFF_MAX_MS = 24 * 60 * 60_000;

/** `quiet`, or the wait's end, or the signal: whichever comes first. */
function lull(
  quiet: () => Promise<void>,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, waitMs);
    signal?.addEventListener('abort', done, { once: true });
    quiet().then(done, done);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}

export function createShadowCollector(options: ShadowCollectorOptions): ShadowCollector {
  const { shadows, store, runner, heldTrees, marginMs, quiet } = options;
  const quietWaitMs = options.quietWaitMs ?? COLLECTION_QUIET_WAIT_MS;
  const log = options.logger.child('shadow-collection');
  const now = options.now ?? Date.now;
  const failing = new Map<RepoId, { failures: number; retryAt: number }>();

  /**
   * What age cannot vouch for: the commits a live Finding's evidence names,
   * which retention keeps however old, and the trees a queued check will merge.
   */
  const keepFor = async (repoId: RepoId): Promise<readonly string[]> => {
    const candidates = [...heldTrees(repoId)];
    for (const finding of await store.listLiveFindings(repoId)) {
      for (const evidence of finding.evidence) {
        if (evidence.type === 'merge-conflict') candidates.push(evidence.commitA, evidence.commitB);
      }
    }
    // Read back from storage and events: one malformed id would refuse the
    // whole collection, every pass, for as long as whatever names it lasts.
    return [...new Set(candidates.filter(isObjectId))];
  };

  const collect = async (
    repo: Repo,
    expireBefore: Date,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    const backoff = failing.get(repo.id);
    if (backoff !== undefined && now() < backoff.retryAt) {
      log.debug('backing off collecting a shadow', {
        repoId: repo.id,
        retryAt: new Date(backoff.retryAt).toISOString(),
      });
      return;
    }
    try {
      const handle = await openUserRepo(repo.rootPath, { runner });
      const report = await shadows.collect(handle, repo.id, {
        expireBefore,
        keep: () => keepFor(repo.id),
        ...(quiet === undefined ? {} : { quiet: () => lull(quiet, quietWaitMs, signal) }),
        ...(signal === undefined ? {} : { signal }),
      });
      failing.delete(repo.id);
      log.info('collected the shadow', {
        repoId: repo.id,
        expireBefore: expireBefore.toISOString(),
        ...report,
      });
      if (report.unkeepable.length > 0) {
        // Evidence naming a commit whose history the user's `gc` removed: the
        // commit cannot be kept whole, and a Finding naming it already could
        // not be shown in full.
        log.warn('could not keep objects a Finding or a queued check names', {
          repoId: repo.id,
          unkeepable: report.unkeepable,
        });
      }
    } catch (error) {
      // Stopped on request is not a failure: nothing about the repository
      // says to wait longer before the next attempt.
      if (signal?.aborted === true) {
        log.info('stopped collecting a shadow', { repoId: repo.id });
        return;
      }
      const failures = (backoff?.failures ?? 0) + 1;
      const waitMs = Math.min(
        COLLECTION_BACKOFF_MS * 2 ** (failures - 1),
        COLLECTION_BACKOFF_MAX_MS,
      );
      failing.set(repo.id, { failures, retryAt: now() + waitMs });
      log.warn('collecting a shadow failed', {
        repoId: repo.id,
        failures,
        retryAt: new Date(now() + waitMs).toISOString(),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    async pass(before: string, signal?: AbortSignal): Promise<void> {
      const expireBefore = new Date(Date.parse(before) - marginMs);
      let repos: Repo[];
      try {
        repos = await store.listRepos();
      } catch (error) {
        log.warn('could not list repositories to collect', {
          reason: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      // One at a time: each walks a whole history, and each holds its
      // repository's runs off while it does.
      for (const repo of repos) {
        if (signal?.aborted === true) return;
        await collect(repo, expireBefore, signal);
      }
    },
  };
}
