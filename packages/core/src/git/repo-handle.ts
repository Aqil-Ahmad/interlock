/**
 * Typed handles separating readable user repositories from writable shadows.
 *
 * Mutating functions take a {@link ShadowRepo}, and `ensureShadow` is the only
 * way to obtain one, so a mutation against a user path is a type error rather
 * than something review has to catch.
 */

/** A user's repository. Read-only, always. */
export interface UserRepo {
  readonly kind: 'user';
  readonly rootPath: string;
  readonly gitDir: string;
}

/** Interlock's own clone of a user repo. The only place writes are allowed. */
export interface ShadowRepo {
  readonly kind: 'shadow';
  readonly rootPath: string;
  readonly gitDir: string;
  /** The user repo this shadow mirrors. */
  readonly originPath: string;
}

export type AnyRepo = UserRepo | ShadowRepo;

/** Result of running a git command. `stdout`/`stderr` are already redacted. */
export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Runs git commands against a repository.
 *
 * Implemented over `execFile` with argument arrays, never a shell, so branch
 * names cannot inject commands. Injected rather than imported so tests can
 * drive this layer without a real repo.
 */
export interface GitRunner {
  run(repo: AnyRepo, args: readonly string[]): Promise<GitResult>;
}

/** Commands that are refused against a {@link UserRepo}. Enforced by the runner. */
export const MUTATING_GIT_COMMANDS: readonly string[] = [
  'add',
  'am',
  'apply',
  'branch',
  'checkout',
  'cherry-pick',
  'clean',
  'commit',
  'config',
  'fetch',
  'gc',
  'merge',
  'mv',
  'prune',
  'pull',
  'push',
  'rebase',
  'reset',
  'restore',
  'rm',
  'stash',
  'switch',
  'tag',
  'worktree',
];

/** Global git flags that consume the following argument (`git -C <path> status`). */
const VALUE_TAKING_GLOBAL_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

/**
 * True when the given git argv would mutate repository state.
 *
 * Skips global flags and their values so `git -C /repo commit` is still
 * recognised as a mutation.
 */
export function isMutatingCommand(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (VALUE_TAKING_GLOBAL_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return MUTATING_GIT_COMMANDS.includes(arg);
  }
  return false;
}
