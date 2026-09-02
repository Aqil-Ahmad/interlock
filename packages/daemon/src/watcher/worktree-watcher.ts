import { existsSync, readFileSync, realpathSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { InterlockError, pathIgnored, silentLogger } from '@interlock/shared';
import type { Logger } from '@interlock/shared';
import { createDebouncer } from './debounce.js';
import type { Debouncer } from './debounce.js';

/**
 * The filesystem half of the watcher: a source of debounced change signals and
 * nothing else.
 *
 * Deliberately knows no git, no store and no bus. A signal names a path, and a
 * path does not identify a branch — a worktree can be checked out onto another
 * branch between the write and the lookup, so resolving identity here would
 * record it at the one moment it cannot be known. The reconciliation sweep
 * resolves it once, after the debounce, against current state.
 *
 * That split is also what keeps this testable against a temp directory.
 */

export type SignalKind = (typeof SIGNAL_KINDS)[number];

export interface ChangeSignal {
  readonly kind: SignalKind;
  /** Canonical path of the worktree the signal belongs to. */
  readonly worktreePath: string;
  /**
   * What changed: worktree-relative for `worktree`, git-dir-relative for `ref`.
   *
   * Empty when the source could not name it — a degraded watcher polling, or an
   * event the OS delivered without a filename. The consumer must treat that as
   * "something changed, ask git", never as "nothing changed".
   */
  readonly paths: readonly string[];
}

export interface WatchTarget {
  readonly worktreePath: string;
  /** Git directory for this worktree; `HEAD` lives here. */
  readonly gitDir: string;
  /**
   * Shared git directory, when this is a linked worktree.
   *
   * A linked worktree has its own `HEAD` but no `refs/` — those live in the
   * main checkout's git dir, so a branch moving is invisible without this.
   */
  readonly commonDir?: string;
  /** Path globs the repository asked to be left alone. */
  readonly ignore?: readonly string[];
}

/** The kernel boundary, injectable so the degraded path can be exercised. */
export type WatchFactory = (path: string, options: { recursive: boolean }) => FSWatcher;

export interface WorktreeWatcherOptions {
  readonly onSignal: (signal: ChangeSignal) => void;
  readonly watchFactory?: WatchFactory;
  readonly logger?: Logger;
  readonly debounceMs?: number;
  readonly maxDebounceMs?: number;
  /** Interval used only after the OS refuses a watch. */
  readonly pollIntervalMs?: number;
}

export interface WorktreeWatcher {
  watch(target: WatchTarget): void;
  unwatch(worktreePath: string): void;
  close(): void;
  readonly watching: readonly string[];
  /** True when the OS refused a watch and this target fell back to polling. */
  isDegraded(worktreePath: string): boolean;
}

/**
 * Long enough to swallow an editor's save burst, short enough that the sweep
 * still feels immediate. The scheduler debounces again, on its own budget.
 *
 * The floor is the platform's, not a preference: macOS delivers a burst of
 * 20–50 writes over ~55ms with gaps of up to 50ms between events, so anything
 * near that splits one save into several signals.
 */
const DEFAULT_DEBOUNCE_MS = 250;

/** A continuous writer must not postpone a signal indefinitely. */
const DEFAULT_MAX_DEBOUNCE_MS = 2_000;

const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Top-level git-dir entries worth a signal.
 *
 * `refs/` is watched separately and recursively; everything else in a git
 * directory is index churn, object writes and lock files, which say nothing
 * about a branch and arrive constantly.
 */
const REF_FILES: ReadonlySet<string> = new Set(['HEAD', 'packed-refs']);

export const SIGNAL_KINDS = ['worktree', 'ref'] as const;

/**
 * Identity of a debounce batch, encoded into its key.
 *
 * A NUL cannot appear in a path, so the key carries everything the flush needs
 * and nothing has to be retained beside it — a lookup table here would outlive
 * every target it described, two entries per worktree ever watched.
 */
function signalKey(kind: SignalKind, worktreePath: string): string {
  return `${kind}\0${worktreePath}`;
}

function splitSignalKey(key: string): [SignalKind, string] {
  const separator = key.indexOf('\0');
  return [key.slice(0, separator) as SignalKind, key.slice(separator + 1)];
}

interface WatchedTarget {
  readonly target: WatchTarget;
  /** Canonical, so a signal always names the path git would report. */
  readonly worktreePath: string;
  readonly watchers: FSWatcher[];
  poller: ReturnType<typeof setInterval> | null;
  /** Re-read whenever the worktree's `.gitignore` changes. */
  ignore: string[];
}

export function createWorktreeWatcher(options: WorktreeWatcherOptions): WorktreeWatcher {
  const log = (options.logger ?? silentLogger).child('watcher');
  const watchFactory: WatchFactory =
    options.watchFactory ??
    ((path, watchOptions) => watch(path, { recursive: watchOptions.recursive, persistent: true }));
  const targets = new Map<string, WatchedTarget>();

  const debouncer: Debouncer = createDebouncer({
    waitMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    maxWaitMs: options.maxDebounceMs ?? DEFAULT_MAX_DEBOUNCE_MS,
    onFlush: (key, values) => {
      const [kind, worktreePath] = splitSignalKey(key);
      // The empty string is how an unnamed event is carried through the batch.
      // One of them makes the whole batch unnamed: reporting only the paths that
      // did have names would be narrower than the truth, and a consumer that
      // scoped a status to them would miss whatever the unnamed event was.
      const unnamed = values.includes('');
      options.onSignal({ kind, worktreePath, paths: unnamed ? [] : values });
    },
  });

  const push = (kind: SignalKind, worktreePath: string, value: string): void => {
    debouncer.push(signalKey(kind, worktreePath), value);
  };

  return {
    watch(target: WatchTarget): void {
      const worktreePath = canonical(target.worktreePath);
      if (targets.has(worktreePath)) return;

      const readIgnore = (): string[] => [
        ...(target.ignore ?? []),
        ...gitignorePatterns(worktreePath, log),
      ];
      const rootName = basename(worktreePath);
      const entry: WatchedTarget = {
        target,
        worktreePath,
        watchers: [],
        poller: null,
        ignore: readIgnore(),
      };
      targets.set(worktreePath, entry);

      const degrade = (reason: unknown): void => {
        // An OS watch limit is a property of the machine, not of the repository,
        // so this reports and keeps working rather than failing the target.
        // Target-wide even when only one watcher failed, because a budget is
        // exhausted machine-wide and the ones that succeeded are living on
        // borrowed descriptors. Nothing re-arms it on its own: `unwatch` then
        // `watch` is the way back, which a sweep does when it re-lists.
        log.warn('watch refused, falling back to polling', {
          worktreePath,
          reason: reason instanceof Error ? reason.message : String(reason),
        });
        stopWatchers(entry);
        // Emitted directly rather than through the debouncer. A poll tick is not
        // activity to coalesce, it is "time to look" — and feeding it into a
        // quiet-period timer means an interval shorter than the debounce keeps
        // restarting it, so the signal only ever escapes at the ceiling.
        entry.poller = setInterval(() => {
          options.onSignal({ kind: 'worktree', worktreePath, paths: [] });
        }, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
        // Nothing depends on the daemon staying alive for a poll tick.
        entry.poller.unref();
      };

      try {
        entry.watchers.push(
          watchTree(
            watchFactory,
            worktreePath,
            (filename) => {
              const rel = normalise(filename);
              // A metadata change on the watched directory itself is reported
              // as that directory's own name, which is indistinguishable from a
              // child of the same name. Reported as unnamed rather than dropped:
              // an entry really called that would otherwise be lost, and "ask
              // git" costs a status where guessing costs a change.
              if (rel === null || rel === rootName) {
                push('worktree', worktreePath, '');
                return;
              }
              // `.git` is watched deliberately and separately; from here it is
              // index and object churn arriving on every command. Matched at
              // any depth, not just the root: a submodule or a vendored
              // repository has one too, and its churn is no more interesting.
              if (rel.split('/').includes('.git')) return;
              // Re-read before it is applied, so a repository that adds
              // `node_modules` mid-session stops being watched there without a
              // restart. The change itself still signals: the file is content.
              if (rel === '.gitignore') entry.ignore = readIgnore();
              if (pathIgnored(rel, entry.ignore)) return;
              push('worktree', worktreePath, rel);
            },
            degrade,
            log,
          ),
        );

        for (const dir of refDirsOf(target, log)) {
          entry.watchers.push(
            watchTree(
              watchFactory,
              dir.path,
              (filename) => {
                const rel = normalise(filename);
                if (rel === null) {
                  push('ref', worktreePath, '');
                  return;
                }
                if (dir.topLevelOnly && !REF_FILES.has(rel)) return;
                push('ref', worktreePath, dir.prefix + rel);
              },
              degrade,
              log,
              dir.topLevelOnly ? { recursive: false } : { recursive: true },
            ),
          );
        }
      } catch (error) {
        degrade(error);
      }
    },

    unwatch(worktreePath: string): void {
      const key = canonicalIfPossible(worktreePath);
      const entry = targets.get(key);
      if (entry === undefined) return;
      stopWatchers(entry);
      targets.delete(key);
      // Anything still batched names a worktree nobody is listening to now.
      for (const kind of SIGNAL_KINDS) debouncer.cancel(signalKey(kind, key));
    },

    close(): void {
      for (const entry of targets.values()) stopWatchers(entry);
      targets.clear();
      debouncer.cancel();
    },

    get watching(): readonly string[] {
      return [...targets.keys()];
    },

    isDegraded(worktreePath: string): boolean {
      return targets.get(canonicalIfPossible(worktreePath))?.poller != null;
    },
  };
}

/**
 * Patterns from the worktree's root `.gitignore`.
 *
 * Watching `node_modules` is the difference between the CPU budget and burning
 * a core, and the repository has already said not to look there.
 *
 * Two deliberate limits. Nested `.gitignore` files are not read — the offenders
 * that matter are declared at the root, and walking for them costs a directory
 * scan per watch. And a file using `!` is dropped whole rather than partly
 * applied: a negation rescues a path this matcher would exclude, and excluding
 * a file that changed loses a change, while watching one git ignores only costs
 * a wasted signal the sweep discards. The asymmetry decides it.
 */
function gitignorePatterns(worktreePath: string, log: Logger): string[] {
  let contents: string;
  try {
    contents = readFileSync(join(worktreePath, '.gitignore'), 'utf8');
  } catch {
    return [];
  }

  const lines = contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  if (lines.some((line) => line.startsWith('!'))) {
    log.debug('.gitignore uses negation; watching everything it names', { worktreePath });
    return [];
  }
  return lines;
}

interface RefDir {
  readonly path: string;
  /** Prefix restoring the git-dir-relative name a signal reports. */
  readonly prefix: string;
  readonly topLevelOnly: boolean;
}

/**
 * Where a branch moving becomes visible.
 *
 * `HEAD` is per-worktree and `refs/` is shared, so a linked worktree needs both
 * its own git dir and the common one — watching only the first misses every
 * commit, and watching only the second misses every checkout.
 */
function refDirsOf(target: WatchTarget, log: Logger): RefDir[] {
  const dirs: RefDir[] = [{ path: target.gitDir, prefix: '', topLevelOnly: true }];
  const shared = target.commonDir ?? target.gitDir;

  if (shared !== target.gitDir) {
    dirs.push({ path: shared, prefix: '', topLevelOnly: true });
  }
  const refs = `${shared}${sep}refs`;
  if (existsSync(refs)) dirs.push({ path: refs, prefix: 'refs/', topLevelOnly: false });

  const present = dirs.filter((dir) => existsSync(dir.path));
  for (const dir of dirs) {
    // Reported rather than dropped in silence: the symptom of a git dir that is
    // not there is ref signals that simply never arrive, which is
    // indistinguishable from a quiet repository.
    if (!present.includes(dir))
      log.warn('git directory not found; refs unwatched', { path: dir.path });
  }
  return present;
}

function watchTree(
  factory: WatchFactory,
  path: string,
  onName: (filename: string | null) => void,
  onFatal: (reason: unknown) => void,
  log: Logger,
  watchOptions: { recursive: boolean } = { recursive: true },
): FSWatcher {
  const watcher = factory(path, watchOptions);
  watcher.on('change', (_event, filename) => {
    onName(typeof filename === 'string' ? filename : null);
  });
  watcher.on('error', (error: NodeJS.ErrnoException) => {
    // A watched directory being deleted is ordinary — an agent removing a build
    // output, or the worktree itself going away — and must not take the daemon
    // with it.
    if (error.code === 'ENOENT') {
      log.debug('watched path disappeared', { path });
      watcher.close();
      return;
    }
    onFatal(error);
  });
  return watcher;
}

function stopWatchers(entry: WatchedTarget): void {
  for (const watcher of entry.watchers) {
    try {
      watcher.close();
    } catch {
      // Already closed by its own error handler.
    }
  }
  entry.watchers.length = 0;
  if (entry.poller !== null) {
    clearInterval(entry.poller);
    entry.poller = null;
  }
}

/**
 * Resolve to the path git would report.
 *
 * On macOS `/var` is a symlink to `/private/var`, so a worktree registered from
 * `tmpdir()` arrives from git canonicalised and a naive comparison never
 * matches.
 */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    throw new InterlockError('REPO_NOT_FOUND', 'The worktree to watch does not exist', {
      cause: error,
      details: { path },
      remedy: 'Pass a worktree that is on disk; a deleted one has nothing to watch.',
    });
  }
}

function canonicalIfPossible(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Looking a target up by a path that has since been deleted still has to
    // find it, or it can never be unwatched.
    return path;
  }
}

/**
 * Normalise a reported filename to a `/`-separated relative path.
 *
 * Returns `null` when the platform gave no name, which is a real change with an
 * unknown path rather than no change at all.
 */
function normalise(filename: string | null): string | null {
  if (filename === null || filename === '') return null;
  const normalised = filename.split(sep).join('/');
  return normalised === '.' ? null : normalised;
}
