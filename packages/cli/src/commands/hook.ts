import { AGENT_KINDS, InterlockError, dataDirFrom, isInterlockError } from '@interlock/shared';
import type { AgentKind } from '@interlock/shared';
import { connectDaemon } from '../client/daemon-client.js';
import type { Command } from './command.js';

/**
 * `interlock hook <event> --kind <agent>` — what an agent's hook runs.
 *
 * Reads the agent's own hook payload from stdin, adds what the daemon needs
 * that the payload lacks — which agent this is, and its process — and posts.
 * Finding the daemon and authenticating happen the way `status` does them, so
 * the token and the port never appear in a hook file that lives in the
 * repository.
 *
 * A hook must never get in the agent's way. Every failure short of misuse
 * exits 0: a daemon that is down is not the agent's problem, and an agent tool
 * that treats a non-zero hook as a reason to block a tool call would be blocked
 * by Interlock being absent.
 */

const EVENTS = ['start', 'activity', 'end'] as const;
type HookEvent = (typeof EVENTS)[number];

const EXIT_OK = 0;
const EXIT_USAGE = 64;

/** The most stdin may carry; a hook payload is a few short fields. */
const MAX_STDIN_BYTES = 64 * 1024;

const USAGE = [
  'Usage: interlock hook <start|activity|end> --kind <agent>',
  '',
  'Report an agent session to the daemon. Reads the hook payload from stdin.',
  '',
  `Agents: ${AGENT_KINDS.join(', ')}`,
  '',
  'Exits 0 unless the arguments are wrong, so a missing daemon never blocks an agent.',
].join('\n');

export interface HookIo {
  readonly stdin: () => Promise<string>;
  readonly err: (text: string) => void;
  readonly env: Record<string, string | undefined>;
  /** The agent is the parent of the hook it runs. */
  readonly parentPid: number;
}

const readStdin = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    process.stdin.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_STDIN_BYTES) {
        process.stdin.destroy();
        reject(new Error('hook payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });

const processIo: HookIo = {
  stdin: readStdin,
  err: (text) => process.stderr.write(text),
  env: process.env,
  parentPid: process.ppid,
};

interface Options {
  readonly event: HookEvent;
  readonly kind: AgentKind;
  readonly help: boolean;
}

function parseArgs(args: readonly string[]): Options {
  if (args.includes('--help') || args.includes('-h')) {
    return { event: 'activity', kind: 'unknown', help: true };
  }
  let event: HookEvent | null = null;
  let kind: AgentKind | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if ((EVENTS as readonly string[]).includes(arg) && event === null) {
      event = arg as HookEvent;
    } else if (arg === '--kind') {
      const value = args[++index];
      if (value === undefined || !(AGENT_KINDS as readonly string[]).includes(value)) {
        throw usage(`--kind must be one of ${AGENT_KINDS.join(', ')}`);
      }
      kind = value as AgentKind;
    } else if (arg.startsWith('--kind=')) {
      const value = arg.slice('--kind='.length);
      if (!(AGENT_KINDS as readonly string[]).includes(value)) {
        throw usage(`--kind must be one of ${AGENT_KINDS.join(', ')}`);
      }
      kind = value as AgentKind;
    } else {
      throw usage(`Unknown argument: ${arg}`);
    }
  }
  if (event === null) throw usage(`The event must be one of ${EVENTS.join(', ')}`);
  if (kind === null) throw usage('--kind is required');
  return { event, kind, help: false };
}

function usage(message: string): InterlockError {
  return new InterlockError('CONFIG_INVALID', message, {
    remedy: 'Run `interlock hook --help` for the arguments this command takes.',
  });
}

/**
 * The fields every agent's hook payload is read for.
 *
 * Claude Code sends `session_id` and `cwd`; the shape is small enough that
 * the same two names are what any agent is asked to provide. Everything else in
 * the payload is the agent's business and is not forwarded.
 */
function payloadOf(text: string): { externalSessionId: string; cwd: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text === '' ? '{}' : text);
  } catch {
    throw new InterlockError('API_REQUEST_INVALID', 'The hook payload on stdin is not JSON', {
      remedy: 'This command is meant to be run by an agent hook, which pipes its payload in.',
    });
  }
  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  const externalSessionId = record.session_id;
  const cwd = record.cwd;
  if (typeof externalSessionId !== 'string' || externalSessionId === '') {
    throw new InterlockError('API_REQUEST_INVALID', 'The hook payload has no session_id', {
      remedy: 'This command is meant to be run by an agent hook, which pipes its payload in.',
    });
  }
  if (typeof cwd !== 'string' || cwd === '') {
    throw new InterlockError('API_REQUEST_INVALID', 'The hook payload has no cwd', {
      remedy: 'This command is meant to be run by an agent hook, which pipes its payload in.',
    });
  }
  return { externalSessionId, cwd };
}

/** Exported for tests, which drive it with their own stdin and environment. */
export async function runHook(args: readonly string[], io: HookIo = processIo): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(args);
  } catch (error) {
    io.err(`${describe(error)}\n`);
    return EXIT_USAGE;
  }
  if (options.help) {
    io.err(`${USAGE}\n`);
    return EXIT_OK;
  }

  try {
    const payload = payloadOf(await io.stdin());
    const client = await connectDaemon(dataDirFrom(io.env));
    await client.registerSession({
      event: options.event,
      kind: options.kind,
      externalSessionId: payload.externalSessionId,
      cwd: payload.cwd,
      pid: io.parentPid,
      branch: null,
    });
  } catch (error) {
    // Said, not fatal: the agent's work continues whether or not Interlock is
    // there to hear about it.
    io.err(`interlock hook: ${describe(error)}\n`);
  }
  return EXIT_OK;
}

function describe(error: unknown): string {
  if (!isInterlockError(error)) return error instanceof Error ? error.message : String(error);
  return error.remedy === undefined
    ? `${error.code}: ${error.message}`
    : `${error.code}: ${error.message}\n\n${error.remedy}`;
}

export const hookCommand: Command = {
  name: 'hook',
  summary: 'Report an agent session event from a hook: hook <start|activity|end> --kind <agent>',
  run: (args) => runHook(args),
};
