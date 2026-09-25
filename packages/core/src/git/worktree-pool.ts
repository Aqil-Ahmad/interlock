import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { InterlockError, isUlid, silentLogger } from '@interlock/shared';
import type { Logger, MergePairKey, RepoId } from '@interlock/shared';
import type { SpeculativeMergeResult } from '../merge/speculative-merge.js';
import { assertObjectId, runRequired } from './repo-handle.js';
import type { GitRunner, ShadowRepo } from './repo-handle.js';
import { shadowPathFor } from './shadow.js';

/**
 * The per-pair worktree pool: a few persistent checkouts cut from the shadow,
 * each holding one clean pair's merged tree on disk for a semantic check to
 * read.
 *
 * A slot outlives any single check because what accumulates inside it —
 * `.tsbuildinfo`, a build orchestrator's cache — is what makes the next check
 * of that pair cost the change rather than the repository. So a slot is
 * updated by delta, never rebuilt: the merged tree is wrapped in a throwaway
 * commit and the slot is `reset --hard` to it, which rewrites the files that
 * differ and leaves untracked and ignored files where they are.
 *
 * Slots keep a detached `HEAD`, so no ref moves; the commit a slot holds is a
 * root for git's own `prune` for as long as the slot exists, and the one before
 * it is not.
 *
 * This module sits beside `ensureShadow` because it mints `ShadowRepo` handles
 * of its own — one per slot, rooted at the slot and naming the shadow's
 * `worktrees/<name>` as its git directory — and a writable handle may only be
 * derived from one `ensureShadow` returned. Every slot handle is built here
 * from the pool's shadow, and nothing else in the codebase builds one.
 */

/** Slots kept at once when the caller does not say. */
export const DEFAULT_POOL_SIZE = 4;

/** Owner-only, as the shadows are: a slot holds the user's source. */
const POOL_DIR_MODE = 0o700;

const POOLS_DIR = 'worktrees';

/**
 * Files whose difference means installed dependencies no longer match a tree.
 *
 * By basename, anywhere in the tree: a workspace has a manifest per package,
 * and a nested project can carry its own lockfile. Package-manager config is
 * here too, since it changes what an install resolves. Erring wide only skips
 * a check, which is silence; erring narrow typechecks against the wrong
 * dependency tree, which is a confident wrong answer.
 */
export const DEPENDENCY_FILES: ReadonlySet<string> = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.pnpmfile.cjs',
  'yarn.lock',
  '.yarnrc.yml',
  'bun.lock',
  'bun.lockb',
  '.npmrc',
]);

/** Two ULIDs joined by a colon, which is the only shape `makePairKey` produces. */
const PAIR_KEY = /^([0-9A-HJKMNP-TV-Z]{26}):([0-9A-HJKMNP-TV-Z]{26})$/u;

/** A slot's directory name: the pair key with the colon made path-neutral. */
const SLOT_NAME = /^([0-9A-HJKMNP-TV-Z]{26})-([0-9A-HJKMNP-TV-Z]{26})$/u;

export interface WorktreePoolOptions {
  readonly runner: GitRunner;
  /** Root of Interlock's data dir; slots live under `<dataDir>/worktrees/<repoId>`. */
  readonly dataDir: string;
  /** The repository the shadow mirrors. The shadow must be the one `ensureShadow` put here. */
  readonly repoId: RepoId;
  /** Slots kept at once. Each is a full checkout, so this is a disk budget. */
  readonly size?: number;
  readonly logger?: Logger;
}

/** One check's claim on a slot. */
export interface SlotRequest {
  readonly key: MergePairKey;
  /** The commits `merged` came from. They parent the slot's commit, so its history names the pair. */
  readonly commitA: string;
  readonly commitB: string;
  /** Must be clean: a conflicted tree has markers in it and is not worth compiling. */
  readonly merged: SpeculativeMergeResult;
  /**
   * The tree of the checkout whose installed dependencies a check in this slot
   * borrows — captured into the shadow like any snapshot.
   *
   * The merged tree is compared against it, not either side of the pair: the
   * merged tree is what gets compiled, and a side's change that does not
   * survive the merge cannot affect the compile.
   */
  readonly dependencyTreeOid: string;
}

/** A slot, held by one check for the duration of its callback. */
export interface PoolSlot {
  readonly key: MergePairKey;
  /** The checkout. Valid only until the callback given to `withSlot` settles. */
  readonly path: string;
  /** For git commands inside the slot. Mutating ones are allowed: it is the shadow's. */
  readonly repo: ShadowRepo;
  /** The throwaway commit the slot's detached `HEAD` names. */
  readonly commitSha: string;
  readonly treeOid: string;
}

/** What eviction threw away, so a scheduler can price it. */
export interface SlotEviction {
  /** Null for a slot adopted from disk whose directory name did not parse. */
  readonly key: MergePairKey | null;
  readonly path: string;
  /** Allocated size of the slot, build state included. */
  readonly bytes: number;
  /** Since the slot was first filled: how long its incremental state had been accumulating. */
  readonly buildStateAgeMs: number;
  /** Since a check last used it. */
  readonly idleMs: number;
}

export type SlotOutcome<T> =
  | {
      readonly kind: 'ran';
      readonly value: T;
      /**
       * `cold` materialised the whole tree; `delta` rewrote what differed. The
       * first `delta` after a `cold` also re-reads every file written in the
       * same second as the index — git cannot trust their timestamps — so on a
       * large tree it costs about what the fill did, and belongs to its price.
       */
      readonly fill: 'cold' | 'delta';
      readonly fillMs: number;
      /** The slot given up to make room, if one was. */
      readonly evicted: SlotEviction | null;
    }
  | {
      readonly kind: 'skipped';
      readonly reason: 'deps-dirty';
      /** Dependency files that differ between the merged tree and the dependency tree. */
      readonly paths: readonly string[];
    };

export interface WorktreePool {
  /**
   * Bring the pair's slot to the merged tree and run `use` against it.
   *
   * The slot is the caller's alone until `use` settles: a second check of the
   * same pair waits, and no other pair can evict it. A deps-dirty pair is
   * skipped before any slot is touched, so it never costs another pair its
   * build state.
   */
  withSlot<T>(request: SlotRequest, use: (slot: PoolSlot) => Promise<T>): Promise<SlotOutcome<T>>;
}

/** Where a repository's slots live. */
export function poolPathFor(id: RepoId, dataDir: string): string {
  return join(dataDir, POOLS_DIR, id);
}

interface Entry {
  readonly name: string;
  readonly key: MergePairKey | null;
  /** Null until the slot exists on disk. */
  filledAt: number | null;
  lastUsedAt: number;
  /** Checks holding or waiting for the slot. An entry with any is never evicted. */
  holders: number;
}

/**
 * Open a pool over a shadow.
 *
 * Nothing touches the disk until the first check: the pool directory is
 * created then, and any slots a previous process left there are adopted in
 * least-recently-used order, so a restart keeps build state rather than
 * orphaning it.
 */
export function createWorktreePool(shadow: ShadowRepo, options: WorktreePoolOptions): WorktreePool {
  const { runner, dataDir, repoId } = options;
  const size = options.size ?? DEFAULT_POOL_SIZE;
  const log = (options.logger ?? silentLogger).child('pool', { repoId });

  if (!Number.isInteger(size) || size < 1) {
    throw new InterlockError('CONFIG_INVALID', 'The worktree pool needs at least one slot', {
      details: { size },
      remedy: 'Set the pool size to a whole number of 1 or more.',
    });
  }
  assertRealShadow(shadow, repoId, dataDir);

  const poolPath = poolPathFor(repoId, dataDir);
  const adminRoot = join(shadow.gitDir, 'worktrees');
  // Insertion order is recency: a use moves an entry to the end.
  const slots = new Map<string, Entry>();
  const locks = new Map<string, Promise<void>>();
  let waiters: (() => void)[] = [];
  let loaded: Promise<string> | undefined;

  /**
   * Run `task` holding the slot name's lock.
   *
   * By name rather than by entry, so an eviction still discarding a directory
   * holds off a new fill of the same pair into the same path.
   */
  const withLock = async <T>(name: string, task: () => Promise<T>): Promise<T> => {
    const previous = locks.get(name) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    locks.set(name, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (locks.get(name) === tail) locks.delete(name);
    }
  };

  const released = (): Promise<void> =>
    new Promise((resolve) => {
      waiters.push(resolve);
    });

  const wakeWaiters = (): void => {
    const woken = waiters;
    waiters = [];
    for (const wake of woken) wake();
  };

  const slotRepo = (canonicalPool: string, name: string): ShadowRepo => ({
    kind: 'shadow',
    rootPath: join(canonicalPool, name),
    gitDir: join(adminRoot, name),
    originPath: shadow.originPath,
  });

  /**
   * Remove a slot and every administrative trace of it.
   *
   * git's own removal first. What follows is for a slot git no longer
   * recognises — an `add` interrupted before it registered, or one that left
   * its `locked` marker, which `remove` refuses and `prune` skips — and each
   * recursive delete is bounded to a direct child of the directory it belongs
   * in, which is the only shape this module creates.
   */
  const discard = async (canonicalPool: string, name: string): Promise<void> => {
    const path = join(canonicalPool, name);
    await runner.run(shadow, ['worktree', 'remove', '--force', '--force', path]);
    removeChild(canonicalPool, path);
    removeChild(adminRoot, join(adminRoot, name));
    await runRequired(runner, shadow, ['worktree', 'prune']);
  };

  const evict = async (canonicalPool: string, entry: Entry): Promise<SlotEviction> => {
    const path = join(canonicalPool, entry.name);
    const now = Date.now();
    const eviction: SlotEviction = {
      key: entry.key,
      path,
      bytes: await allocatedBytes(path),
      buildStateAgeMs: entry.filledAt === null ? 0 : now - entry.filledAt,
      idleMs: now - entry.lastUsedAt,
    };
    await discard(canonicalPool, entry.name);
    // Info, not debug: every eviction discards incremental compiler state and
    // forces a cold fill later, and the rate of them is a tuning signal.
    log.info('pool slot evicted', { ...eviction });
    return eviction;
  };

  /**
   * Create the pool directory and adopt what a previous process left in it.
   *
   * Refuses first, before anything is created, a pool that would resolve
   * inside the user's repository — a data dir configured inside a checkout, or
   * a symlink leading into one.
   */
  const load = async (): Promise<string> => {
    const within = protectedDirOf(shadow, poolPath);
    if (within !== null) {
      throw new InterlockError(
        'SHADOW_UNAVAILABLE',
        'Refused to put worktrees inside the repository being watched',
        {
          details: { repoId },
          remedy: 'Move the data dir outside every watched repository.',
          infra: true,
        },
      );
    }

    // `mkdir` masks the mode with the umask, so the pool's own directory is set
    // again rather than trusted, as the shadow's is.
    let canonicalPool: string;
    try {
      if (mkdirSync(poolPath, { recursive: true, mode: POOL_DIR_MODE }) !== undefined) {
        chmodSync(poolPath, POOL_DIR_MODE);
      }
      canonicalPool = realpathSync(poolPath);
    } catch (error) {
      throw new InterlockError(
        'SHADOW_UNAVAILABLE',
        'The worktree pool directory cannot be created',
        {
          cause: error,
          details: { repoId },
          remedy:
            'Check that the data dir is writable and nothing but a directory sits at its worktrees/ path.',
          infra: true,
        },
      );
    }

    // Administrative entries whose checkout has gone, from before this process.
    await runRequired(runner, shadow, ['worktree', 'prune']);

    const found: Entry[] = [];
    for (const name of readdirSync(canonicalPool)) {
      const times = SLOT_NAME.test(name) ? slotTimesOf(canonicalPool, adminRoot, name) : null;
      if (times === null) {
        log.warn('pool slot unusable, discarded', { path: join(canonicalPool, name) });
        await discard(canonicalPool, name);
        continue;
      }
      found.push({ name, key: keyOfSlot(name), ...times, holders: 0 });
    }
    found.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const entry of found) slots.set(entry.name, entry);

    // A smaller pool than the last process ran with keeps the most recent.
    for (const entry of found.slice(0, Math.max(0, found.length - size))) {
      slots.delete(entry.name);
      await evict(canonicalPool, entry);
    }
    return canonicalPool;
  };

  /**
   * Bring a slot to `commitSha`, creating or repairing it as needed.
   *
   * A lock file in the slot's git directory is stale by construction when this
   * runs. Only the pool runs git in a slot; it runs one command at a time per
   * slot, under the lock held here, and waits for each to exit; and one process
   * owns a data dir at a time. So a lock seen now was left by a git that exited
   * without cleaning up — killed with `SIGKILL`, in this process or the one
   * before. Removing it and resetting repairs every tracked file, because
   * `reset --hard` rewrites whatever differs from the target, half-written or
   * not, and leaves the untracked build state alone. The one case it does not
   * cover is a git orphaned by a daemon killed outright and still running when
   * the next one reaches its slot.
   */
  const fill = async (
    canonicalPool: string,
    entry: Entry,
    commitSha: string,
  ): Promise<{ readonly fill: 'cold' | 'delta'; readonly fillMs: number }> => {
    const startedAt = Date.now();
    const repo = slotRepo(canonicalPool, entry.name);
    let kind: 'cold' | 'delta' = 'delta';

    if (slotTimesOf(canonicalPool, adminRoot, entry.name) === null) {
      if (existsSync(repo.rootPath) || existsSync(repo.gitDir)) {
        log.warn('pool slot unusable, discarded', { path: repo.rootPath });
        await discard(canonicalPool, entry.name);
      }
      // `--no-checkout`, and the files written by the reset below: `add` checks
      // out in a child process that keeps writing into the slot when `add`
      // itself is killed, so a timeout would leave a writer nothing can stop.
      await runRequired(runner, shadow, [
        'worktree',
        'add',
        '--detach',
        '--no-checkout',
        repo.rootPath,
        commitSha,
      ]);
      if (slotTimesOf(canonicalPool, adminRoot, entry.name) === null) {
        throw new InterlockError('SHADOW_UNAVAILABLE', 'A new pool slot is not registered', {
          details: { path: repo.rootPath },
          remedy: 'Check that the shadow clone is intact, or remove it to have it rebuilt.',
          infra: true,
        });
      }
      entry.filledAt = Date.now();
      kind = 'cold';
    } else {
      const stale = staleLocksIn(repo.gitDir);
      for (const lock of stale) rmSync(join(repo.gitDir, lock), { force: true });
      if (stale.length > 0)
        log.warn('stale lock removed from pool slot', { path: repo.rootPath, locks: stale });
    }

    await runRequired(runner, repo, ['reset', '--hard', '--quiet', commitSha]);
    const fillMs = Date.now() - startedAt;
    log.debug('pool slot filled', { key: entry.key, fill: kind, fillMs });
    return { fill: kind, fillMs };
  };

  /**
   * The pair's entry, making room for it if it has none.
   *
   * Claimed with no await between the lookup and the claim, so two checks
   * cannot both take the last free place, pick the same victim, or evict a
   * slot another has just claimed. With every slot held, this waits for one to
   * be released rather than evicting from under a running check.
   */
  const claim = async (
    name: string,
    key: MergePairKey,
  ): Promise<{ readonly entry: Entry; readonly victim: Entry | null }> => {
    for (;;) {
      const existing = slots.get(name);
      if (existing !== undefined) {
        existing.holders += 1;
        slots.delete(name);
        slots.set(name, existing);
        return { entry: existing, victim: null };
      }
      let victim: Entry | null = null;
      if (slots.size >= size) {
        victim = [...slots.values()].find((candidate) => candidate.holders === 0) ?? null;
        if (victim === null) {
          await released();
          continue;
        }
        slots.delete(victim.name);
      }
      const entry: Entry = { name, key, filledAt: null, lastUsedAt: Date.now(), holders: 1 };
      slots.set(name, entry);
      return { entry, victim };
    }
  };

  return {
    async withSlot<T>(
      request: SlotRequest,
      use: (slot: PoolSlot) => Promise<T>,
    ): Promise<SlotOutcome<T>> {
      const name = slotNameOf(request.key);
      assertObjectId(request.commitA, 'commitA');
      assertObjectId(request.commitB, 'commitB');
      assertObjectId(request.merged.treeOid, 'merged.treeOid');
      assertObjectId(request.dependencyTreeOid, 'dependencyTreeOid');
      if (!request.merged.clean) {
        throw new InterlockError(
          'GIT_COMMAND_REFUSED',
          'A conflicted merge cannot enter a pool slot',
          {
            details: { key: request.key },
            remedy:
              'Report the conflict from the merge result; only clean merges are checked on disk.',
          },
        );
      }

      loaded ??= load();
      // A failed load is not cached: the next check tries again rather than
      // inheriting a rejection for the life of the process.
      const canonicalPool = await loaded.catch((error: unknown) => {
        loaded = undefined;
        throw error;
      });

      const drift = await dependencyDrift(
        shadow,
        runner,
        request.dependencyTreeOid,
        request.merged.treeOid,
      );
      if (drift.length > 0) {
        log.info('pair skipped: dependencies differ from the installed tree', {
          key: request.key,
          paths: drift.length,
        });
        return { kind: 'skipped', reason: 'deps-dirty', paths: drift };
      }

      // Outside any lock: objects are append-only, and the commit is the same
      // whichever slot ends up holding it.
      const committed = await runRequired(runner, shadow, [
        'commit-tree',
        '-p',
        request.commitA,
        '-p',
        request.commitB,
        '-m',
        'Interlock pool slot',
        request.merged.treeOid,
      ]);
      const commitSha = committed.stdout.trim();
      assertObjectId(commitSha, 'commitSha');

      const { entry, victim } = await claim(name, request.key);
      try {
        const evicted =
          victim === null ? null : await withLock(victim.name, () => evict(canonicalPool, victim));

        return await withLock(name, async () => {
          const filled = await fill(canonicalPool, entry, commitSha);
          entry.lastUsedAt = Date.now();
          const value = await use({
            key: request.key,
            path: join(canonicalPool, name),
            repo: slotRepo(canonicalPool, name),
            commitSha,
            treeOid: request.merged.treeOid,
          });
          return { kind: 'ran', value, ...filled, evicted } as const;
        });
      } catch (error) {
        // A slot that never reached the disk holds nothing worth its place.
        if (entry.filledAt === null && entry.holders === 1) slots.delete(name);
        throw error;
      } finally {
        entry.holders -= 1;
        wakeWaiters();
      }
    },
  };
}

/**
 * Dependency files that differ between two trees in the shadow, by path.
 *
 * Plumbing over two trees, so nothing is read from any checkout and the cost
 * is the directories that differ, not the repository.
 */
export async function dependencyDrift(
  shadow: ShadowRepo,
  runner: GitRunner,
  dependencyTreeOid: string,
  mergedTreeOid: string,
): Promise<readonly string[]> {
  assertObjectId(dependencyTreeOid, 'dependencyTreeOid');
  assertObjectId(mergedTreeOid, 'mergedTreeOid');
  const result = await runner.run(shadow, [
    'diff-tree',
    '-r',
    '-z',
    '--name-only',
    dependencyTreeOid,
    mergedTreeOid,
  ]);
  if (result.exitCode !== 0) {
    throw new InterlockError(
      'SNAPSHOT_STALE',
      'A tree to compare dependencies across is not in the shadow',
      {
        details: { exitCode: result.exitCode },
        remedy:
          'Capture the dependency checkout again, into this shadow, and merge the pair again.',
      },
    );
  }
  return result.stdout
    .split('\0')
    .filter((path) => path !== '' && DEPENDENCY_FILES.has(basename(path)));
}

/**
 * Refuse a handle that is not the shadow `ensureShadow` put at this data dir.
 *
 * Checked at run time because every slot handle is derived from this one. A
 * slot handle passed back in as a shadow fails the bare check, since its git
 * directory is not its root; a shadow for another repository or data dir
 * fails the path check. The id has to be a ULID before either: it becomes the
 * pool's directory, whose every entry that is not a slot is deleted, and an id
 * of `..` would make that the data dir itself.
 */
function assertRealShadow(shadow: ShadowRepo, repoId: RepoId, dataDir: string): void {
  if (
    !isUlid(repoId) ||
    (shadow as { kind: string }).kind !== 'shadow' ||
    shadow.gitDir !== shadow.rootPath ||
    shadow.rootPath !== shadowPathFor(repoId, dataDir)
  ) {
    throw new InterlockError(
      'GIT_COMMAND_REFUSED',
      'A worktree pool needs the shadow clone itself',
      {
        details: { repoId },
        remedy: 'Pass the ShadowRepo ensureShadow returned for this repository and data dir.',
      },
    );
  }
}

/**
 * The user directory `path` would resolve inside, or null if none.
 *
 * The user's checkout is the shadow's origin, and its git directory is the one
 * holding the store the shadow borrows — named in the alternates file, which
 * also covers a linked worktree, whose main checkout the origin path does not
 * name. `path` need not exist yet, so the deepest part of it that does is what
 * resolves, and the rest is joined back on.
 */
function protectedDirOf(shadow: ShadowRepo, path: string): string | null {
  const target = resolveDeepest(path);
  const dirs = [shadow.originPath];
  const objects = alternatesOf(shadow.gitDir);
  if (objects !== null) {
    const gitDir = dirname(objects);
    dirs.push(gitDir);
    if (basename(gitDir) === '.git') dirs.push(dirname(gitDir));
  }
  return dirs.find((dir) => isWithin(resolveDeepest(dir), target)) ?? null;
}

function alternatesOf(gitDir: string): string | null {
  try {
    return readFileSync(join(gitDir, 'objects', 'info', 'alternates'), 'utf8').trim();
  } catch {
    return null;
  }
}

function resolveDeepest(path: string): string {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

/** True when `child` is `parent` or beneath it, on whole path segments. */
function isWithin(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  if (rel === '' || isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

function slotNameOf(key: MergePairKey): string {
  const match = PAIR_KEY.exec(key);
  if (match === null) {
    throw new InterlockError('GIT_COMMAND_REFUSED', 'key is not a merge pair key', {
      // Not the value: it becomes a directory name, and it came from a caller.
      details: { field: 'key' },
      remedy: 'Pass the key makePairKey produced for the pair.',
    });
  }
  return `${match[1]!}-${match[2]!}`;
}

function keyOfSlot(name: string): MergePairKey | null {
  const match = SLOT_NAME.exec(name);
  return match === null ? null : (`${match[1]!}:${match[2]!}` as MergePairKey);
}

/**
 * When a slot was first filled and last used, or null if it is not a usable
 * slot of this shadow.
 *
 * Usable means git and the pool agree about it in both directions: the
 * checkout's `.git` names this shadow's administrative directory for it, that
 * directory names the checkout back, it has a `HEAD`, and no `locked` marker,
 * which `add` leaves when it is interrupted. Anything else — a shadow rebuilt
 * from under its slots, a half-made `add` — is cheaper to discard than to
 * reason about. Read from the filesystem, so the check costs no process.
 *
 * The times come from files git writes and never rewrites or always rewrites:
 * `commondir` once, at creation; the index on every reset.
 */
function slotTimesOf(
  canonicalPool: string,
  adminRoot: string,
  name: string,
): { readonly filledAt: number; readonly lastUsedAt: number } | null {
  const path = join(canonicalPool, name);
  const admin = join(adminRoot, name);
  try {
    const pointer = readFileSync(join(path, '.git'), 'utf8')
      .replace(/^gitdir: /u, '')
      .trim();
    const back = readFileSync(join(admin, 'gitdir'), 'utf8').trim();
    if (realpathSync(pointer) !== realpathSync(admin)) return null;
    if (back !== join(path, '.git')) return null;
    if (!existsSync(join(admin, 'HEAD')) || existsSync(join(admin, 'locked'))) return null;
    const filledAt = statSync(join(admin, 'commondir')).mtimeMs;
    const index = join(admin, 'index');
    return { filledAt, lastUsedAt: existsSync(index) ? statSync(index).mtimeMs : filledAt };
  } catch {
    return null;
  }
}

/**
 * Lock files directly in a slot's git directory.
 *
 * Only there: the shadow's own locks guard state every slot shares, and are
 * not the pool's to judge.
 */
function staleLocksIn(adminDir: string): string[] {
  return readdirSync(adminDir).filter((name) => name.endsWith('.lock'));
}

/** Recursive delete of `path`, refused unless it sits immediately inside `parent`. */
function removeChild(parent: string, path: string): void {
  if (dirname(path) !== parent) {
    throw new InterlockError('SHADOW_UNAVAILABLE', 'Refused to remove a path outside the pool', {
      details: { parent },
      remedy: 'Pool slots live directly under <dataDir>/worktrees/<repoId>.',
    });
  }
  rmSync(path, { recursive: true, force: true });
}

/** Allocated bytes under a directory, following no symlink. */
async function allocatedBytes(path: string): Promise<number> {
  let total = 0;
  const pending = [path];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    // A slot claimed but never filled has no directory, and weighs nothing.
    const stat = await lstat(current).catch(() => null);
    if (stat === null) continue;
    total += stat.blocks * 512;
    if (!stat.isDirectory()) continue;
    for (const child of await readdir(current)) pending.push(join(current, child));
  }
  return total;
}
