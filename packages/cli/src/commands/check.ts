import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { InterlockError, dataDirFrom, isInterlockError } from '@interlock/shared';
import type { Repo } from '@interlock/shared';
import { connectDaemon } from '../client/daemon-client.js';
import type { DaemonClient } from '../client/daemon-client.js';
import { renderCheck, renderCheckJson, safeText } from '../render.js';
import type { Command } from './command.js';
import { describeError } from './describe.js';

/**
 * `interlock check <a> [<b>]` — merge a pair now, and say what is wrong with it.
 *
 * The scriptable pre-merge gate, so unlike `status` its exit code says what it
 * found. A thin client: it finds the repository, asks the daemon to run the
 * pair, and renders the answer. The daemon merges; nothing here runs git.
 */

/**
 * Exit codes. The sysexits ones are `status`'s, so one binary has one
 * convention; `1` is this command's own.
 *
 * `1` for conflicts because a gate needs one, and `git diff --exit-code` and
 * `grep` already taught every script author that 1 means "found something":
 * a clean pair is 0, a pair with Findings is 1, and a check that could not tell
 * is never either.
 */
const EXIT_CLEAN = 0;
const EXIT_CONFLICTS = 1;
const EXIT_USAGE = 64;
const EXIT_UNAVAILABLE = 69;
const EXIT_SOFTWARE = 70;

/** Long enough for a pass over a large repository and a run behind a busy queue. */
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;

const USAGE = [
  'Usage: interlock check <branch> [<other branch>] [options]',
  '',
  'Merge two branches now, as Interlock would, and print what conflicts.',
  'With one branch, checks it against the default branch. The repository is',
  'the one the current directory is in.',
  '',
  'Options:',
  '  --json              Emit the same facts as JSON',
  `  --timeout <s>       Give up after this many seconds (default ${String(DEFAULT_TIMEOUT_S)}, at most ${String(MAX_TIMEOUT_S)})`,
  '  --data-dir <path>   Where the daemon keeps its state',
  '  -h, --help          Show this message',
  '',
  'Exit codes: 0 clean, 1 conflicts found, 64 bad arguments or an unknown',
  'branch, 69 daemon unreachable, 70 failed or timed out.',
].join('\n');

interface Options {
  readonly a: string;
  readonly b: string | null;
  readonly json: boolean;
  readonly timeoutS: number;
  readonly dataDir: string;
  readonly help: boolean;
}

export interface CheckIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly env: Record<string, string | undefined>;
  readonly cwd: () => string;
}

const processIo: CheckIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  env: process.env,
  cwd: () => process.cwd(),
};

function usage(message: string): InterlockError {
  return new InterlockError('CONFIG_INVALID', message, {
    remedy: 'Run `interlock check --help` for the arguments this command takes.',
  });
}

function parseArgs(args: readonly string[], env: CheckIo['env']): Options {
  const help = args.includes('--help') || args.includes('-h');
  let dataDir = dataDirFrom(env);
  let json = false;
  let timeoutS = DEFAULT_TIMEOUT_S;
  const names: string[] = [];
  if (help) return { a: '', b: null, json, timeoutS, dataDir, help };

  const value = (flag: string, index: number): string => {
    const next = args[index];
    if (next === undefined || next.startsWith('-')) throw usage(`${flag} needs a value`);
    return next;
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--json') json = true;
    else if (arg === '--data-dir') dataDir = value(arg, ++index);
    else if (arg.startsWith('--data-dir=')) dataDir = arg.slice('--data-dir='.length);
    else if (arg === '--timeout' || arg.startsWith('--timeout=')) {
      const raw = arg === '--timeout' ? value(arg, ++index) : arg.slice('--timeout='.length);
      const seconds = Number(raw);
      if (!/^\d+$/u.test(raw) || seconds < 1 || seconds > MAX_TIMEOUT_S) {
        throw usage(
          `--timeout must be a whole number of seconds from 1 to ${String(MAX_TIMEOUT_S)}`,
        );
      }
      timeoutS = seconds;
    } else if (arg === '--') {
      // Everything after is a branch name, which may begin with a dash.
      names.push(...args.slice(index + 1));
      break;
    } else if (arg.startsWith('-')) throw usage(`Unknown option: ${safeText(arg)}`);
    else names.push(arg);
  }
  if (names.length === 0) throw usage('Name the branch to check');
  if (names.length > 2) throw usage('Name at most two branches');
  if (dataDir === '') throw usage('--data-dir needs a path');
  return { a: names[0]!, b: names[1] ?? null, json, timeoutS, dataDir, help };
}

/**
 * The repository the current directory is in: its root, or the worktree of one
 * of its branches, by the longest match — the way the daemon places an agent's
 * hook. Real paths on both sides, so a symlinked checkout is still found.
 */
async function repositoryOf(client: DaemonClient, cwd: string): Promise<Repo> {
  let here: string;
  try {
    here = realpathSync(cwd);
  } catch (error) {
    throw new InterlockError('REPO_NOT_FOUND', 'The current directory could not be read', {
      cause: error,
      remedy: 'Run the check from inside a repository the daemon watches.',
    });
  }
  const inside = (root: string): boolean =>
    here === root || here.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };

  let best: { repo: Repo; length: number } | null = null;
  for (const repo of await client.repos()) {
    const roots = [
      repo.rootPath,
      ...(await client.branches(repo.id)).flatMap((branch) =>
        branch.worktreePath === null ? [] : [branch.worktreePath],
      ),
    ].map(real);
    for (const root of roots) {
      if (inside(root) && (best === null || root.length > best.length)) {
        best = { repo, length: root.length };
      }
    }
  }
  if (best === null) {
    throw new InterlockError(
      'REPO_NOT_FOUND',
      'The current directory is in no watched repository',
      {
        details: { cwd: here },
        remedy:
          'Run the check from inside a repository the daemon watches; `interlock status` lists them.',
      },
    );
  }
  return best.repo;
}

/**
 * What a failure exits with: the caller's mistake, no daemon, or anything else.
 *
 * A branch that is not there, two that share no history, a request the daemon
 * refused as malformed, and a directory in no watched repository are all the
 * arguments being wrong for this repository, which a script fixes by asking
 * differently rather than by retrying.
 */
function exitFor(error: unknown): number {
  if (!isInterlockError(error)) return EXIT_SOFTWARE;
  switch (error.code) {
    case 'DAEMON_UNREACHABLE':
      return EXIT_UNAVAILABLE;
    case 'CONFIG_INVALID':
    case 'REPO_NOT_FOUND':
    case 'BRANCH_NOT_FOUND':
    case 'BRANCHES_UNRELATED':
      return EXIT_USAGE;
    case 'API_REQUEST_INVALID':
      // Refused as a bad request; the same code without a 400 is a client and
      // daemon from different builds, which is not the caller's mistake.
      return error.details.status === 400 ? EXIT_USAGE : EXIT_SOFTWARE;
    default:
      return EXIT_SOFTWARE;
  }
}

/**
 * An error, every line escaped: what the daemon says carries branch names the
 * repository chose — an unknown name's remedy lists every branch there is.
 */
function describeSafely(error: unknown): string {
  return describeError(error)
    .split('\n')
    .map((line) => safeText(line))
    .join('\n');
}

/** Exported for tests, which drive it with their own streams, environment and directory. */
export async function runCheck(args: readonly string[], io: CheckIo = processIo): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(args, io.env);
  } catch (error) {
    io.err(`${describeSafely(error)}\n`);
    return EXIT_USAGE;
  }
  if (options.help) {
    io.out(`${USAGE}\n`);
    return EXIT_CLEAN;
  }

  try {
    const client = await connectDaemon(options.dataDir);
    const repo = await repositoryOf(client, io.cwd());
    const report = await client.check(repo.id, {
      a: options.a,
      b: options.b,
      timeoutMs: options.timeoutS * 1000,
    });
    io.out(options.json ? renderCheckJson(report) : renderCheck(report));
    return report.clean ? EXIT_CLEAN : EXIT_CONFLICTS;
  } catch (error) {
    io.err(`${describeSafely(error)}\n`);
    return exitFor(error);
  }
}

export const checkCommand: Command = {
  name: 'check',
  summary: 'Merge two branches now and print what conflicts: check <A> [<B>]',
  run: (args) => runCheck(args),
};
