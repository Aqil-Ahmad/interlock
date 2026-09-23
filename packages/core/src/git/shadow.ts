import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { InterlockError, notImplemented } from '@interlock/shared';
import type { RepoId } from '@interlock/shared';
import { runRequired } from './repo-handle.js';
import type { GitRunner, ShadowRepo, UserRepo } from './repo-handle.js';

/**
 * The shadow clone: the one repository Interlock is allowed to write to.
 *
 * One clone per user repo, sharing the user's object store through
 * `objects/info/alternates` instead of copying it — a repository whose objects
 * are already reachable transfers nothing, so a refresh costs refs alone
 * whatever the history weighs. It is bare: nothing here needs a checkout, and
 * the per-pair worktrees an analyzer runs in are cut from this clone and
 * outlive any single merge, because the incremental compiler state inside them
 * is what makes continuous checking affordable.
 */

/** Owner-only. A directory needs `x` to be traversable; nothing inside it does. */
const SHADOW_DIR_MODE = 0o700;

const SHADOWS_DIR = 'shadows';

/**
 * Where the user's branches land in the shadow.
 *
 * Their own namespace rather than `refs/heads/*`: the shadow's branches are
 * Interlock's to move, and a fetch that wrote over them would make the user's
 * history and Interlock's speculative refs the same names.
 */
const USER_REFS_PREFIX = 'refs/remotes/user/';

/**
 * Identity for commits this clone will author.
 *
 * Set in the repository's own config because it cannot be passed any other way:
 * the runner strips inherited `GIT_*` variables, neutralises global and system
 * config, and refuses a caller's `-c`. A snapshot of uncommitted work is
 * committed here, and `commit-tree` fails outright without an identity.
 */
const SHADOW_CONFIG: readonly (readonly [string, string])[] = [
  ['user.name', 'Interlock'],
  ['user.email', 'interlock@interlock.invalid'],
  // Auto-maintenance detaches a background process that holds
  // `objects/maintenance.lock` after the command that started it returns, and
  // this clone's objects are the user's through alternates. The runner passes
  // the same pair as `-c` on every invocation, and the overlap is deliberate:
  // a flag covers what Interlock runs, while config in the repository covers
  // git run against this clone by anyone else.
  ['maintenance.auto', 'false'],
  ['gc.auto', '0'],
];

/**
 * The hash functions a clone can be created with.
 *
 * git refuses to fetch between repositories whose object formats differ, so the
 * clone takes the format of the repository it borrows from. A value outside
 * this set is a git newer than this code, and is refused rather than passed to
 * `init` unexamined.
 */
const OBJECT_FORMATS: ReadonlySet<string> = new Set(['sha1', 'sha256']);

/** What a clone has to match in the repository it mirrors. */
interface Source {
  /** Canonical path of the object store the clone borrows. */
  readonly objectsDir: string;
  readonly objectFormat: string;
}

/**
 * Refreshes in progress, by shadow path.
 *
 * Two callers asking for one clone at once is the ordinary case — pairs share
 * branches, so a shadow is resolved for each of them around the same moment —
 * and left to interleave they destroy each other: one finds the other's clone
 * half-built, discards it and deletes the directory the other is writing into,
 * and two fetches into one repository contend for the same ref locks. A caller
 * arriving while one runs joins it rather than queueing, as the sweep does; it
 * sees refs as of the refresh it joined, which is the staleness every caller
 * already has between calls.
 *
 * Per process. Two daemons sharing a data directory are not serialised here —
 * that belongs to the data directory, once, not to every repository inside it.
 */
const inFlight = new Map<string, Promise<ShadowRepo>>();

export interface ShadowOptions {
  readonly runner: GitRunner;
  /** Root of Interlock's data dir; shadows live under `<dataDir>/shadows/<repoId>`. */
  readonly dataDir: string;
  /** Identifies the shadow, so one repository always resolves to one clone. */
  readonly repoId: RepoId;
}

/** Where the clone for a repository lives. The store records the same path. */
export function shadowPathFor(id: RepoId, dataDir: string): string {
  return join(dataDir, SHADOWS_DIR, id);
}

/**
 * The only way to obtain a writable repository handle.
 *
 * Creates the clone if it is absent or unusable, then refreshes it from the
 * user repo. Fetching *from* a repository reads it: git runs `upload-pack`
 * there, which writes nothing, and `user-repo-untouched.test.ts` holds that to
 * the byte.
 *
 * The refresh prunes, so a branch deleted upstream leaves the shadow rather
 * than lingering as a ref whose objects only the shadow still wants.
 */
export function ensureShadow(repo: UserRepo, options: ShadowOptions): Promise<ShadowRepo> {
  const shadowPath = shadowPathFor(options.repoId, options.dataDir);
  // Read and claimed with no await between, so a second caller cannot start a
  // refresh in the gap.
  const running = inFlight.get(shadowPath);
  if (running !== undefined) return running;

  const pass = refresh(repo, options, shadowPath).finally(() => {
    inFlight.delete(shadowPath);
  });
  inFlight.set(shadowPath, pass);
  return pass;
}

async function refresh(
  repo: UserRepo,
  options: ShadowOptions,
  shadowPath: string,
): Promise<ShadowRepo> {
  const originPath = originPathOf(repo);
  const source = await sourceOf(repo, options.runner);

  const shadow: ShadowRepo = {
    kind: 'shadow',
    rootPath: shadowPath,
    // Bare, so the repository is its own git directory.
    gitDir: shadowPath,
    originPath,
  };

  if (!(await isUsableShadow(shadow, source, options.runner))) {
    discard(shadowPath, options.dataDir);
    await create(shadow, source, options.runner);
  }

  await runRequired(options.runner, shadow, [
    'fetch',
    '--prune',
    // Tags are global names shared across every repository a user has, and
    // nothing here resolves one. Fetching them would import a namespace this
    // clone has no way to keep straight.
    '--no-tags',
    originPath,
    `+refs/heads/*:${USER_REFS_PREFIX}*`,
  ]);

  return shadow;
}

/**
 * The canonical path of the repository being mirrored.
 *
 * Canonical because the alternates file records a path git resolves later, and
 * on macOS `/var` is a symlink to `/private/var` — two names for one directory
 * that compare as different. It is also what makes the path safe to hand
 * `fetch` as a remote, where a value beginning with `-` would be read as an
 * option: `realpath` answers absolutely or not at all.
 */
function originPathOf(repo: UserRepo): string {
  try {
    return realpathSync(repo.rootPath);
  } catch (error) {
    throw new InterlockError('REPO_NOT_FOUND', 'The repository to mirror is not on disk', {
      cause: error,
      details: { rootPath: repo.rootPath },
      remedy: 'Point Interlock at a repository that exists, or remove it from the watched set.',
    });
  }
}

/**
 * The object store the shadow will borrow, and the hash function it uses.
 *
 * Asked of git rather than joined by hand, because a linked worktree's git
 * directory is `<main>/.git/worktrees/<name>` and holds no objects of its own:
 * `--git-path objects` resolves to the shared store for one, and answers
 * relative to the repository root for an ordinary checkout. Both questions go
 * in one invocation, answered in the order asked.
 *
 * Resolution failing is not a path git leaves reachable — its own discovery
 * refuses a repository with no `objects/` before answering — so the catch is
 * what keeps an unforeseen one a typed error instead of a bare `ENOENT`.
 */
async function sourceOf(repo: UserRepo, runner: GitRunner): Promise<Source> {
  const result = await runRequired(runner, repo, [
    'rev-parse',
    '--show-object-format',
    '--git-path',
    'objects',
  ]);
  // Split on the first newline only: the format never contains one, and the
  // path, which is the rest, may.
  const newline = result.stdout.indexOf('\n');
  const objectFormat = result.stdout.slice(0, newline);
  const reported = result.stdout.slice(newline + 1).replace(/\n$/u, '');

  if (!OBJECT_FORMATS.has(objectFormat)) {
    throw new InterlockError(
      'TOOLCHAIN_UNSUPPORTED',
      'The repository uses an unknown object format',
      {
        details: { rootPath: repo.rootPath, objectFormat },
        remedy: 'Interlock mirrors sha1 and sha256 repositories; upgrade Interlock for this one.',
      },
    );
  }

  const path = isAbsolute(reported) ? reported : resolve(repo.rootPath, reported);
  try {
    return { objectsDir: realpathSync(path), objectFormat };
  } catch (error) {
    throw new InterlockError('REPO_NOT_FOUND', 'The repository has no object store', {
      cause: error,
      details: { rootPath: repo.rootPath },
      remedy: 'Check that the repository is a git repository and that its git directory is intact.',
    });
  }
}

/**
 * Whether an existing directory is this repository's shadow and fit to use.
 *
 * Four ways it is not, and all four are cheaper to rebuild than to repair: a
 * directory left behind by a crash mid-creation, one that is not a bare
 * repository, one borrowing a different object store — a clone of something
 * else wearing this repository's id — and one whose hash function differs from
 * the repository's, which no fetch between them can ever succeed across.
 *
 * Asking git covers the absent case as well, since `-C` into a directory that
 * is not there fails before the question is put. A separate existence check
 * would only spend the process it saves once in a repository's life.
 */
async function isUsableShadow(
  shadow: ShadowRepo,
  source: Source,
  runner: GitRunner,
): Promise<boolean> {
  const answer = await runner.run(shadow, [
    'rev-parse',
    '--is-bare-repository',
    '--show-object-format',
  ]);
  if (answer.exitCode !== 0) return false;
  const [bare, objectFormat] = answer.stdout.trim().split('\n');
  if (bare !== 'true' || objectFormat !== source.objectFormat) return false;

  return alternatesOf(shadow.rootPath) === source.objectsDir;
}

function alternatesOf(shadowPath: string): string | null {
  try {
    return readFileSync(alternatesFileOf(shadowPath), 'utf8').trim();
  } catch {
    return null;
  }
}

function alternatesFileOf(shadowPath: string): string {
  return join(shadowPath, 'objects', 'info', 'alternates');
}

/**
 * Remove a shadow that cannot be used.
 *
 * A recursive delete, so what it may delete is bounded by construction rather
 * than by the caller: only a directory sitting immediately inside this data
 * directory's `shadows/` can go, which is the only shape this module creates.
 */
function discard(shadowPath: string, dataDir: string): void {
  if (dirname(shadowPath) !== join(dataDir, SHADOWS_DIR)) {
    throw new InterlockError(
      'SHADOW_UNAVAILABLE',
      'Refused to remove a path outside the data dir',
      {
        details: { dataDir },
        remedy: 'Shadows live under <dataDir>/shadows/<repoId>; do not point one elsewhere.',
      },
    );
  }
  rmSync(shadowPath, { recursive: true, force: true });
}

async function create(shadow: ShadowRepo, source: Source, runner: GitRunner): Promise<void> {
  // `mkdir` masks the mode it is given with the umask, so a directory this call
  // created is set again rather than trusted. `shadows/` is created by the same
  // call and takes the same mode, since it holds every clone.
  if (mkdirSync(shadow.rootPath, { recursive: true, mode: SHADOW_DIR_MODE }) !== undefined) {
    chmodSync(shadow.rootPath, SHADOW_DIR_MODE);
  }

  // Named rather than left to git's built-in default, which prints advice about
  // the name it chose on a repository whose branches are all fetched anyway.
  await runRequired(runner, shadow, [
    'init',
    '--bare',
    `--object-format=${source.objectFormat}`,
    '--initial-branch=main',
  ]);
  for (const [key, value] of SHADOW_CONFIG) {
    await runRequired(runner, shadow, ['config', key, value]);
  }

  // Written last: it is what makes the directory this repository's shadow, so a
  // run that dies before this leaves something `isUsableShadow` rebuilds rather
  // than a clone that silently borrows nothing.
  writeFileSync(alternatesFileOf(shadow.rootPath), `${source.objectsDir}\n`);
}

/** A disposable checkout inside the shadow clone, used for one merge attempt. */
export interface ShadowWorktree {
  readonly path: string;
  readonly shadow: ShadowRepo;
  /** Removes the worktree and prunes its administrative files. */
  dispose(): Promise<void>;
}

export function createShadowWorktree(
  _shadow: ShadowRepo,
  _atCommit: string,
  _options: ShadowOptions,
): Promise<ShadowWorktree> {
  return notImplemented('createShadowWorktree');
}

/** Reclaim worktrees and objects beyond the disk quota, oldest-unused first. */
export function collectGarbage(_shadow: ShadowRepo, _options: ShadowOptions): Promise<number> {
  return notImplemented('collectGarbage');
}
