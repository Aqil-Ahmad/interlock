import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { devNull } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
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
 *
 * Both are decoded as UTF-8, so this runner is for text output only. A command
 * whose output is binary, or whose paths are not valid UTF-8, needs a
 * buffer-returning path rather than this one; `-z` plumbing formats keep paths
 * intact but not arbitrary bytes.
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

/**
 * Global git flags, and whether each consumes the argument after it.
 *
 * One table so the two derived uses cannot drift: argv scanning has to skip a
 * flag's value to find the subcommand, and the runner has to refuse the flags
 * that redirect it.
 */
const GLOBAL_FLAGS: ReadonlyMap<
  string,
  { readonly takesValue: boolean; readonly reserved: boolean }
> = new Map([
  ['-C', { takesValue: true, reserved: true }],
  ['-c', { takesValue: true, reserved: true }],
  ['--git-dir', { takesValue: true, reserved: true }],
  ['--work-tree', { takesValue: true, reserved: true }],
  ['--namespace', { takesValue: true, reserved: true }],
  ['--exec-path', { takesValue: true, reserved: true }],
  ['--config-env', { takesValue: true, reserved: true }],
]);

/**
 * Git commands that only read.
 *
 * An allowlist, not a denylist. A denylist of writing verbs fails open on every
 * command it has not heard of — `read-tree --reset` rewrites the index and
 * `update-ref` moves a branch, and neither looks like a write from its name.
 * Anything absent here is refused against a {@link UserRepo}, so an unfamiliar
 * git verb is safe by default rather than dangerous by default.
 *
 * Classification is by verb, plus {@link SAFE_FLAGS} for the four verbs where a
 * flag decides the class. It is not a per-flag audit of every allowed verb:
 * `diff --output=<path>` writes a file and `grep -O <cmd>` runs a program, but
 * argv here is built by Interlock and never supplied by a repository.
 */
export const READ_ONLY_GIT_COMMANDS: ReadonlySet<string> = new Set([
  'blame',
  'cat-file',
  'check-attr',
  'check-ignore',
  'check-ref-format',
  'describe',
  'diff',
  'diff-files',
  'diff-index',
  'diff-tree',
  'for-each-ref',
  'grep',
  'log',
  'ls-files',
  'ls-tree',
  'merge-base',
  'name-rev',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'show-ref',
  'status',
  'var',
  'verify-commit',
  'verify-tag',
  // These read the repository and write only objects. Adding objects is
  // append-only and reclaimed by `git gc`; the plan sanctions it explicitly.
  'hash-object',
  'merge-tree',
  'write-tree',
]);

/**
 * Commands whose read-only form is a specific first operand.
 *
 * The operand must follow the verb immediately, so a writing flag cannot hide
 * behind a reading one.
 */
const READ_ONLY_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['worktree', new Set(['list'])],
  ['stash', new Set(['list', 'show'])],
  ['notes', new Set(['list', 'show'])],
  ['remote', new Set(['show', 'get-url'])],
  ['submodule', new Set(['status'])],
]);

/**
 * Commands that write the index and nothing else a user can see.
 *
 * Permitted against a {@link UserRepo} only when {@link GitRunOptions.indexFile}
 * points the index somewhere outside the repository — which is exactly how a
 * snapshot of uncommitted work is taken without disturbing what is being edited.
 */
const INDEX_WRITING_COMMANDS: ReadonlySet<string> = new Set(['add', 'read-tree', 'update-index']);

interface FlagPolicy {
  /** Permitted short flags, one character each. */
  readonly short: string;
  /** Permitted long flags, spelled in full. */
  readonly long: readonly string[];
}

/**
 * The flags each guarded verb may carry.
 *
 * An allowlist, for the same reason the verb list is one: `read-tree -u` writes
 * the working tree, `read-tree --index-output` overrides `GIT_INDEX_FILE`, and
 * `update-index --split-index` writes into `$GIT_DIR`. A redirected index
 * protects against none of them, and none of them looks like a write.
 *
 * Long flags match by prefix, since git resolves any unambiguous abbreviation:
 * `--i=` is `--index-output=`. That holds only while every name here is a real
 * flag of its verb, which `test/git-runner.test.ts` asserts against `git -h`.
 * Short flags match per character, since git bundles them: `-um` enables `-u`.
 *
 * Keyed by verb because the same letter differs between them — `add -u` is
 * `--update`, `read-tree -u` is not. Flags whose value can begin with `-` are
 * absent rather than special-cased; `--chmod -x` is the only one.
 */
export const SAFE_FLAGS: ReadonlyMap<string, FlagPolicy> = new Map([
  [
    'add',
    {
      short: 'Anuv',
      long: [
        '--all',
        '--dry-run',
        '--ignore-removal',
        '--renormalize',
        '--sparse',
        '--update',
        '--verbose',
      ],
    },
  ],
  [
    'read-tree',
    {
      short: 'imnqv',
      long: [
        '--aggressive',
        '--dry-run',
        '--empty',
        '--exclude-per-directory',
        '--no-sparse-checkout',
        '--prefix',
        '--quiet',
        '--reset',
        '--trivial',
        '--verbose',
      ],
    },
  ],
  [
    'update-index',
    {
      short: 'qz',
      long: [
        '--add',
        '--cacheinfo',
        '--ignore-missing',
        '--ignore-submodules',
        '--index-info',
        '--really-refresh',
        '--refresh',
        '--remove',
        '--stdin',
        '--unmerged',
        '--verbose',
      ],
    },
  ],
  ['symbolic-ref', { short: 'q', long: ['--quiet', '--short'] }],
]);

/**
 * True when a guarded verb carries a flag outside its allowlist.
 *
 * Scanning stops at `--`: everything after it is a pathspec, and a file named
 * `-u` is not a flag.
 */
function usesUnsafeFlag(verb: string, operands: readonly string[]): boolean {
  const policy = SAFE_FLAGS.get(verb);
  if (policy === undefined) return false;

  for (const operand of operands) {
    if (operand === '--') return false;
    if (!operand.startsWith('-') || operand.length < 2) continue;

    if (operand.startsWith('--')) {
      const name = operand.split('=')[0] ?? operand;
      if (!policy.long.some((flag) => flag.startsWith(name))) return true;
      continue;
    }
    if ([...operand.slice(1)].some((char) => !policy.short.includes(char))) return true;
  }
  return false;
}

/**
 * Index of the subcommand in a git argv, or `-1` if there is none.
 *
 * Skips global flags and their values so `git -C /repo commit` resolves to
 * `commit` rather than to `-C`.
 */
function subcommandIndexOf(args: readonly string[]): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (GLOBAL_FLAGS.get(arg)?.takesValue === true) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return i;
  }
  return -1;
}

/** The subcommand in a git argv, or `null` if there is none. */
function subcommandOf(args: readonly string[]): string | null {
  const index = subcommandIndexOf(args);
  return index === -1 ? null : args[index]!;
}

/**
 * How a command may be run against a repository that must not be modified.
 *
 * `index-only` writes the index and nothing else, so it is allowed once that
 * index has been redirected elsewhere.
 */
export type CommandKind = 'read-only' | 'index-only' | 'mutating';

/** Classify a git argv. Anything unrecognised is treated as mutating. */
export function classifyCommand(args: readonly string[]): CommandKind {
  const index = subcommandIndexOf(args);
  if (index === -1) return 'read-only';

  const verb = args[index]!;
  const operands = args.slice(index + 1);

  if (usesUnsafeFlag(verb, operands)) return 'mutating';
  if (READ_ONLY_GIT_COMMANDS.has(verb)) return 'read-only';

  if (READ_ONLY_SUBCOMMANDS.get(verb)?.has(operands[0] ?? '') === true) return 'read-only';

  // `symbolic-ref <name>` reads; `symbolic-ref <name> <ref>` writes.
  if (verb === 'symbolic-ref') {
    const positional = operands.filter((operand) => !operand.startsWith('-'));
    return positional.length <= 1 ? 'read-only' : 'mutating';
  }

  if (INDEX_WRITING_COMMANDS.has(verb)) return 'index-only';

  return 'mutating';
}

/** True when the given git argv would modify anything a user can observe. */
export function isMutatingCommand(args: readonly string[]): boolean {
  return classifyCommand(args) !== 'read-only';
}

/**
 * True when `args` carries a global flag the caller may not supply.
 *
 * Each reserved flag redirects where git operates or which configuration it
 * loads, so accepting one would let a `UserRepo` handle act on a different
 * repository, or let `-c core.hooksPath=...` run code on the host. Flags after
 * the subcommand belong to that subcommand — `-c` means copy detection to
 * `git log` — and are left alone.
 */
function usesReservedGlobalFlag(args: readonly string[]): boolean {
  for (const arg of args) {
    if (!arg.startsWith('-')) return false;
    const name = arg.startsWith('--') ? (arg.split('=')[0] ?? arg) : arg;
    if (GLOBAL_FLAGS.get(name)?.reserved === true) return true;
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
    // Windows matches variable names case-insensitively, so `git_dir` reaches
    // git as `GIT_DIR`. Compare that way everywhere rather than per platform.
    if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  }

  // Fail instead of blocking on a credential prompt that has no terminal.
  env.GIT_TERMINAL_PROMPT = '0';
  // Read commands must never take `index.lock`, or they stall the user's own git.
  env.GIT_OPTIONAL_LOCKS = '0';
  // Neutralises *global and system* config only. Repository-local `.git/config`
  // still applies, and some of its keys run programs — `core.fsmonitor` during
  // `status`, `diff.<driver>.textconv` during `diff`. The runner disables what it
  // can by name below; textconv has no single key to clear, so it stays a
  // residual risk, bounded today because `.git/config` is not cloned and so is
  // not attacker-controlled.
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
 * Why an index redirection is unacceptable, or `null` when it is fine.
 *
 * Without this the capability defeats itself: `indexFile` exists so staging can
 * avoid the user's index, and pointing it back at `.git/index` would write the
 * very file the whole design protects.
 */
function indexRedirectionProblem(repo: UserRepo, indexFile: string | undefined): string | null {
  if (indexFile === undefined) return 'it writes the index, and no indexFile was given';
  if (!isAbsolute(indexFile)) return 'indexFile must be an absolute path';

  const target = realTargetOf(indexFile);
  if (target === null) return 'indexFile is not inside an existing directory';

  for (const inside of protectedDirsOf(repo)) {
    const real = realPathOf(inside);
    if (real === null) return `${inside} could not be resolved`;
    if (isWithin(real, target)) return `indexFile resolves inside ${inside}`;
  }
  return null;
}

/**
 * Every directory an index redirection must stay out of.
 *
 * A linked worktree's git directory is `<main>/.git/worktrees/<name>`, so its
 * handle names neither the main checkout nor `<main>/.git` — and the index a
 * redirection must not overwrite lives in both.
 */
function protectedDirsOf(repo: UserRepo): readonly string[] {
  const dirs = [repo.rootPath, repo.gitDir].filter((dir) => dir !== '');
  const parent = dirname(repo.gitDir);
  if (repo.gitDir !== '' && basename(parent) === 'worktrees') dirs.push(dirname(parent));
  return dirs;
}

function realPathOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Where a write to `indexFile` would actually land.
 *
 * Normalising the path is not enough: a symlink and a platform path alias both
 * make an apparently external path resolve into the repository, and macOS
 * returns `/var/folders/...` from `tmpdir()` for a directory whose real path is
 * `/private/var/folders/...`. The file itself does not exist yet — git creates
 * it — so the directory holding it is what resolves.
 */
function realTargetOf(indexFile: string): string | null {
  const existing = realPathOf(indexFile);
  if (existing !== null) return existing;

  const parent = realPathOf(dirname(indexFile));
  return parent === null ? null : join(parent, basename(indexFile));
}

/**
 * True when `child` is `parent` itself or sits beneath it.
 *
 * The escape has to be a whole `..` segment. Testing the `..` prefix alone reads
 * a sibling named `..foo` as an escape and calls a path inside the repository
 * outside it.
 */
function isWithin(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  if (rel === '' || isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
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
      const kind = classifyCommand(args);

      if (repo.kind === 'user' && kind === 'mutating') {
        return Promise.reject(
          new InterlockError(
            'GIT_COMMAND_REFUSED',
            `Refused a mutating git command against a user repository: ${subcommand ?? '<none>'}`,
            {
              details: { rootPath: repo.rootPath, command: subcommand },
              remedy: 'Obtain a ShadowRepo from ensureShadow and run the command against that.',
            },
          ),
        );
      }

      if (repo.kind === 'user' && kind === 'index-only') {
        const rejection = indexRedirectionProblem(repo, runOptions.indexFile);
        if (rejection !== null) {
          return Promise.reject(
            new InterlockError(
              'GIT_COMMAND_REFUSED',
              `Refused \`git ${subcommand ?? ''}\` against a user repository: ${rejection}`,
              {
                details: { rootPath: repo.rootPath, command: subcommand },
                remedy:
                  'Pass indexFile pointing outside the repository, so staging cannot disturb the index the user is editing.',
              },
            ),
          );
        }
      }

      if (usesReservedGlobalFlag(args)) {
        return Promise.reject(
          new InterlockError(
            'GIT_COMMAND_REFUSED',
            'Refused a git command carrying a reserved global flag',
            {
              details: { rootPath: repo.rootPath },
              remedy:
                'The runner supplies the repository itself; do not pass -C, -c, --git-dir, --work-tree, --namespace, --exec-path or --config-env.',
            },
          ),
        );
      }

      const timeoutMs = runOptions.timeoutMs ?? defaultTimeoutMs;
      // Callers may not pass `-c`, so the runner is free to use it. These clear
      // the repository-local keys that would otherwise run a program during an
      // otherwise read-only command.
      const argv = [
        '-C',
        repo.rootPath,
        '--no-pager',
        '-c',
        'core.fsmonitor=',
        '-c',
        `core.hooksPath=${devNull}`,
        ...args,
      ];
      const startedAt = Date.now();

      return new Promise<GitResult>((resolve, reject) => {
        const child = execFile(
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

            // execFile kills on timeout with SIGTERM. Any other signal came from
            // outside — an OOM kill, an operator — and reporting that as a
            // timeout sends whoever debugs it after an elapsed limit that never
            // elapsed.
            if (failure.killed === true && failure.signal === 'SIGTERM') {
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

            if (failure.signal != null) {
              log.error('git killed by signal', {
                args: args.map(redact),
                signal: failure.signal,
                durationMs,
              });
              reject(
                gitFailed(
                  `git was killed by ${failure.signal}`,
                  { signal: failure.signal, durationMs },
                  'Check for an out-of-memory kill or an external process killer.',
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

        // Nothing writes to the child, so hand it EOF instead of an open pipe.
        // A command that reads stdin — `hash-object --stdin`, `update-index
        // --stdin` — otherwise blocks until the timeout kills it.
        child.stdin?.end();
      });
    },
  };
}
