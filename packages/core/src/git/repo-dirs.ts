import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isWithin, runRequired } from './repo-handle.js';
import type { GitRunner, UserRepo } from './repo-handle.js';

/**
 * Every directory that belongs to the repository at `repo`: each of its
 * worktrees, the main one included, and its common git directory.
 *
 * Asked of git rather than derived from a path: a linked worktree names neither
 * the main checkout nor the git directory, a git directory can be kept apart
 * from its checkout, and an object store can be a symlink to somewhere else, so
 * no path joined by hand is reliably any of them. Both answers are read-only.
 *
 * For a git directory kept apart from its checkout, git lists the git directory
 * itself as the main worktree, and nothing it holds names the checkout: seen
 * from a linked worktree, that checkout cannot be found from this side at all.
 * {@link repositoryDirHolding} finds it from the other.
 */
export async function repositoryDirsOf(repo: UserRepo, runner: GitRunner): Promise<string[]> {
  const worktrees = await runRequired(runner, repo, ['worktree', 'list', '--porcelain', '-z']);
  const common = await runRequired(runner, repo, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  return [...parseWorktreeList(worktrees.stdout).map((entry) => entry.path), pathOf(common.stdout)];
}

/**
 * The directory of `dirs` that `path` belongs to, or null if none.
 *
 * By path first, and then by asking git which repository `path` is in, from
 * the deepest part of it that exists. The second answers what the first cannot:
 * a checkout whose git directory is kept apart is named by nothing on the
 * repository's side, but its `.git` file points at the shared git directory, so
 * from inside it git answers with a directory `dirs` holds. Read-only.
 */
export async function repositoryDirHolding(
  path: string,
  dirs: readonly string[],
  runner: GitRunner,
): Promise<string | null> {
  const direct = dirHolding(path, dirs);
  if (direct !== null) return direct;
  // The runner reads nothing from a handle but `rootPath`, and which git
  // directory this is, is what is being asked.
  const probe: UserRepo = { kind: 'user', rootPath: deepestExisting(path)[0], gitDir: '' };
  const answer = await runner.run(probe, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  // Outside every repository, which is where a data dir belongs.
  if (answer.exitCode !== 0) return null;
  const holder = pathOf(answer.stdout);
  return dirHolding(holder, dirs) !== null ? holder : null;
}

/** A path git printed, less the one newline it ends with: the path may end in another. */
function pathOf(stdout: string): string {
  return stdout.replace(/\n$/u, '');
}

/**
 * The directory in `dirs` that `path` would resolve inside, or null if none.
 *
 * `path` need not exist yet, so the deepest part of it that does is what
 * resolves, and the rest is joined back on; each of `dirs` resolves the same
 * way, so a symlink on either side is followed before they are compared.
 */
export function dirHolding(path: string, dirs: readonly string[]): string | null {
  const target = resolveDeepest(path);
  return dirs.find((dir) => isWithin(resolveDeepest(dir), target)) ?? null;
}

/**
 * `path` with its deepest existing ancestor resolved and the rest joined back.
 *
 * Any failure to resolve is read as "does not exist yet", unreadable included:
 * a directory this process cannot read is one it cannot create anything inside
 * either, so the refusal it might have missed is made by `mkdir` instead.
 */
function resolveDeepest(path: string): string {
  const [existing, rest] = deepestExisting(path);
  return join(existing, ...rest);
}

/** The deepest ancestor of `path` that resolves, resolved, and the parts below it. */
function deepestExisting(path: string): [existing: string, rest: string[]] {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return [realpathSync(current), rest];
    } catch {
      const parent = dirname(current);
      if (parent === current) return [path, []];
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

export interface WorktreeEntry {
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
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
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
