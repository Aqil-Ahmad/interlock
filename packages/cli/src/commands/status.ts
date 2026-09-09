import { DEFAULT_DATA_DIR, InterlockError, isInterlockError } from '@interlock/shared';
import { connectDaemon } from '../client/daemon-client.js';
import { renderJson, renderStatus } from '../render.js';
import type { RepoView } from '../render.js';
import type { Command } from './command.js';

/**
 * `interlock status` — what is in flight right now.
 *
 * Read-only and a thin client over the daemon API: it reads no store, runs no
 * git and writes nothing.
 */

/**
 * Exit codes, from sysexits, because `main.ts` already answers an unknown
 * command with 64 and two conventions in one binary is none.
 *
 * `EX_UNAVAILABLE` is the one that earns its place: a script can tell a daemon
 * that is not running from a command that broke, and start one.
 */
const EXIT_OK = 0;
const EXIT_USAGE = 64;
const EXIT_UNAVAILABLE = 69;
const EXIT_SOFTWARE = 70;

const USAGE = [
  'Usage: interlock status [options]',
  '',
  'Show in-flight branches, their dirty state and touched files.',
  '',
  'Options:',
  '  --json              Emit the same facts as JSON',
  '  --data-dir <path>   Where the daemon keeps its state',
  '  -h, --help          Show this message',
  '',
  'Exit codes: 0 ok, 64 bad arguments, 69 daemon unreachable, 70 failed.',
  '',
  'Open findings do not change the exit code; this command reports rather than',
  'gates. Use `interlock check` for that.',
].join('\n');

interface Options {
  readonly json: boolean;
  readonly dataDir: string;
  readonly help: boolean;
}

export interface StatusIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly env: Record<string, string | undefined>;
}

const processIo: StatusIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  env: process.env,
};

/**
 * Where the daemon keeps its state.
 *
 * An argument beats the environment beats the default, so a shell can be
 * pointed at one daemon for a session and a single command can still reach
 * another. Without either, the command can only ever look in one place.
 */
function parseArgs(args: readonly string[], env: StatusIo['env']): Options {
  let json = false;
  let help = false;
  let dataDir = env.INTERLOCK_DATA_DIR ?? DEFAULT_DATA_DIR;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--data-dir') {
      const value = args[++index];
      if (value === undefined || value.startsWith('-')) {
        throw new InterlockError('CONFIG_INVALID', '--data-dir needs a path', {
          remedy: 'Pass the directory the daemon was started with, e.g. --data-dir ~/.interlock',
        });
      }
      dataDir = value;
    } else if (arg.startsWith('--data-dir=')) {
      dataDir = arg.slice('--data-dir='.length);
    } else {
      throw new InterlockError('CONFIG_INVALID', `Unknown option: ${arg}`, {
        remedy: 'Run `interlock status --help` for the options this command takes.',
      });
    }
  }

  if (dataDir === '') {
    throw new InterlockError('CONFIG_INVALID', '--data-dir needs a path', {
      remedy: 'Pass the directory the daemon was started with, e.g. --data-dir ~/.interlock',
    });
  }
  return { json, dataDir, help };
}

/** Exported for tests, which drive it with their own streams and environment. */
export async function runStatus(
  args: readonly string[],
  io: StatusIo = processIo,
): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(args, io.env);
  } catch (error) {
    io.err(`${describe(error)}\n`);
    return EXIT_USAGE;
  }

  if (options.help) {
    io.out(`${USAGE}\n`);
    return EXIT_OK;
  }

  try {
    const client = await connectDaemon(options.dataDir);
    const views: RepoView[] = [];
    for (const repo of await client.repos()) {
      views.push({ repo, branches: await client.branches(repo.id) });
    }
    io.out(options.json ? renderJson(views) : renderStatus(views));
    // Whatever it found. A report that failed the build because it had
    // something to report would be used once and then piped to `true`.
    return EXIT_OK;
  } catch (error) {
    io.err(`${describe(error)}\n`);
    return isInterlockError(error) && error.code === 'DAEMON_UNREACHABLE'
      ? EXIT_UNAVAILABLE
      : EXIT_SOFTWARE;
  }
}

/**
 * The message and, when there is one, the remedy — which is the only part a
 * user can act on and is printed verbatim.
 */
function describe(error: unknown): string {
  if (!isInterlockError(error)) return error instanceof Error ? error.message : String(error);
  return error.remedy === undefined ? error.message : `${error.message}\n\n${error.remedy}`;
}

export const statusCommand: Command = {
  name: 'status',
  summary: 'Show in-flight branches, their dirty state and open findings',
  run: (args) => runStatus(args),
};
