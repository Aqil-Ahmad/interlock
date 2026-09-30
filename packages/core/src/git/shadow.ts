import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { InterlockError, ulid } from '@interlock/shared';
import type { RepoId } from '@interlock/shared';
import { repositoryDirHolding, repositoryDirsOf } from './repo-dirs.js';
import { assertObjectId, runRequired } from './repo-handle.js';
import type { GitRunOptions, GitRunner, ShadowRepo, UserRepo } from './repo-handle.js';

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
 * Configuration the clone has to carry, brought into line on every refresh.
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
  // A conflict region `merge-tree` writes then carries the base text beside
  // both sides, which is what tells two additions next to each other from two
  // edits of the same line.
  ['merge.conflictStyle', 'diff3'],
  // A bare repository keeps no reflogs, but a pool slot is a worktree of this
  // one and git would give it a `HEAD` reflog — one entry per update, each
  // pinning a throwaway commit against `prune` for ninety days.
  ['core.logAllRefUpdates', 'false'],
];

/**
 * Where a clone records its generation — see {@link ShadowRepo.generation}.
 * In the clone's own config, so it goes with the clone: a rebuild starts from
 * an empty directory and so from none.
 */
const GENERATION_KEY = 'interlock.generation';

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
 * Per process, which is enough because one process is all a data directory
 * ever has: the daemon holds the directory for its whole run and a second one
 * is turned away at start. Serialising across processes here as well would
 * guard the same thing twice, per repository.
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
 * The only way to obtain a shadow clone. Every other writable handle — a pool
 * slot's — is derived from one this returned.
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
  // Before anything is written: a clone inside the checkout is the whole
  // store written into the user's worktree as untracked files. The daemon
  // refuses such a data dir before it starts; a caller handing a path here
  // directly is refused the same way.
  const dirs = [originPath, source.objectsDir, ...(await repositoryDirsOf(repo, options.runner))];
  if ((await repositoryDirHolding(shadowPath, dirs, options.runner)) !== null) {
    throw new InterlockError(
      'CONFIG_INVALID',
      'Refused to put a shadow clone inside the repository being watched',
      {
        details: { repoId: options.repoId },
        remedy: 'Move the data dir outside every watched repository.',
      },
    );
  }

  // The generation lives in the clone's config, which is read below; nothing
  // before that asks for it.
  const unread: ShadowRepo = {
    kind: 'shadow',
    rootPath: shadowPath,
    // Bare, so the repository is its own git directory.
    gitDir: shadowPath,
    originPath,
    generation: '',
  };

  if (!(await isUsableShadow(unread, source, options.runner))) {
    discard(shadowPath, options.dataDir);
    await create(unread, source, options.runner);
  }
  const shadow: ShadowRepo = { ...unread, generation: await syncConfig(unread, options.runner) };

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

/**
 * Where the refs that keep objects from collection live.
 *
 * Their own namespace, rewritten whole on every collection: nothing else in the
 * shadow names a snapshot commit or a capture's tree, so these are the only
 * roots such an object has.
 */
export const KEEP_REFS_PREFIX = 'refs/interlock/keep/';

/**
 * How long one collecting command may run before the runner stops it.
 *
 * Both walk everything reachable, which through `refs/remotes/user/*` is the
 * user's whole history, and the first pass over a shadow that was never
 * collected packs everything younger than the expiry: a day of continuous
 * checks, a million loose objects, took 37 minutes. This guards against a
 * wedged git only; a shutdown stops a collection through its signal, not by
 * waiting this out.
 */
const COLLECT_TIMEOUT_MS = 60 * 60_000;

export interface KeepOptions {
  readonly runner: GitRunner;
  /**
   * Objects kept however old — commits or trees — with everything they reach.
   * Each is checked first, and one whose history cannot be walked is left out.
   */
  readonly keep: readonly string[];
  readonly signal?: AbortSignal;
}

export interface KeepReport {
  /** What the keep refs now name. */
  readonly kept: readonly string[];
  /**
   * Candidates left unkept: missing, or reaching an object that is missing —
   * a snapshot commit whose parent the user's `gc` removed. One such ref would
   * stop the collection walking at all.
   */
  readonly unkeepable: readonly string[];
}

/**
 * Make the keep refs name exactly the candidates that can be kept whole.
 *
 * Safe while checks write to the shadow, so it runs before a collection takes
 * the shadow to itself: it reads objects and moves refs under
 * `refs/interlock/keep/`, which nothing else writes, and deletes nothing. What
 * a check writes after this is younger than any expiry, and kept by its age.
 */
export async function pinKeep(shadow: ShadowRepo, options: KeepOptions): Promise<KeepReport> {
  const { runner } = options;
  const run: GitRunOptions = options.signal === undefined ? {} : { signal: options.signal };
  for (const oid of options.keep) assertObjectId(oid, 'keep');
  const candidates = [...new Set(options.keep)];

  // One walk for all of them, the answer nearly every time; one each only to
  // find which failed. A pass with hundreds of live Findings is otherwise
  // hundreds of git calls.
  const kept: string[] = [];
  const unkeepable: string[] = [];
  if (candidates.length > 0 && (await walkable(shadow, runner, candidates, run))) {
    kept.push(...candidates);
  } else {
    for (const oid of candidates) {
      if (await walkable(shadow, runner, [oid], run)) kept.push(oid);
      else unkeepable.push(oid);
    }
  }
  await rewriteKeepRefs(shadow, runner, kept, run);
  return { kept, unkeepable };
}

export interface CollectOptions {
  readonly runner: GitRunner;
  /** Unreachable objects last written before this go; anything younger stays. */
  readonly expireBefore: Date;
  /**
   * Stops the collection at its next git command, and the one running: a walk
   * of a large history must not hold up a daemon shutting down. What it
   * stopped short of is left for the next collection.
   */
  readonly signal?: AbortSignal;
}

export interface CollectReport {
  /** The shadow's own store before and after: borrowed objects are not counted. */
  readonly before: ShadowStoreSize;
  readonly after: ShadowStoreSize;
  readonly durationMs: number;
}

export interface ShadowStoreSize {
  readonly loose: number;
  readonly packed: number;
  /** Loose and packed together, as `count-objects` measures them. */
  readonly kib: number;
}

/**
 * Collect the objects Interlock wrote into a shadow and no longer needs, and
 * pack the rest.
 *
 * Nothing may write to the shadow while this runs: an object it has judged
 * unreachable and old, written again by a check, is still deleted, from under
 * whatever the check made from it. The caller holds the shadow; {@link pinKeep}
 * is the part that does not need to.
 *
 * Nearly everything Interlock writes is loose and unreferenced: a capture's
 * blobs and trees, snapshot commits, merge trees. Left loose for a day of
 * continuous checks that is a million files, 4.4 GiB on disk for 1.3 GiB of
 * content, and a `prune` that takes nine minutes to list them. So every pass
 * packs: reachable objects into one pack, unreachable ones younger than the
 * expiry into a cruft pack, which records each object's own write time so it
 * still ages out. The same day packed was 135 MB, and an hour's pass over it
 * took half a minute.
 *
 * `repack -l` and `prune`, never `gc`. `-l` packs only the shadow's own
 * objects: without it every object borrowed from the user's store through
 * alternates is copied in. The user's objects are read to decide reachability
 * and never touched; `gc` would run the maintenance the shadow switches off.
 * Roots are the shadow's refs — the user's branches, the keep refs — and each
 * pool slot's `HEAD` and index.
 *
 * Repack first, prune after, once there is a cruft pack. An object in a cruft
 * pack that is written again gets a fresh loose copy; `prune` deletes a loose
 * copy of anything packed, and a repack after it sees only the old time and
 * drops the object. Repacking first reads the fresh copy, and what it leaves
 * loose is what is past the expiry, for the prune to delete. Before there is a
 * cruft pack the hazard cannot arise, and a shadow never collected is where a
 * backlog is: prune first there, since a prune stopped part way keeps what it
 * deleted and a repack stopped part way keeps nothing, so a backlog too large
 * for one attempt still shrinks with each.
 *
 * Refresh the shadow first: a ref naming an object the user's `gc` has since
 * removed stops both walking, and a refresh is what drops such a ref.
 */
export async function collectShadow(
  shadow: ShadowRepo,
  options: CollectOptions,
): Promise<CollectReport> {
  const { runner } = options;
  const run: GitRunOptions = options.signal === undefined ? {} : { signal: options.signal };
  const expire = options.expireBefore.getTime();
  if (!Number.isFinite(expire)) {
    throw new InterlockError('CONFIG_INVALID', 'The collection expiry is not a date', {
      remedy: 'Pass a valid Date.',
    });
  }
  const startedAt = Date.now();
  const before = await storeSize(shadow, runner, run);

  // Whole seconds since the epoch: exact, where git's date parser reads an
  // ISO string with a `Z` as some other date and prunes nothing.
  const expiry = `@${String(Math.floor(expire / 1000))}`;
  const long: GitRunOptions = { ...run, timeoutMs: COLLECT_TIMEOUT_MS };
  const prune = (): Promise<unknown> =>
    runRequired(runner, shadow, ['prune', `--expire=${expiry}`], long);
  const repack = (): Promise<unknown> =>
    runRequired(
      runner,
      shadow,
      [
        'repack',
        '--cruft',
        `--cruft-expiration=${expiry}`,
        '-d',
        '-l',
        '-q',
        // A bare repository writes a bitmap by default, which needs every
        // reachable object in the pack — and the user's history is not.
        '--no-write-bitmap-index',
      ],
      long,
    );
  if (hasCruftPack(shadow)) {
    await repack();
    await prune();
  } else {
    await prune();
    await repack();
  }
  const after = await storeSize(shadow, runner, run);

  return { before, after, durationMs: Date.now() - startedAt };
}

/** Whether the shadow holds a cruft pack: one with a `.mtimes` table of per-object times. */
function hasCruftPack(shadow: ShadowRepo): boolean {
  try {
    return readdirSync(join(shadow.gitDir, 'objects', 'pack')).some((name) =>
      name.endsWith('.mtimes'),
    );
  } catch {
    return false;
  }
}

/**
 * Whether everything the objects reach can be read.
 *
 * Scoped to stop at the user's branches, whose history is theirs to keep whole:
 * what is walked is what Interlock wrote on top of it — a snapshot commit, its
 * tree, and a parent the user may have rewritten away. Quiet, so a candidate
 * reaching a long stretch of history the user deleted costs a walk and no
 * output to buffer: the first missing object fails it.
 */
async function walkable(
  shadow: ShadowRepo,
  runner: GitRunner,
  oids: readonly string[],
  run: GitRunOptions,
): Promise<boolean> {
  const walk = await runner.run(
    shadow,
    ['rev-list', '--objects', '--quiet', ...oids, '--not', '--remotes=user'],
    run,
  );
  return walk.exitCode === 0;
}

/** Make the keep refs exactly `oids`, one ref each, named by the object. */
async function rewriteKeepRefs(
  shadow: ShadowRepo,
  runner: GitRunner,
  oids: readonly string[],
  run: GitRunOptions,
): Promise<void> {
  const listed = await runRequired(
    runner,
    shadow,
    ['for-each-ref', '--format=%(refname)', KEEP_REFS_PREFIX],
    run,
  );
  const present = new Set(listed.stdout.split('\n').filter((line) => line !== ''));
  const wanted = new Set(oids.map((oid) => `${KEEP_REFS_PREFIX}${oid}`));
  for (const ref of present) {
    // A ref this pass does not want may name an object that is gone, which is
    // the very ref that would stop `prune`; `--no-deref` deletes it unread.
    if (!wanted.has(ref))
      await runRequired(runner, shadow, ['update-ref', '-d', '--no-deref', ref], run);
  }
  for (const oid of oids) {
    const ref = `${KEEP_REFS_PREFIX}${oid}`;
    if (!present.has(ref)) await runRequired(runner, shadow, ['update-ref', ref, oid], run);
  }
}

/** The shadow's own objects, as `count-objects` reports them. */
async function storeSize(
  shadow: ShadowRepo,
  runner: GitRunner,
  run: GitRunOptions,
): Promise<ShadowStoreSize> {
  const counted = await runRequired(runner, shadow, ['count-objects', '-v'], run);
  const field = (name: string): number => {
    const match = new RegExp(`^${name}: (\\d+)$`, 'mu').exec(counted.stdout);
    return match === null ? 0 : Number(match[1]);
  };
  return {
    loose: field('count'),
    packed: field('in-pack'),
    kib: field('size') + field('size-pack'),
  };
}

/** The object store a shadow borrows, as its alternates file names it, or null. */
export function alternatesOf(shadowPath: string): string | null {
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
  // `mkdir` masks the mode it is given with the umask, so the clone's directory
  // is set again rather than trusted. `shadows/`, when this call creates it too,
  // has only the requested mode: 0700 survives any umask that leaves owner bits
  // alone, and one that does not would stop `git init` below regardless.
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

  // Written last: it is what makes the directory this repository's shadow, so a
  // run that dies before this leaves something `isUsableShadow` rebuilds rather
  // than a clone that silently borrows nothing.
  writeFileSync(alternatesFileOf(shadow.rootPath), `${source.objectsDir}\n`);
}

/**
 * Bring the clone's config to what this build expects, writing only what differs.
 *
 * On every refresh rather than once at creation. A key added after a clone was
 * made would otherwise never reach it: the clone passes every other check, and
 * only an unrelated rebuild would apply it. Read in one call, so a clone that is
 * already in order costs one process. Answers the clone's generation, which
 * the same read carries.
 */
async function syncConfig(shadow: ShadowRepo, runner: GitRunner): Promise<string> {
  const listed = await runRequired(runner, shadow, ['config', '--local', '--list', '-z']);
  const current = new Map<string, string>();
  for (const entry of listed.stdout.split('\0')) {
    const newline = entry.indexOf('\n');
    if (newline !== -1) current.set(entry.slice(0, newline), entry.slice(newline + 1));
  }
  for (const [key, value] of SHADOW_CONFIG) {
    // git lists section and key names in lower case, whatever they were set as.
    if (current.get(key.toLowerCase()) !== value) {
      await runRequired(runner, shadow, ['config', key, value]);
    }
  }
  // Set once and never brought into line: a clone keeps its generation for its
  // whole life, and only a new clone — which has none — is given one. A clone
  // from before generations existed gets one here, which is sound because its
  // commits are all still in it.
  const known = current.get(GENERATION_KEY);
  if (known !== undefined && known !== '') return known;
  const generation = ulid();
  await runRequired(runner, shadow, ['config', GENERATION_KEY, generation]);
  return generation;
}
