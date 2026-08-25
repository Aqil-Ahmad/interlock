import { existsSync } from 'node:fs';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import {
  InterlockError,
  isInterlockError,
  MAX_IGNORE_PATTERN_LENGTH,
  MAX_REPO_CONFIG_BYTES,
  parseRepoConfigOverride,
  REPO_CONFIG_FILENAME,
  ulid,
} from '@interlock/shared';
import type {
  BranchRef,
  DirtyState,
  Repo,
  RepoConfigOverride,
  RepoId,
  BranchRefId,
} from '@interlock/shared';
import { subcommandOf } from './repo-handle.js';
import type { AnyRepo, GitResult, GitRunner, UserRepo } from './repo-handle.js';

/**
 * Repo, branch and worktree discovery.
 *
 * Read-only plumbing against the user's repository: `rev-parse`,
 * `for-each-ref`, `worktree list`, `status --porcelain`.
 */

export interface DiscoveryOptions {
  readonly runner: GitRunner;
  /** Branch name globs to ignore, from the repo's config override. */
  readonly ignoreBranches?: readonly string[];
}

/**
 * Discovery options for a call that places files on disk.
 *
 * `dataDir` is required here and absent from {@link DiscoveryOptions}: without
 * it a shadow path resolves against the filesystem root.
 */
export interface DescribeOptions extends DiscoveryOptions {
  /** Root of Interlock's data dir; shadow clones live under it. */
  readonly dataDir: string;
}

/**
 * Run a command whose non-zero exit means the repository is unusable.
 *
 * git's stderr names branches and paths, which is repository content. It stays
 * out of the error: `details` is documented as carrying neither secrets nor
 * file contents, and an `InterlockError` reaches both the API and the agents.
 * The runner logs the failing command through the redacting sink.
 */
async function required(
  runner: GitRunner,
  repo: AnyRepo,
  args: readonly string[],
): Promise<GitResult> {
  const result = await runner.run(repo, args);
  if (result.exitCode !== 0) {
    throw new InterlockError('GIT_COMMAND_FAILED', `git ${subcommandOf(args) ?? ''} failed`, {
      details: { rootPath: repo.rootPath, command: subcommandOf(args), exitCode: result.exitCode },
      remedy: 'Check that the repository is readable and no other git process holds it.',
      infra: true,
    });
  }
  return result;
}

/**
 * A handle good enough to probe a path with.
 *
 * The runner reads only `rootPath`, and the real `gitDir` is what this probe is
 * being used to discover.
 */
function probeHandle(path: string): UserRepo {
  return { kind: 'user', rootPath: path, gitDir: '' };
}

/**
 * Resolve a path to the repository root that contains it.
 *
 * Rejects a bare repository: it has no working tree, so there is no in-flight
 * work to watch and nothing for the watcher to observe.
 *
 * Every path returned here and by {@link listBranchRefs} is canonical — git
 * resolves symlinks, so on macOS a `/var/...` argument comes back as
 * `/private/var/...`. Anything comparing paths against these, the watcher
 * above all, must resolve its own side or the two will never match.
 */
export async function openUserRepo(path: string, options: DiscoveryOptions): Promise<UserRepo> {
  if (!existsSync(path)) {
    throw new InterlockError('REPO_NOT_FOUND', `No such path: ${path}`, {
      details: { path },
      remedy: 'Point Interlock at a directory that exists.',
    });
  }

  const probe = probeHandle(path);
  const bare = await options.runner.run(probe, ['rev-parse', '--is-bare-repository']);
  if (bare.exitCode !== 0) {
    throw new InterlockError('REPO_NOT_GIT', `Not a git repository: ${path}`, {
      details: { path },
      remedy: 'Point Interlock at a directory inside a git repository.',
    });
  }
  if (bare.stdout.trim() === 'true') {
    throw new InterlockError('REPO_BARE', `Repository has no working tree: ${path}`, {
      details: { path },
      remedy:
        'Interlock watches repositories people work in; a bare repository has nothing in flight.',
    });
  }

  // `--show-toplevel` answers with the worktree the path sits in, so a linked
  // worktree would open as a repository of its own — a second `Repo` row and a
  // second shadow clone for work that is already being watched. git lists the
  // main worktree first from anywhere in the repository, and that path is the
  // one identity every worktree agrees on.
  const worktrees = await required(options.runner, probe, [
    'worktree',
    'list',
    '--porcelain',
    '-z',
  ]);
  const main = parseWorktreeList(worktrees.stdout)[0];
  if (main === undefined) {
    throw new InterlockError('REPO_NOT_GIT', `Repository lists no worktree: ${path}`, {
      details: { path },
      remedy: 'Point Interlock at a directory inside a git repository.',
    });
  }

  const gitDir = await required(options.runner, probeHandle(main.path), [
    'rev-parse',
    '--absolute-git-dir',
  ]);

  return { kind: 'user', rootPath: main.path, gitDir: gitDir.stdout.trim() };
}

/**
 * The branch in-flight work is expected to land on.
 *
 * Prefers what `origin` declares, because that is what the team actually merges
 * into, and falls back to the branch HEAD names — which an unborn HEAD still
 * does, so a repository initialised on `trunk` answers `trunk`. The literal
 * `main` is reached only by a detached HEAD with no `origin`, where there is no
 * branch to name.
 *
 * Only `origin` is consulted. A repository whose upstream has another name
 * falls through to HEAD rather than guessing among remotes.
 */
async function resolveDefaultBranch(repo: UserRepo, runner: GitRunner): Promise<string> {
  const remote = await runner.run(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (remote.exitCode === 0) {
    const name = remote.stdout.trim();
    const stripped = name.startsWith('origin/') ? name.slice('origin/'.length) : name;
    if (stripped !== '') return stripped;
  }

  const head = await runner.run(repo, ['symbolic-ref', '--short', 'HEAD']);
  if (head.exitCode === 0 && head.stdout.trim() !== '') return head.stdout.trim();

  return 'main';
}

/**
 * Read repo-level facts for a newly discovered repository: default branch,
 * shadow location, config override.
 *
 * Mints a fresh id, so this describes a first sighting. Recognising a repository
 * already seen is a lookup by `rootPath` in the store, not a second call here.
 */
export async function describeRepo(repo: UserRepo, options: DescribeOptions): Promise<Repo> {
  const defaultBranch = await resolveDefaultBranch(repo, options.runner);
  const config = await readRepoConfig(repo.rootPath);
  const now = new Date().toISOString();
  const id = ulid<RepoId>();

  return {
    id,
    rootPath: repo.rootPath,
    defaultBranch,
    shadowPath: shadowPathFor(id, options.dataDir),
    config,
    discoveredAt: now,
    lastSeenAt: now,
  };
}

/**
 * Flags for opening a file whose path and contents the repository controls.
 *
 * POSIX-only, in line with the rest of this suite. Both flags are security
 * decisions, and on a platform lacking them `O_RDONLY | undefined` degrades to
 * a plain read that follows symlinks and blocks on fifos — so their absence is
 * refused here rather than discovered as a missing defence.
 */
const OPEN_UNTRUSTED = ((): number => {
  const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = constants;
  if (O_NOFOLLOW === undefined || O_NONBLOCK === undefined) {
    throw new InterlockError(
      'CONFIG_INVALID',
      'This platform does not support opening a file without following symlinks',
      { remedy: 'Run Interlock on Linux or macOS.', infra: true },
    );
  }
  return O_RDONLY | O_NONBLOCK | O_NOFOLLOW;
})();

/**
 * Read the repository's override file, or an empty override when there is none.
 *
 * Malformed is refused rather than ignored. The file decides which branches go
 * unexamined, so falling back to the defaults would have Interlock watch work
 * the repository asked it to leave alone, and say nothing about why.
 *
 * The path is repository content and every part of opening it is adversarial.
 * `O_NONBLOCK` is what makes the rest reachable: opening a fifo without it
 * blocks until a writer appears, so a `.interlock.json` created with `mkfifo`
 * wedges discovery before any check runs. `O_NOFOLLOW` refuses a symlink
 * outright — following one reads a file outside the repository, and the key
 * names of whatever it finds come back in the error. `isFile` then rejects what
 * remains: a directory, or a device whose size reads as zero.
 *
 * The read is bounded rather than trusted to `st_size`, which understates the
 * readable length of a procfs file and reads as zero for every one of them.
 */
async function readRepoConfig(rootPath: string): Promise<RepoConfigOverride> {
  const path = join(rootPath, REPO_CONFIG_FILENAME);

  let handle;
  try {
    handle = await open(path, OPEN_UNTRUSTED);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? null;
    if (code === 'ENOENT') return {};
    if (code === 'ELOOP') {
      throw configProblem(path, `${REPO_CONFIG_FILENAME} must not be a symlink`);
    }
    throw configProblem(path, `${REPO_CONFIG_FILENAME} could not be opened`, code);
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw configProblem(path, `${REPO_CONFIG_FILENAME} is not a regular file`);
    }
    return parseRepoConfigOverride(await readCapped(handle, path), path);
  } catch (error) {
    // A read that fails midway is still a problem with this file, and shaping
    // it here keeps every exit from this function the same kind of error.
    if (isInterlockError(error)) throw error;
    throw configProblem(
      path,
      `${REPO_CONFIG_FILENAME} could not be read`,
      (error as NodeJS.ErrnoException).code ?? null,
    );
  } finally {
    // A failure to close a read handle is not actionable, and letting it throw
    // here would replace the diagnostic this function exists to produce.
    await handle.close().catch(() => undefined);
  }
}

/**
 * Read a file whose length is not known in advance.
 *
 * One byte past the ceiling is enough to know the file exceeds it, and reading
 * in a loop is what makes the bound real: a single `read` may return short even
 * when more is available.
 */
async function readCapped(handle: FileHandle, path: string): Promise<string> {
  const buffer = Buffer.allocUnsafe(MAX_REPO_CONFIG_BYTES + 1);
  let filled = 0;

  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }

  if (filled > MAX_REPO_CONFIG_BYTES) {
    throw configProblem(
      path,
      `${REPO_CONFIG_FILENAME} is larger than ${String(MAX_REPO_CONFIG_BYTES)} bytes`,
    );
  }
  return buffer.subarray(0, filled).toString('utf8');
}

/**
 * A problem with the override file itself rather than with its contents.
 *
 * Not `infra`: an unreadable file inside a watched repository is repository
 * state, and the infra flag is for a broken environment.
 */
function configProblem(path: string, message: string, code: string | null = null): InterlockError {
  return new InterlockError('CONFIG_INVALID', message, {
    details: { path, code },
    remedy: `Replace ${path} with a readable JSON file, or delete it to fall back to the global configuration.`,
  });
}

function shadowPathFor(id: RepoId, dataDir: string): string {
  return join(dataDir, 'shadows', id);
}

interface WorktreeEntry {
  readonly path: string;
  readonly ref: string | null;
  readonly prunable: boolean;
  readonly locked: boolean;
}

/**
 * Parse `git worktree list --porcelain -z`.
 *
 * NUL-separated because a worktree path may contain a newline; blocks are
 * terminated by an empty field.
 */
function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let path: string | null = null;
  let ref: string | null = null;
  let prunable = false;
  let locked = false;

  const flush = (): void => {
    if (path !== null) entries.push({ path, ref, prunable, locked });
    path = null;
    ref = null;
    prunable = false;
    locked = false;
  };

  for (const field of stdout.split('\0')) {
    if (field === '') {
      flush();
      continue;
    }
    const space = field.indexOf(' ');
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? '' : field.slice(space + 1);

    if (key === 'worktree') {
      flush();
      path = value;
    } else if (key === 'branch') ref = value;
    else if (key === 'prunable') prunable = true;
    else if (key === 'locked') locked = true;
  }
  flush();

  return entries;
}

/** Two-letter status codes that mark a path as conflicted. */
const UNMERGED_CODES: ReadonlySet<string> = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * Parse `git status --porcelain -z` into staged, unstaged and untracked paths.
 *
 * A rename or copy emits the destination and then the source as two fields, so
 * the source is consumed rather than read as the next entry.
 *
 * A conflicted path counts once, as unstaged: both of its columns are non-blank,
 * so reading them independently would report the same path as staged and
 * unstaged at the same time. Resolving it is what makes it stageable.
 */
function parseStatus(stdout: string): {
  staged: string[];
  unstaged: string[];
  untracked: string[];
} {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  const fields = stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field === undefined || field.length < 4) continue;

    const index = field[0]!;
    const worktree = field[1]!;
    const path = field.slice(3);

    if (index === '?' && worktree === '?') {
      untracked.push(path);
      continue;
    }
    // The source path of a rename or copy, whichever column reported it.
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') i++;

    if (UNMERGED_CODES.has(`${index}${worktree}`)) {
      unstaged.push(path);
      continue;
    }
    if (index !== ' ' && index !== '?') staged.push(path);
    if (worktree !== ' ' && worktree !== '?') unstaged.push(path);
  }

  return { staged, unstaged, untracked };
}

/**
 * Uncommitted work in one worktree.
 *
 * A failed `status` is raised rather than read as an empty result: "clean" is
 * the most dangerous wrong answer here, because nothing downstream looks again
 * at a branch that reported no changes.
 */
async function readDirtyState(worktreePath: string, runner: GitRunner): Promise<DirtyState> {
  const status = await required(runner, probeHandle(worktreePath), ['status', '--porcelain', '-z']);
  const { staged, unstaged, untracked } = parseStatus(status.stdout);

  return {
    isDirty: staged.length + unstaged.length + untracked.length > 0,
    // Content identity is assigned when the working tree is snapshotted.
    snapshotId: null,
    stagedFiles: staged,
    unstagedFiles: unstaged,
    untrackedFiles: untracked,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Match a branch name against a glob supporting `*` and `?`.
 *
 * Deliberately not a full glob implementation: `core` takes no dependencies,
 * and branch ignore rules in practice are `release/*` and `wip-*`.
 *
 * Matched by scanning rather than by translating to a regex. Patterns come from
 * a repository's own config, written by the agents Interlock watches, and the
 * names come from the same repository — so both sides are hostile. A regex
 * translation backtracks exponentially on a pattern that alternates literals
 * with wildcards: `a*a*a…b` against a name of `a`s takes 20 seconds at 33
 * characters, on the event loop, for every branch the pattern is tried against.
 * This scan backtracks to the last `*` only, which bounds it at the product of
 * the two lengths.
 *
 * Both sides are compared by code point, so `?` consumes an astral character
 * whole rather than half a surrogate pair. `*` is tested before a literal match
 * so that it always expands: a name containing a literal `*` would otherwise
 * consume the wildcard meant to span it. Refnames forbid both characters, so
 * this only matters if the matcher is reused on something else.
 */
function matchesGlob(name: string, pattern: string): boolean {
  if (pattern.length > MAX_IGNORE_PATTERN_LENGTH) return false;

  const subject = [...name];
  const glob = [...pattern];
  let subjectIndex = 0;
  let globIndex = 0;
  // Where to resume if the run this `*` is currently claiming turns out to be
  // one character too short.
  let starIndex = -1;
  let resumeIndex = 0;

  while (subjectIndex < subject.length) {
    const globChar = glob[globIndex];
    if (globChar === '*') {
      starIndex = globIndex;
      globIndex++;
      resumeIndex = subjectIndex;
    } else if (globChar === '?' || (globChar !== undefined && globChar === subject[subjectIndex])) {
      globIndex++;
      subjectIndex++;
    } else if (starIndex !== -1) {
      globIndex = starIndex + 1;
      resumeIndex++;
      subjectIndex = resumeIndex;
    } else {
      return false;
    }
  }

  while (glob[globIndex] === '*') globIndex++;
  return globIndex === glob.length;
}

/**
 * List every in-flight line of work: local branches and linked worktrees, each
 * with its head, dirty state and, where known, owning agent session.
 *
 * A worktree with a detached HEAD is skipped: it has no ref to name, and every
 * downstream consumer keys off one. A worktree whose directory has been deleted
 * is skipped too — git still lists it until `worktree prune` runs.
 *
 * Ids are minted per observation. The stable key for a branch is
 * `(repoId, ref)`, and reconciling observations against stored rows belongs to
 * the store rather than here.
 */
export async function listBranchRefs(
  repo: UserRepo,
  repoId: RepoId,
  options: DiscoveryOptions,
): Promise<BranchRef[]> {
  const ignore = options.ignoreBranches ?? [];

  const refs = await required(options.runner, repo, [
    'for-each-ref',
    '--format=%(refname)%09%(objectname)',
    'refs/heads',
  ]);

  const worktrees = await required(options.runner, repo, ['worktree', 'list', '--porcelain', '-z']);
  const byRef = new Map<string, WorktreeEntry>();
  for (const entry of parseWorktreeList(worktrees.stdout)) {
    // A missing directory means two different things depending on the lock.
    // Unlocked, the worktree is garbage awaiting `worktree prune` and holds no
    // observable work. Locked, it is state someone deliberately preserved —
    // which is what a worktree on a removable volume is locked for — so it is
    // unreachable rather than absent, and its dirty state is unknown.
    // `worktree prune` consults the lock; whether `worktree list` annotates
    // both is a porcelain detail that has moved between versions.
    if ((entry.prunable && !entry.locked) || entry.ref === null) continue;
    byRef.set(entry.ref, entry);
  }

  const now = new Date().toISOString();
  const result: BranchRef[] = [];

  // `for-each-ref` prints nothing for an unborn HEAD, which is the correct
  // answer: no branch object exists yet, so nothing is in flight.
  for (const line of refs.stdout.split('\n')) {
    if (line === '') continue;
    const [ref, headSha] = line.split('\t');
    if (ref === undefined || headSha === undefined) continue;

    const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    if (ignore.some((pattern) => matchesGlob(name, pattern))) continue;

    const worktree = byRef.get(ref) ?? null;
    const dirty =
      worktree === null ? cleanState(now) : await tryDirtyState(worktree.path, options.runner);

    result.push({
      id: ulid<BranchRefId>(),
      repoId,
      ref,
      name,
      headSha,
      worktreePath: worktree?.path ?? null,
      dirty,
      sessionId: null,
      firstSeenAt: now,
      updatedAt: now,
    });
  }

  return result;
}

/**
 * Dirty state for one worktree, or `null` where it could not be read.
 *
 * A worktree can be listed and still be unreachable: `git worktree lock` marks
 * one to survive pruning, which is what a worktree on a removable volume is
 * locked for, so a missing directory carries `locked` rather than `prunable`
 * and passes the filter above. Failing the whole repository's listing over one
 * such worktree would take down discovery for every other branch in it, and
 * reporting it clean would be worse — nothing looks again at a branch that
 * reported no changes.
 */
async function tryDirtyState(worktreePath: string, runner: GitRunner): Promise<DirtyState | null> {
  try {
    return await readDirtyState(worktreePath, runner);
  } catch (error) {
    if (isInterlockError(error) && error.code === 'GIT_COMMAND_FAILED') return null;
    throw error;
  }
}

/** A branch with no worktree cannot have uncommitted work. */
function cleanState(now: string): DirtyState {
  return {
    isDirty: false,
    snapshotId: null,
    stagedFiles: [],
    unstagedFiles: [],
    untrackedFiles: [],
    capturedAt: now,
  };
}

/**
 * Merge-base of two refs; the third point of a three-way speculative merge.
 *
 * `null` when the two share no history. That is an ordinary answer for two
 * branches grafted from different roots, not a failure, and a pair without a
 * merge-base is simply not comparable.
 */
export async function mergeBase(
  repo: UserRepo,
  a: string,
  b: string,
  options: DiscoveryOptions,
): Promise<string | null> {
  const result = await options.runner.run(repo, ['merge-base', a, b]);
  // Exit 1 is "no common ancestor". Anything else is a ref git could not
  // resolve, and reporting that as a missing merge-base would drop the pair
  // from analysis without saying why.
  if (result.exitCode === 1) return null;
  if (result.exitCode !== 0) {
    throw new InterlockError('GIT_COMMAND_FAILED', 'git merge-base failed', {
      details: { rootPath: repo.rootPath, exitCode: result.exitCode },
      remedy: 'Check that both refs exist in this repository.',
      infra: true,
    });
  }

  const sha = result.stdout.trim();
  return sha === '' ? null : sha;
}
