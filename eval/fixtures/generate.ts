import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import type { BranchSpec, Fixture, Operation } from './format.js';

/** A fixture built on disk: the repository, and a worktree per branch. */
export interface Built {
  readonly root: string;
  readonly worktrees: { readonly a: string; readonly b: string };
}

/**
 * The environment every fixture's git runs in.
 *
 * No global or system config, so nothing of the machine running the set — an
 * alias, a hook path, `core.autocrlf` — shapes a fixture; and fixed dates, so a
 * fixture's commits are the same objects on every run and every machine.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  LC_ALL: 'C',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

/**
 * Build `fixture` under `dir`, which must exist and be empty.
 *
 * `main` holds the base; branches `a` and `b` start from it, each checked out in
 * a linked worktree, with their committed operations committed and their
 * uncommitted ones left in the worktree — the state the watcher finds.
 */
export function generate(fixture: Fixture, dir: string): Built {
  const root = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', root], { env: GIT_ENV, stdio: 'pipe' });
  git(root, 'config', 'user.name', 'Interlock Eval');
  git(root, 'config', 'user.email', 'eval@example.invalid');
  // Since git 2.47 `commit` detaches a maintenance process that outlives it.
  git(root, 'config', 'maintenance.auto', 'false');
  git(root, 'config', 'gc.auto', '0');
  git(root, 'config', 'commit.gpgsign', 'false');

  for (const [path, content] of Object.entries(fixture.base)) write(root, path, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'base');

  const worktrees = { a: join(dir, 'a'), b: join(dir, 'b') };
  for (const side of ['a', 'b'] as const) {
    git(root, 'worktree', 'add', '-q', '-b', side, worktrees[side], 'main');
    build(worktrees[side], fixture[side]);
  }
  return { root, worktrees };
}

function build(worktree: string, spec: BranchSpec): void {
  if (spec.committed.length > 0) {
    for (const operation of spec.committed) apply(worktree, operation);
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'work');
  }
  for (const operation of spec.uncommitted) apply(worktree, operation);
}

/**
 * Apply one operation to the files alone, as an agent editing them would.
 *
 * Renames included: git finds a rename by content when it diffs, so a `git mv`
 * would record nothing more than moving the file does.
 */
function apply(worktree: string, operation: Operation): void {
  switch (operation.op) {
    case 'write':
      write(worktree, operation.path, operation.content);
      return;
    case 'delete':
      rmSync(inside(worktree, operation.path));
      return;
    case 'rename': {
      const to = inside(worktree, operation.to);
      mkdirSync(join(to, '..'), { recursive: true });
      renameSync(inside(worktree, operation.from), to);
      return;
    }
  }
}

function write(root: string, path: string, content: string): void {
  const target = inside(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}

/** `path` under `root`, refusing one that would land anywhere else. */
function inside(root: string, path: string): string {
  const clean = normalize(path);
  if (isAbsolute(clean) || clean === '..' || clean.startsWith(`..${sep}`)) {
    throw new Error(`fixture path escapes the repository: ${path}`);
  }
  return join(root, clean);
}
