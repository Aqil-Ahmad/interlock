import {
  AGENT_KINDS,
  InterlockError,
  MAX_SESSION_ID_LENGTH,
  MAX_SESSION_PATH_LENGTH,
  dataDirFrom,
} from '@interlock/shared';
import type { AgentKind } from '@interlock/shared';
import { connectDaemon } from '../client/daemon-client.js';
import type { Command } from './command.js';
import { describeError } from './describe.js';

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

/**
 * The most stdin may carry.
 *
 * Generous, because the payload is the agent's and not this command's: a
 * `PostToolUse` carries the tool's input and its response, which for a file
 * write is the file. Two fields are read out of it and each is bounded on its
 * own, so what is posted on is always small whatever arrived.
 */
export const MAX_STDIN_BYTES = 4 * 1024 * 1024;

const USAGE = [
  'Usage: interlock hook <start|activity|end> --kind <agent> [--pid <agent pid>]',
  '',
  'Report an agent session to the daemon. Reads the hook payload from stdin.',
  'Pass --pid $PPID from the shell the agent runs the hook in; without it the',
  'parent of this process is used, which is that shell rather than the agent.',
  '',
  `Agents: ${AGENT_KINDS.join(', ')}`,
  '',
  'Exits 0 unless the arguments are wrong, so a missing daemon never blocks an agent.',
].join('\n');

export interface HookIo {
  readonly stdin: () => Promise<string>;
  /** Whether stdin is a terminal, in which case there is no payload coming. */
  readonly stdinIsTty: boolean;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly env: Record<string, string | undefined>;
  /** The agent is the parent of the hook it runs. */
  readonly parentPid: number;
}

/**
 * A stream to a string, bounded.
 *
 * Exported so the bound is tested against a real stream rather than replaced
 * by every test that stubs stdin.
 */
export function readBounded(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    stream.on('data', (piece: Buffer | string) => {
      // stdin without an encoding set emits buffers; a stream built in a test
      // may emit strings. Counted as bytes either way.
      const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece, 'utf8');
      received += chunk.length;
      if (received > maxBytes) {
        (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        reject(
          new InterlockError('API_REQUEST_INVALID', 'The hook payload is too large', {
            details: { maxBytes },
            remedy: `A hook payload may be at most ${String(maxBytes)} bytes.`,
          }),
        );
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

const processIo: HookIo = {
  stdin: () => readBounded(process.stdin, MAX_STDIN_BYTES),
  stdinIsTty: process.stdin.isTTY === true,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  env: process.env,
  parentPid: process.ppid,
};

interface Options {
  readonly event: HookEvent;
  readonly kind: AgentKind;
  /**
   * The agent's process, as the hook's shell saw it, or `null` to fall back
   * to this process's parent.
   *
   * Agent tools run a hook command through a shell — `sh -c "…"` — so this
   * process's parent is the shell, which exits the moment the hook returns;
   * a session recorded against it is dead within milliseconds and reaped at
   * the next read, with a `session.ended` per tool call. `$PPID` expanded by
   * that shell is the shell's own parent, which is the agent. An agent that
   * runs the command directly never expands it, and the literal falls back.
   */
  readonly pid: number | null;
  readonly help: boolean;
}

function parseArgs(args: readonly string[]): Options {
  if (args.includes('--help') || args.includes('-h')) {
    return { event: 'activity', kind: 'unknown', pid: null, help: true };
  }
  let event: HookEvent | null = null;
  let kind: AgentKind | null = null;
  let pid: number | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if ((EVENTS as readonly string[]).includes(arg) && event === null) {
      event = arg as HookEvent;
    } else if (arg === '--pid' || arg.startsWith('--pid=')) {
      let value: string | undefined;
      if (arg === '--pid') {
        // The next argument is the value only if it is not itself a flag;
        // otherwise `--pid --kind x` would eat `--kind` and then complain
        // that it was missing.
        value = args[index + 1]?.startsWith('-') === false ? args[++index] : undefined;
      } else {
        value = arg.slice('--pid='.length);
      }
      // Not refused when it is not a number: an unexpanded `$PPID` is what an
      // agent that does not use a shell hands over, and the fallback covers it.
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
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
  return { event, kind, pid, help: false };
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
  // The same bounds the daemon holds, applied here first: refused locally
  // with a message rather than by a connection dropped mid-upload.
  if (externalSessionId.length > MAX_SESSION_ID_LENGTH) {
    throw new InterlockError('API_REQUEST_INVALID', 'The hook payload session_id is too long', {
      details: { length: externalSessionId.length, max: MAX_SESSION_ID_LENGTH },
      remedy: `session_id may be at most ${String(MAX_SESSION_ID_LENGTH)} characters.`,
    });
  }
  if (cwd.length > MAX_SESSION_PATH_LENGTH) {
    throw new InterlockError('API_REQUEST_INVALID', 'The hook payload cwd is too long', {
      details: { length: cwd.length, max: MAX_SESSION_PATH_LENGTH },
      remedy: `cwd may be at most ${String(MAX_SESSION_PATH_LENGTH)} characters.`,
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
    io.err(`${describeError(error)}\n`);
    return EXIT_USAGE;
  }
  if (options.help) {
    io.out(`${USAGE}\n`);
    return EXIT_OK;
  }
  if (io.stdinIsTty) {
    // Waiting for a payload from a terminal is waiting for EOF nobody will
    // send. Misuse, and the one failure after bad arguments that is not the
    // agent's, so it exits as such.
    io.err(`${USAGE}\n\nstdin is a terminal; this command reads its payload from a pipe.\n`);
    return EXIT_USAGE;
  }

  try {
    const payload = payloadOf(await io.stdin());
    const client = await connectDaemon(dataDirFrom(io.env));
    await client.registerSession({
      event: options.event,
      kind: options.kind,
      externalSessionId: payload.externalSessionId,
      cwd: payload.cwd,
      pid: options.pid ?? io.parentPid,
      branch: null,
    });
  } catch (error) {
    // Said, not fatal: the agent's work continues whether or not Interlock is
    // there to hear about it.
    io.err(`interlock hook: ${describeError(error)}\n`);
  }
  return EXIT_OK;
}

export const hookCommand: Command = {
  name: 'hook',
  summary: 'Report an agent session event from a hook: hook <start|activity|end> --kind <agent>',
  run: (args) => runHook(args),
};
