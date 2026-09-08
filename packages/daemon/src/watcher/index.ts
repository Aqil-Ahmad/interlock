import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { GitRunner } from '@interlock/core';
import type { InterlockConfig, Logger } from '@interlock/shared';
import type { EventBus } from '../bus/index.js';
import type { Store } from '../store/index.js';
import { createSweep } from './sweep.js';
import { createWorktreeWatcher } from './worktree-watcher.js';
import type { ChangeSignal, WatchFactory, WatchTarget } from './worktree-watcher.js';

/**
 * Discovers repos, branches, worktrees and agent sessions, and publishes what
 * changed. Read-only with respect to user state.
 *
 * Three signals are combined:
 *  1. filesystem events on worktrees, debounced, ignoring `node_modules` and build output;
 *  2. git ref changes (`.git/refs`, packed-refs, `HEAD`);
 *  3. periodic reconciliation, because filesystem events are lossy on macOS.
 *
 * The first two say *which* worktree to look at and the third is the backstop
 * for what the platform dropped, so they are not three ways of doing the same
 * work: a signal marks a worktree and reconciles one repository, while the timer
 * reconciles every repository and re-targets the watches.
 *
 * Steady-state CPU budget is <2%; it is tracked by `pnpm bench`.
 */

export interface WatcherOptions {
  readonly config: InterlockConfig;
  readonly store: Store;
  readonly bus: EventBus;
  readonly runner: GitRunner;
  readonly logger: Logger;
  /** Overridable so a test does not wait out the cadence. */
  readonly sweepIntervalMs?: number;
  /** The kernel boundary, passed through to the filesystem watcher. */
  readonly watchFactory?: WatchFactory;
}

export interface Watcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Force a full reconciliation pass; used at startup and by `interlock status`. */
  refresh(): Promise<void>;
}

/**
 * How often the timer reconciles every repository.
 *
 * A pass over three worktrees of ten thousand files measures 375–505ms, so this
 * is 1.3–1.7% of one core and well under a fifth of a percent of the machine —
 * under the 2% budget on either reading of it. Nothing is traded away for the
 * interval: real edits arrive as filesystem signals and land at the debounce
 * ceiling about two seconds later, and this only backstops what the platform
 * failed to report.
 */
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

/**
 * How long `stop` waits for work already in flight.
 *
 * A `git status` on an unreachable mount runs to the runner's own timeout, and
 * a daemon that will not exit is worse than one that exits with a pass
 * unfinished — the next start reconciles from git anyway.
 */
const DRAIN_TIMEOUT_MS = 5_000;

export function createWatcher(options: WatcherOptions): Watcher {
  const log = options.logger.child('watcher');
  const { config, store, bus, runner } = options;
  const intervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;

  const sweep = createSweep({
    store,
    bus,
    runner,
    dataDir: config.dataDir,
    logger: options.logger,
  });

  /**
   * Which repository each watched worktree belongs to.
   *
   * A signal names a worktree — the watcher deliberately resolves no identity —
   * and reconciliation is per repository, so this is the only lookup between
   * them. Rebuilt from the store on every full pass.
   */
  const repoByWorktree = new Map<string, string>();
  /** Work started by a signal, so `stop` can wait for it rather than abandon it. */
  const inFlight = new Set<Promise<void>>();
  /**
   * The target each worktree is currently watched under.
   *
   * `watch` is a no-op for a worktree already watched, which is what keeps a
   * recursive watch from being rebuilt every pass — but it also means a target
   * whose `ignore` list changed would keep the old one. A repository editing
   * `.interlock.json` mid-session is the case the sweep already honours for
   * `ignoreBranches`, and the two must not disagree.
   */
  const applied = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopping = false;

  const track = (work: Promise<void>): void => {
    const settled: Promise<void> = work
      .catch((error: unknown) => {
        log.warn('reconciliation failed', {
          reason: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        inFlight.delete(settled);
      });
    inFlight.add(settled);
  };

  const onSignal = (signal: ChangeSignal): void => {
    // The mark is what makes the hash worth doing on the next pass; a pass with
    // nothing marked reconciles refs and leaves every worktree alone.
    sweep.markChanged(signal.worktreePath);
    const rootPath = repoByWorktree.get(signal.worktreePath);
    if (rootPath === undefined) {
      // The worktree is watched, so it was in the store when the watches were
      // built; it is gone from it now. The next full pass drops the watch.
      log.debug('a signal named a worktree with no repository', {
        worktreePath: signal.worktreePath,
      });
      return;
    }
    track(sweep.reconcile(rootPath));
  };

  const watcher = createWorktreeWatcher({
    onSignal,
    logger: options.logger,
    ...(options.watchFactory === undefined ? {} : { watchFactory: options.watchFactory }),
  });

  /**
   * Point the filesystem watcher at the worktrees that exist now.
   *
   * Branches move between worktrees and worktrees are added and removed, so the
   * watch set is derived from the store after every full pass rather than fixed
   * at startup. Watching a target that is already watched is a no-op there, so
   * a recursive watch over a whole repository is never dropped and rebuilt.
   */
  const retarget = async (): Promise<void> => {
    const wanted = new Map<string, WatchTarget>();
    const owners = new Map<string, string>();

    for (const repo of await store.listRepos()) {
      const commonDir = gitDirOf(repo.rootPath);
      for (const branch of await store.listBranchRefs(repo.id)) {
        const worktreePath = branch.worktreePath;
        if (worktreePath === null || wanted.has(worktreePath)) continue;
        owners.set(worktreePath, repo.rootPath);

        const gitDir = gitDirOf(worktreePath) ?? commonDir;
        if (gitDir === null) {
          log.warn('a worktree has no readable git directory; ref changes go unwatched', {
            worktreePath,
          });
          continue;
        }
        wanted.set(worktreePath, {
          worktreePath,
          gitDir,
          // A linked worktree keeps its own `HEAD` but shares `refs/` with the
          // main checkout, so without this a branch moving is invisible.
          ...(commonDir === null || commonDir === gitDir ? {} : { commonDir }),
          ...(repo.config.ignore === undefined ? {} : { ignore: repo.config.ignore }),
        });
      }
    }

    // Reading the store took several awaits, and `stop` may have run in one of
    // them. Re-arming here would open watches after `close` tore them down, and
    // nothing would ever close them.
    if (stopping) return;

    repoByWorktree.clear();
    for (const [path, rootPath] of owners) repoByWorktree.set(path, rootPath);

    for (const watched of watcher.watching) {
      const wantedHere = wanted.get(watched);
      if (wantedHere !== undefined && applied.get(watched) === describe(wantedHere)) continue;
      watcher.unwatch(watched);
      applied.delete(watched);
    }
    for (const [path, target] of wanted) {
      watcher.watch(target);
      applied.set(path, describe(target));
    }
  };

  const refresh = async (): Promise<void> => {
    const outcome = await sweep.all(config.repos);
    if (outcome.failed.length > 0) {
      log.warn('some repositories could not be reconciled', { failed: outcome.failed.length });
    }
    await retarget();
  };

  return {
    async start(): Promise<void> {
      stopping = false;
      await refresh();
      // Cancelled by `stop` rather than guarded here: a flag the callback reads
      // would keep the interval alive and the process with it.
      timer = setInterval(() => {
        track(refresh());
      }, intervalMs);
    },

    async stop(): Promise<void> {
      stopping = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      // Closed before the drain: it cancels pending debounce batches, so no
      // signal can start a pass the drain would then have to wait for.
      watcher.close();
      repoByWorktree.clear();
      applied.clear();

      if (inFlight.size === 0) return;
      const drained = await Promise.race([
        Promise.all([...inFlight]).then(() => true),
        delay(DRAIN_TIMEOUT_MS).then(() => false),
      ]);
      if (!drained) {
        log.warn('gave up waiting for reconciliation to finish', { pending: inFlight.size });
      }
    },

    refresh,
  };
}

/** Identity of a target, so a changed one is re-watched and an equal one is not. */
function describe(target: WatchTarget): string {
  return JSON.stringify([target.gitDir, target.commonDir ?? null, target.ignore ?? []]);
}

/** A timer that never keeps the process alive on its own. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve_) => {
    setTimeout(resolve_, ms).unref();
  });
}

/**
 * The git directory a worktree's `HEAD` lives in, or `null`.
 *
 * A linked worktree's `.git` is a file naming that directory rather than being
 * one — git calls it a gitfile, and its path may be relative to the worktree.
 * Reading it here rather than asking git keeps a per-worktree subprocess off a
 * path that runs on every full pass.
 */
function gitDirOf(worktreePath: string): string | null {
  const marker = join(worktreePath, '.git');
  let isFile: boolean;
  try {
    isFile = statSync(marker).isFile();
  } catch {
    return null;
  }
  if (!isFile) return marker;

  const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, 'utf8'));
  if (pointer === null) return null;
  const target = pointer[1]!.trim();
  return isAbsolute(target) ? target : resolve(worktreePath, target);
}

export { createWorktreeWatcher } from './worktree-watcher.js';
export type {
  ChangeSignal,
  SignalKind,
  WatchFactory,
  WatchTarget,
  WorktreeWatcher,
  WorktreeWatcherOptions,
} from './worktree-watcher.js';
export { createSweep } from './sweep.js';
export type { Sweep, SweepOptions, SweepOutcome } from './sweep.js';
export { createDebouncer } from './debounce.js';
export type { DebounceOptions, Debouncer } from './debounce.js';
