import { execFile } from 'node:child_process';
import { devNull } from 'node:os';
import { InterlockError, redact, silentLogger } from '@interlock/shared';
import type { Logger } from '@interlock/shared';

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

/**
 * Result of running a git command.
 *
 * `stdout` and `stderr` are verbatim. Redaction happens where data leaves the
 * process — logs and stored evidence — because callers parse this output, and
 * rewriting a path or an object id that happens to match a secret pattern would
 * corrupt it silently.
 */
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
  run(repo: AnyRepo, args: readonly string[], options?: GitRunOptions): Promise<GitResult>;
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
 * The subcommand in a git argv, or `null` if there is none.
 *
 * Skips global flags and their values so `git -C /repo commit` resolves to
 * `commit` rather than to `-C`.
 */
function subcommandOf(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (VALUE_TAKING_GLOBAL_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return null;
}

/** True when the given git argv would mutate repository state. */
export function isMutatingCommand(args: readonly string[]): boolean {
  const subcommand = subcommandOf(args);
  return subcommand !== null && MUTATING_GIT_COMMANDS.includes(subcommand);
}

/**
 * Global git flags a caller may not supply.
 *
 * Each one redirects where git operates or which configuration it loads, so
 * accepting them from a caller would let a `UserRepo` handle act on a different
 * repository, or let `-c core.hooksPath=...` run arbitrary code on the host.
 * The runner supplies `-C` itself; anything else here is a programming error.
 */
const RESERVED_GLOBAL_FLAGS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);

/**
 * True when `args` carries a reserved global flag, i.e. one appearing before
 * the subcommand. Flags after the subcommand belong to that subcommand — `-c`
 * means "copy detection" to `git log` — and are left alone.
 */
function usesReservedGlobalFlag(args: readonly string[]): boolean {
  for (const arg of args) {
    if (!arg.startsWith('-')) return false;
    const name = arg.startsWith('--') ? (arg.split('=')[0] ?? arg) : arg;
    if (RESERVED_GLOBAL_FLAGS.has(name)) return true;
  }
  return false;
}

/** Per-invocation overrides. */
export interface GitRunOptions {
  /**
   * Stage into this index file rather than the repository's own, so a snapshot
   * can be built without touching uncommitted work.
   *
   * Deliberately a single named capability rather than an environment map: an
   * open map would let a caller set `GIT_DIR` or `GIT_WORK_TREE` and undo the
   * sanitisation this runner exists to guarantee.
   */
  readonly indexFile?: string;
  readonly timeoutMs?: number;
}

export interface GitRunnerOptions {
  /** Resolved from `PATH` by default; overridden in tests to force a failure. */
  readonly gitPath?: string;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
  readonly logger?: Logger;
}

/**
 * Generous enough for a cold operation on a large repository, short enough that
 * a wedged git cannot hold a scheduler slot indefinitely.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Output is buffered, not streamed, so this bounds a single command's memory.
 * Sized for plumbing output such as a large diff; a command expected to exceed
 * it needs streaming rather than a larger number here.
 */
const DEFAULT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * Build the environment for a git child process.
 *
 * Inherited `GIT_*` variables are dropped rather than passed through: a user's
 * shell exporting `GIT_DIR` or `GIT_INDEX_FILE` would otherwise silently
 * redirect every command the daemon runs, including the ones that write.
 */
function buildEnv(indexFile: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }

  // Fail instead of blocking on a credential prompt that has no terminal.
  env.GIT_TERMINAL_PROMPT = '0';
  // Read commands must never take `index.lock`, or they stall the user's own git.
  env.GIT_OPTIONAL_LOCKS = '0';
  // A user's aliases, hooks or merge drivers must not change what these commands do.
  env.GIT_CONFIG_GLOBAL = devNull;
  env.GIT_CONFIG_SYSTEM = devNull;
  env.GIT_CONFIG_NOSYSTEM = '1';
  // Porcelain output is parsed downstream; locale must not reorder or translate it.
  env.LC_ALL = 'C';
  env.GIT_PAGER = '';

  if (indexFile !== undefined) env.GIT_INDEX_FILE = indexFile;

  return env;
}

function gitFailed(
  message: string,
  details: Record<string, unknown>,
  remedy: string,
): InterlockError {
  return new InterlockError('GIT_COMMAND_FAILED', message, { details, remedy, infra: true });
}

/**
 * Create the single git call site.
 *
 * Every invocation goes through `execFile` with an argument array and no shell,
 * so a branch named `--upload-pack=...` or `; rm -rf ~` arrives as one literal
 * argument. The repository is selected with `-C` rather than `process.chdir`,
 * because the daemon watches several repositories concurrently and the working
 * directory is process-global.
 *
 * A non-zero exit is a result, not an exception — `git merge-tree` reports a
 * conflict that way and `git diff --quiet` reports a difference. This throws
 * only when the command could not be run to completion.
 */
export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const gitPath = options.gitPath ?? 'git';
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const log = (options.logger ?? silentLogger).child('git');

  return {
    run(
      repo: AnyRepo,
      args: readonly string[],
      runOptions: GitRunOptions = {},
    ): Promise<GitResult> {
      const subcommand = subcommandOf(args);

      if (repo.kind === 'user' && isMutatingCommand(args)) {
        return Promise.reject(
          new InterlockError(
            'GIT_COMMAND_FAILED',
            `Refused a mutating git command against a user repository: ${subcommand ?? '<none>'}`,
            {
              details: { rootPath: repo.rootPath, command: subcommand },
              remedy: 'Obtain a ShadowRepo from ensureShadow and run the command against that.',
            },
          ),
        );
      }

      if (usesReservedGlobalFlag(args)) {
        return Promise.reject(
          new InterlockError(
            'GIT_COMMAND_FAILED',
            'Refused a git command carrying a reserved global flag',
            {
              details: { rootPath: repo.rootPath },
              remedy: `The runner supplies the repository itself. Reserved: ${[...RESERVED_GLOBAL_FLAGS].join(', ')}.`,
            },
          ),
        );
      }

      const timeoutMs = runOptions.timeoutMs ?? defaultTimeoutMs;
      const argv = ['-C', repo.rootPath, '--no-pager', ...args];
      const startedAt = Date.now();

      return new Promise<GitResult>((resolve, reject) => {
        execFile(
          gitPath,
          argv,
          {
            env: buildEnv(runOptions.indexFile),
            timeout: timeoutMs,
            maxBuffer,
            windowsHide: true,
            encoding: 'utf8',
          },
          (error, stdout, stderr) => {
            const durationMs = Date.now() - startedAt;

            if (error === null) {
              log.debug('git ok', { args: args.map(redact), exitCode: 0, durationMs });
              resolve({ stdout, stderr, exitCode: 0 });
              return;
            }

            const failure = error as NodeJS.ErrnoException & {
              killed?: boolean;
              signal?: NodeJS.Signals | null;
            };

            if (failure.killed === true || failure.signal != null) {
              log.warn('git timed out', { args: args.map(redact), timeoutMs, durationMs });
              reject(
                gitFailed(
                  `git did not finish within ${String(timeoutMs)}ms`,
                  { timeoutMs, durationMs },
                  'Raise the timeout, or narrow the command.',
                ),
              );
              return;
            }

            if (failure.code === 'ENOENT') {
              log.error('git not found', { gitPath });
              reject(
                gitFailed(
                  'git executable not found',
                  { gitPath },
                  'Install git and make sure it is on PATH.',
                ),
              );
              return;
            }

            if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              log.warn('git output exceeded the buffer', { args: args.map(redact), maxBuffer });
              reject(
                gitFailed(
                  'git produced more output than the runner buffers',
                  { maxBuffer },
                  'Narrow the command, or stream it instead.',
                ),
              );
              return;
            }

            if (typeof failure.code === 'number') {
              log.debug('git non-zero exit', {
                args: args.map(redact),
                exitCode: failure.code,
                durationMs,
              });
              resolve({ stdout, stderr, exitCode: failure.code });
              return;
            }

            log.error('git failed to run', {
              args: args.map(redact),
              reason: failure.code ?? null,
            });
            reject(
              gitFailed(
                'git could not be run',
                { reason: failure.code ?? null },
                'Check that git is installed and the repository path exists.',
              ),
            );
          },
        );
      });
    },
  };
}
