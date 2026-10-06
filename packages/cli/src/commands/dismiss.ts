import {
  DISMISSAL_REASONS,
  InterlockError,
  dataDirFrom,
  isInterlockError,
} from '@interlock/shared';
import type { DismissalReason } from '@interlock/shared';
import { connectDaemon } from '../client/daemon-client.js';
import { renderDismissal, renderDismissalJson, safeText } from '../render.js';
import type { Command } from './command.js';
import { describeError } from './describe.js';

/**
 * `interlock dismiss <finding> --reason wrong|known` — tell Interlock a Finding
 * is wrong, or known, so it is not raised again while its conflict stands at
 * the same content.
 *
 * A thin client: the daemon records the dismissal, counts it, and holds the
 * conflict to it. Nothing here touches the store.
 */

/** Exit codes: `status`'s and `check`'s, so one binary has one convention. */
const EXIT_OK = 0;
const EXIT_USAGE = 64;
const EXIT_UNAVAILABLE = 69;
const EXIT_SOFTWARE = 70;

const USAGE = [
  'Usage: interlock dismiss <finding id> --reason <wrong|known> [options]',
  '',
  'Dismiss an open Finding. It is not raised again while both sides of its file',
  'are unchanged; once either side changes, it can be raised again.',
  '`interlock check` prints each Finding with its id.',
  '',
  'Reasons:',
  '  wrong               A false positive: there is no conflict. Counted in the',
  '                      false-positive rate `interlock status` shows.',
  '  known               Real, and not worth hearing about again at this content.',
  '',
  'Options:',
  '  --reason <reason>   Why it is dismissed (required)',
  '  --note <text>       A note kept with it, at most 500 characters',
  '  --json              Emit the dismissed Finding as JSON',
  '  --data-dir <path>   Where the daemon keeps its state',
  '  -h, --help          Show this message',
  '',
  'Exit codes: 0 dismissed, 64 bad arguments or a Finding that is unknown,',
  'resolved or dismissed already, 69 daemon unreachable, 70 failed.',
].join('\n');

interface Options {
  readonly id: string;
  readonly reason: DismissalReason;
  readonly note: string | null;
  readonly json: boolean;
  readonly dataDir: string;
  readonly help: boolean;
}

export interface DismissIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly env: Record<string, string | undefined>;
}

const processIo: DismissIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  env: process.env,
};

function usage(message: string): InterlockError {
  return new InterlockError('CONFIG_INVALID', message, {
    remedy: 'Run `interlock dismiss --help` for the arguments this command takes.',
  });
}

function parseArgs(args: readonly string[], env: DismissIo['env']): Options {
  const help = args.includes('--help') || args.includes('-h');
  let dataDir = dataDirFrom(env);
  let json = false;
  let reason: string | null = null;
  let note: string | null = null;
  const ids: string[] = [];
  if (help) return { id: '', reason: 'wrong', note, json, dataDir, help };

  const value = (flag: string, index: number): string => {
    const next = args[index];
    if (next === undefined || next.startsWith('--')) throw usage(`${flag} needs a value`);
    return next;
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--json') json = true;
    else if (arg === '--data-dir') dataDir = value(arg, ++index);
    else if (arg.startsWith('--data-dir=')) dataDir = arg.slice('--data-dir='.length);
    else if (arg === '--reason') reason = value(arg, ++index);
    else if (arg.startsWith('--reason=')) reason = arg.slice('--reason='.length);
    // A note may begin with a dash; only another long option is refused as one.
    else if (arg === '--note') note = value(arg, ++index);
    else if (arg.startsWith('--note=')) note = arg.slice('--note='.length);
    else if (arg.startsWith('-')) throw usage(`Unknown option: ${safeText(arg)}`);
    else ids.push(arg);
  }
  if (ids.length === 0)
    throw usage('Name the Finding to dismiss, by the id `interlock check` prints');
  if (ids.length > 1) throw usage('Dismiss one Finding at a time');
  if (reason === null) {
    throw usage(`Say why with --reason: ${DISMISSAL_REASONS.join(' or ')}`);
  }
  if (!(DISMISSAL_REASONS as readonly string[]).includes(reason)) {
    throw usage(`--reason must be ${DISMISSAL_REASONS.join(' or ')}, not ${safeText(reason)}`);
  }
  if (dataDir === '') throw usage('--data-dir needs a path');
  return { id: ids[0]!, reason: reason as DismissalReason, note, json, dataDir, help };
}

/**
 * What a failure exits with. A Finding that is not there, or not open, is the
 * argument being wrong — a script fixes it by asking about another Finding,
 * not by retrying.
 */
function exitFor(error: unknown): number {
  if (!isInterlockError(error)) return EXIT_SOFTWARE;
  switch (error.code) {
    case 'DAEMON_UNREACHABLE':
      return EXIT_UNAVAILABLE;
    case 'CONFIG_INVALID':
    case 'FINDING_NOT_FOUND':
    case 'FINDING_NOT_DISMISSABLE':
      return EXIT_USAGE;
    case 'API_REQUEST_INVALID':
      // Refused as a bad request; the same code without a 400 is a client and
      // daemon from different builds, which is not the caller's mistake.
      return error.details.status === 400 ? EXIT_USAGE : EXIT_SOFTWARE;
    default:
      return EXIT_SOFTWARE;
  }
}

/** An error, every line escaped: it can echo the id or the reason it was given. */
function describeSafely(error: unknown): string {
  return describeError(error)
    .split('\n')
    .map((line) => safeText(line))
    .join('\n');
}

/** Exported for tests, which drive it with their own streams and environment. */
export async function runDismiss(
  args: readonly string[],
  io: DismissIo = processIo,
): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(args, io.env);
  } catch (error) {
    io.err(`${describeSafely(error)}\n`);
    return EXIT_USAGE;
  }
  if (options.help) {
    io.out(`${USAGE}\n`);
    return EXIT_OK;
  }

  try {
    const client = await connectDaemon(options.dataDir);
    const finding = await client.dismiss(options.id, {
      reason: options.reason,
      note: options.note,
    });
    io.out(options.json ? renderDismissalJson(finding) : renderDismissal(finding));
    return EXIT_OK;
  } catch (error) {
    io.err(`${describeSafely(error)}\n`);
    return exitFor(error);
  }
}

export const dismissCommand: Command = {
  name: 'dismiss',
  summary: 'Dismiss a Finding as wrong or known: dismiss <finding> --reason wrong|known',
  run: (args) => runDismiss(args),
};
