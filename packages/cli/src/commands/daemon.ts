import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import {
  INTERLOCK_PROTOCOL_VERSION,
  InterlockError,
  dataDirFrom,
  isInterlockError,
  loadConfig,
  logPath,
  runtimePath,
  tokenPath,
} from '@interlock/shared';
import type { Logger } from '@interlock/shared';
import type { PurgeReport } from '@interlock/daemon';
import { autostartInstalled, disableAutostart, enableAutostart } from '../autostart.js';
import type * as DaemonPackage from '@interlock/daemon';
import { launchNode, runServiceManager } from '../processes.js';
import type { AutostartContext, AutostartRunner } from '../autostart.js';
import { safeJson, safeText } from '../render.js';
import type { Command } from './command.js';
import { describeError } from './describe.js';

/**
 * `interlock daemon` — run the daemon in the background, and turn it off.
 *
 * Who is running is decided by the data-dir hold, which the kernel releases
 * however the daemon dies, and never by the runtime file, which a crash leaves
 * behind naming a pid the system may since have handed to something else. A
 * daemon counts as running when the hold is held, its API answers the token,
 * and the pid the API reports is the one the runtime file names. Anything less
 * is said as it is, and nothing is signalled on it.
 *
 * The daemon package is loaded only here and only when a subcommand runs: it
 * owns the hold and the purge, and the hook every agent runs on every turn
 * should not pay to load it.
 */

/** sysexits, as every other command answers. */
const EXIT_OK = 0;
const EXIT_USAGE = 64;
const EXIT_UNAVAILABLE = 69;
const EXIT_SOFTWARE = 70;

const EXIT_CODES = 'Exit codes: 0 ok, 64 bad arguments, 69 daemon unavailable, 70 failed.';

const USAGE = [
  'Usage: interlock daemon <start|stop|status|logs|autostart> [options]',
  '',
  'Run the Interlock daemon in the background for the data directory named by',
  'INTERLOCK_DATA_DIR (default ~/.interlock), and turn it off.',
  '',
  'Commands:',
  '  start                Start the daemon detached, logging to the data directory',
  '  stop                 Stop it, and wait until it has exited',
  '  stop --purge         Stop it and delete everything Interlock stored',
  '  status               Say whether it is running, and where',
  '  logs                 Print its log',
  '  autostart on|off     Start it now and at login, or stop it and undo that',
  '',
  'Run `interlock daemon <command> --help` for a command’s options.',
  '',
  EXIT_CODES,
].join('\n');

const HELP: Record<string, string> = {
  start: [
    'Usage: interlock daemon start',
    '',
    'Start the daemon detached from this terminal, with its log in the data',
    'directory, and return once it answers. A daemon already running is left',
    'as it is. A daemon that fails to start has its own error printed.',
    '',
    EXIT_CODES,
    '69 also means a process holds the data directory without answering as its',
    'daemon.',
  ].join('\n'),
  stop: [
    'Usage: interlock daemon stop [--purge [--yes]]',
    '',
    'Stop the daemon and wait until it has exited. Only a process confirmed to',
    'be this data directory’s daemon is signalled.',
    '',
    'Options:',
    '  --purge     Also remove autostart and delete the data directory: the',
    '              database, token, runtime file, logs, shadow clones and',
    '              worktree pool. Asks first.',
    '  --yes       Purge without asking; required without a terminal',
    '  -h, --help  Show this message',
    '',
    EXIT_CODES,
    '64 also means a purge was refused: the directory is not Interlock’s, is',
    'the home directory or the root, or sits inside a watched repository.',
  ].join('\n'),
  status: [
    'Usage: interlock daemon status [--json]',
    '',
    'Say whether the daemon is running. When it is: its pid, port, uptime,',
    'data directory and protocol version, and a warning when that protocol is',
    'not the one this command speaks.',
    '',
    'Options:',
    '  --json      Emit the same facts as JSON',
    '  -h, --help  Show this message',
    '',
    'Exit codes: 0 running, 69 not running, 64 bad arguments, 70 failed.',
  ].join('\n'),
  logs: [
    'Usage: interlock daemon logs [-n <lines>] [--follow] [--json]',
    '',
    'Print the daemon’s log, with every field escaped for the terminal.',
    '',
    'Options:',
    '  -n <lines>    How many of the last lines to print (default 100)',
    '  -f, --follow  Keep printing lines as they are written',
    '  --json        Print the records as JSON, one per line',
    '  -h, --help    Show this message',
    '',
    EXIT_CODES,
    '69 also means there is no log: no daemon was started in the background here.',
  ].join('\n'),
  autostart: [
    'Usage: interlock daemon autostart on|off',
    '',
    'Install a login item that starts the daemon for this data directory — a',
    'launchd agent on macOS, a systemd user unit on Linux — or remove it.',
    '',
    '`on` starts the daemon now as well as at login; `off` stops a daemon the',
    'item started, as well as removing it.',
    '',
    EXIT_CODES,
  ].join('\n'),
};

/** Lines `logs` prints when not told how many. */
const DEFAULT_LOG_LINES = 100;
/** How long `start` waits for the daemon to answer before giving up on it. */
const START_TIMEOUT_MS = 30_000;
/** How long `stop` waits for it to exit. Not escalated to `SIGKILL`: that is a decision. */
const STOP_TIMEOUT_MS = 30_000;
/** A health request to a daemon on this machine; anything near it is a daemon in trouble. */
const HEALTH_TIMEOUT_MS = 2_000;
const POLL_MS = 100;
/** How often `logs --follow` looks for more. */
const FOLLOW_POLL_MS = 250;

export interface DaemonIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly env: Record<string, string | undefined>;
  /** Whether a person is there to answer a question. */
  readonly interactive: boolean;
  /** Ask one question and answer the line typed back. */
  readonly ask: (question: string) => Promise<string>;
  /**
   * How to run the daemon: an executable and its arguments, to which
   * `--log-to-file` is appended. The node binary and the built entry point,
   * unless a test runs the source.
   */
  readonly launch: () => { readonly command: string; readonly args: readonly string[] };
  /** Where autostart is installed and how its commands run. */
  readonly autostart: {
    readonly platform: NodeJS.Platform;
    readonly home: string;
    readonly uid: number;
    readonly run: AutostartRunner;
  };
  readonly home: string;
  readonly kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Ends `logs --follow`. */
  readonly stopped: () => AbortSignal;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

/** The daemon's built entry point, beside the module the package exports. */
function daemonEntry(): string {
  return fileURLToPath(new URL('./main.js', import.meta.resolve('@interlock/daemon')));
}

const processIo: DaemonIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  env: process.env,
  interactive: process.stdin.isTTY && process.stdout.isTTY,
  ask: async (question) => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await prompt.question(question);
    } finally {
      prompt.close();
    }
  },
  launch: () => ({ command: process.execPath, args: [daemonEntry()] }),
  autostart: {
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    run: runServiceManager,
  },
  home: homedir(),
  kill: (pid, signal) => process.kill(pid, signal),
  stopped: () => {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    return controller.signal;
  },
};

/** Marked, so the exit code says bad arguments rather than a config that failed. */
function usage(message: string, remedy: string): InterlockError {
  return new InterlockError('CONFIG_INVALID', message, { remedy, details: { usage: true } });
}

/** What the runtime file says, when it says something a client can use. */
interface Published {
  readonly port: number;
  readonly pid: number;
}

/** What `GET /api/health` answers. */
interface Health {
  readonly protocolVersion: number;
  readonly pid: number;
  readonly startedAt: string;
}

/** Whether this data dir's daemon is running, and the evidence for the answer. */
type Probe =
  | { readonly state: 'running'; readonly port: number; readonly health: Health }
  | { readonly state: 'stopped'; readonly stale: boolean }
  | { readonly state: 'unconfirmed'; readonly reason: string };

function readPublished(dataDir: string): Published | null {
  try {
    const parsed = JSON.parse(readFileSync(runtimePath(dataDir), 'utf8')) as Partial<Published>;
    const { port, pid } = parsed;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return null;
    }
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) return null;
    return { port, pid };
  } catch {
    return null;
  }
}

function readToken(dataDir: string): string | null {
  try {
    const token = readFileSync(tokenPath(dataDir), 'utf8').trim();
    return token === '' ? null : token;
  } catch {
    return null;
  }
}

async function health(port: number, token: string): Promise<Health | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<Health> | null;
    if (
      typeof body?.pid !== 'number' ||
      typeof body.protocolVersion !== 'number' ||
      typeof body.startedAt !== 'string'
    ) {
      return null;
    }
    return { pid: body.pid, protocolVersion: body.protocolVersion, startedAt: body.startedAt };
  } catch {
    return null;
  }
}

/**
 * Ask whether the daemon is running, two ways, and believe only agreement.
 *
 * The API reporting the pid the runtime file names is what makes the pid
 * safe to signal; the hold being held is what makes the API's answer this
 * data dir's. Either alone can be fooled — a stale file naming a reused pid,
 * or another daemon answering on a port this one once had.
 */
async function probe(dataDir: string): Promise<Probe> {
  const { isDataDirHeld } = await import('@interlock/daemon');
  const held = isDataDirHeld(dataDir);
  // Before the token is sent anywhere: with no daemon holding the directory,
  // whatever answers on the port it last published is not this one.
  if (!held) return { state: 'stopped', stale: existsSync(runtimePath(dataDir)) };
  const published = readPublished(dataDir);
  const token = readToken(dataDir);
  const answer = published !== null && token !== null ? await health(published.port, token) : null;

  if (published === null) {
    return { state: 'unconfirmed', reason: 'it has published no port' };
  }
  if (answer === null) {
    return {
      state: 'unconfirmed',
      reason: `nothing answered as its daemon on port ${String(published.port)}`,
    };
  }
  if (answer.pid !== published.pid) {
    return {
      state: 'unconfirmed',
      reason: `the daemon on port ${String(published.port)} is pid ${String(answer.pid)}, not the pid ${String(published.pid)} it published`,
    };
  }
  return { state: 'running', port: published.port, health: answer };
}

function unconfirmed(dataDir: string, reason: string): string {
  return `A process holds ${safeText(dataDir)}, but ${safeText(reason)}. Nothing was signalled.\nIt may still be starting; try again in a moment. If it persists, find the process holding ${safeText(dataDir)}/daemon.lock.\n`;
}

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exported for tests, which drive it with their own streams, environment and launcher. */
export async function runDaemon(
  args: readonly string[],
  io: DaemonIo = processIo,
): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === '--help' || sub === '-h') {
    io.out(`${USAGE}\n`);
    return sub === undefined ? EXIT_USAGE : EXIT_OK;
  }
  // Own keys only: `toString` is not a subcommand.
  const help = Object.hasOwn(HELP, sub) ? HELP[sub] : undefined;
  if (help === undefined) {
    io.err(`Unknown daemon command: ${safeText(sub)}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    io.out(`${help}\n`);
    return EXIT_OK;
  }

  let dataDir: string;
  try {
    dataDir = dataDirFrom(io.env);
  } catch (error) {
    io.err(`${describeError(error)}\n`);
    return EXIT_USAGE;
  }

  try {
    switch (sub) {
      case 'start':
        expectNoOptions(sub, rest);
        return await start(dataDir, io);
      case 'stop': {
        const options = flags(sub, rest, ['--purge', '--yes']);
        if (options.has('--yes') && !options.has('--purge')) {
          throw usage('--yes is for --purge', 'Run `interlock daemon stop --purge --yes`.');
        }
        return options.has('--purge')
          ? await purge(dataDir, io, options.has('--yes'))
          : await stop(dataDir, io);
      }
      case 'status':
        return await status(dataDir, io, flags(sub, rest, ['--json']).has('--json'));
      case 'logs':
        return await logs(dataDir, io, parseLogs(rest));
      default:
        return await autostart(dataDir, io, rest);
    }
  } catch (error) {
    io.err(`${describeError(error)}\n`);
    if (!isInterlockError(error)) return EXIT_SOFTWARE;
    if (error.details.usage === true || error.code === 'PURGE_REFUSED') return EXIT_USAGE;
    return EXIT_SOFTWARE;
  }
}

function expectNoOptions(sub: string, rest: readonly string[]): void {
  flags(sub, rest, []);
}

function flags(sub: string, rest: readonly string[], allowed: readonly string[]): Set<string> {
  for (const arg of rest) {
    if (!allowed.includes(arg)) {
      throw usage(
        `Unknown option: ${arg}`,
        `Run \`interlock daemon ${sub} --help\` for the options it takes.`,
      );
    }
  }
  return new Set(rest);
}

interface LogOptions {
  readonly lines: number;
  readonly follow: boolean;
  readonly json: boolean;
}

function parseLogs(rest: readonly string[]): LogOptions {
  let lines = DEFAULT_LOG_LINES;
  let follow = false;
  let json = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (arg === '--follow' || arg === '-f') follow = true;
    else if (arg === '--json') json = true;
    else if (arg === '-n' || arg === '--lines') {
      const value = rest[++index];
      // Digits only: `Number` would take `1e3`, `0x10` and ` 5 `.
      if (value === undefined || !/^\d+$/u.test(value)) {
        throw usage('-n needs a number of lines', 'Pass a whole number, e.g. -n 50.');
      }
      lines = Number(value);
    } else {
      throw usage(
        `Unknown option: ${arg}`,
        'Run `interlock daemon logs --help` for the options it takes.',
      );
    }
  }
  return { lines, follow, json };
}

/**
 * Create the data dir, owner-only, as the daemon would.
 *
 * The daemon refuses a data dir inside a watched repository before it writes
 * anything, and what is written here — the log file, or the one a login item
 * has its service manager open — would be the first thing there. So the same
 * question is asked first, from the same config. A config that does not load is
 * reported here, as the daemon would report it: there is no telling which
 * repositories it would have named.
 */
async function prepareDataDir(dataDir: string, io: DaemonIo): Promise<typeof DaemonPackage> {
  const config = loadConfig(dataDir);
  const daemon = await import('@interlock/daemon');
  await daemon.refuseDataDirInRepos(dataDir, config.repos);
  daemon.ensureDataDir(dataDir, warningsTo(io));
  return daemon;
}

async function start(dataDir: string, io: DaemonIo): Promise<number> {
  const before = await probe(dataDir);
  if (before.state === 'running') {
    io.out(
      `The daemon is already running: pid ${String(before.health.pid)}, port ${String(before.port)}, data dir ${safeText(dataDir)}\n`,
    );
    return EXIT_OK;
  }
  if (before.state === 'unconfirmed') {
    io.err(unconfirmed(dataDir, before.reason));
    return EXIT_UNAVAILABLE;
  }

  const daemon = await prepareDataDir(dataDir, io);
  // What a crash may have left: there before the launch, so not this start's.
  const leftover = readPublished(dataDir);
  const path = logPath(dataDir);
  const log = daemon.openLogFile(path);
  // Where this start's records begin, so a failure is read from them and not
  // from a previous run's.
  const offset = fstatSync(log).size;
  const { command, args } = io.launch();
  // The daemon runs on the node running this: the one binary started here.
  if (command !== process.execPath) throw new TypeError(`Not the running node: ${command}`);
  let child: ReturnType<typeof launchNode>;
  try {
    // Its stderr too: what it writes before it has a logger — the error it
    // dies of at start — is the record this reads back.
    child = launchNode([...args, '--log-to-file'], log, {
      ...io.env,
      INTERLOCK_DATA_DIR: dataDir,
    });
  } finally {
    closeSync(log);
  }
  // Held in an object: a `let` assigned only in a callback reads as forever null.
  const outcome: { exited: Exit | null } = { exited: null };
  child.once('exit', (code, signal) => {
    outcome.exited = { code, signal };
  });
  const spawnError = new Promise<Error>((resolve) => child.once('error', resolve));

  const deadline = Date.now() + (io.startTimeoutMs ?? START_TIMEOUT_MS);
  for (;;) {
    const failed = await Promise.race([spawnError, wait(POLL_MS).then(() => null)]);
    if (failed !== null) {
      throw new InterlockError('DAEMON_START_FAILED', 'The daemon could not be launched', {
        cause: failed,
        details: { command },
        remedy: failed.message,
      });
    }
    if (outcome.exited !== null) return reportDeath(path, offset, outcome.exited, io);
    const now = await probe(dataDir);
    if (now.state === 'running' && now.health.pid === child.pid) {
      io.out(
        `The daemon started: pid ${String(now.health.pid)}, port ${String(now.port)}, data dir ${safeText(dataDir)}\n`,
      );
      return EXIT_OK;
    }
    if (Date.now() > deadline) {
      // Held, nothing published by this start, and ours still alive: past its checks and
      // into its first pass over the repositories, which publishes the
      // runtime file only once done, and on a large setup outlasts any wait
      // worth making here. Slow, not stuck — left to finish. A daemon that has
      // published is another one, and is not claimed.
      const current = readPublished(dataDir);
      const unpublished =
        current === null ||
        (leftover !== null && current.pid === leftover.pid && current.port === leftover.port);
      if (
        child.pid !== undefined &&
        outcome.exited === null &&
        now.state === 'unconfirmed' &&
        unpublished
      ) {
        io.err(
          `The daemon (pid ${String(child.pid)}) is still starting.\n\nRun \`interlock daemon status\` to see when it is up, \`interlock daemon logs\` for what it is doing, or \`interlock daemon stop\` to stop it.\n`,
        );
        return EXIT_UNAVAILABLE;
      }
      // Ours, by pid, from the spawn itself: the one process this may signal
      // without asking anyone.
      if (child.pid !== undefined && outcome.exited === null) io.kill(child.pid, 'SIGTERM');
      throw new InterlockError('DAEMON_START_FAILED', 'The daemon did not answer in time', {
        details: { dataDir, timeoutMs: io.startTimeoutMs ?? START_TIMEOUT_MS },
        remedy: `It was stopped. See \`interlock daemon logs\` for what it was doing.`,
      });
    }
  }
}

/** The daemon package warns through a logger; here a warning is a line on stderr. */
function warningsTo(io: DaemonIo): Logger {
  const warn = (msg: string, fields?: Record<string, unknown>): void => {
    io.err(
      `warning: ${safeText(msg)}${typeof fields?.path === 'string' ? `: ${safeText(fields.path)}` : ''}\n`,
    );
  };
  const logger: Logger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn,
    error: warn,
    child: () => logger,
  };
  return logger;
}

/**
 * Say why the daemon died, in its own words.
 *
 * `main.ts` writes one JSON record as its last line when it fails at start,
 * carrying the message, the code and the remedy; the last error record since
 * the spawn is that one.
 */
function reportDeath(path: string, offset: number, exited: Exit, io: DaemonIo): number {
  let record: { msg?: unknown; code?: unknown; remedy?: unknown } | null = null;
  for (const line of readFrom(path, offset).split('\n').reverse()) {
    const parsed = parseRecord(line);
    if (parsed !== null && parsed.level === 'error') {
      record = parsed;
      break;
    }
  }
  const how =
    exited.signal === null ? `exited ${String(exited.code)}` : `was killed by ${exited.signal}`;
  if (record === null) {
    io.err(
      `The daemon ${how} before it was up, and logged no reason.\n\nSee \`interlock daemon logs\`.\n`,
    );
    return EXIT_SOFTWARE;
  }
  const code = typeof record.code === 'string' ? `${safeText(record.code)}: ` : '';
  const message = typeof record.msg === 'string' ? safeText(record.msg) : 'no message';
  const remedy = typeof record.remedy === 'string' ? `\n\n${safeText(record.remedy)}` : '';
  io.err(`The daemon ${how} before it was up.\n\n${code}${message}${remedy}\n`);
  return EXIT_SOFTWARE;
}

function readFrom(path: string, offset: number): string {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return '';
  }
  // A rotation since the spawn leaves a file shorter than the offset; then
  // all of it is this run's.
  return Buffer.byteLength(text) < offset
    ? text
    : Buffer.from(text).subarray(offset).toString('utf8');
}

function parseRecord(line: string): Record<string, unknown> | null {
  if (!line.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function alive(pid: number, io: DaemonIo): boolean {
  try {
    io.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: there, and someone else's.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function stop(dataDir: string, io: DaemonIo): Promise<number> {
  const found = await probe(dataDir);
  if (found.state === 'unconfirmed') {
    io.err(unconfirmed(dataDir, found.reason));
    return EXIT_UNAVAILABLE;
  }
  if (found.state === 'stopped') {
    io.out(
      `No daemon is running for ${safeText(dataDir)}.${found.stale ? ' Its runtime file is left from one that is gone.' : ''}\n`,
    );
    return EXIT_OK;
  }
  return (await terminate(dataDir, found.health.pid, io)) ? EXIT_OK : EXIT_SOFTWARE;
}

/** Signal a confirmed daemon and wait until it is gone: hold released, pid gone. */
async function terminate(dataDir: string, pid: number, io: DaemonIo): Promise<boolean> {
  const { isDataDirHeld } = await import('@interlock/daemon');
  io.kill(pid, 'SIGTERM');
  const timeoutMs = io.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (isDataDirHeld(dataDir) || alive(pid, io)) {
    if (Date.now() > deadline) {
      io.err(
        `The daemon (pid ${String(pid)}) did not exit within ${String(timeoutMs / 1000)} s of SIGTERM.\n\nIt may be finishing a run. Try again, or end it with \`kill -9 ${String(pid)}\`.\n`,
      );
      return false;
    }
    await wait(POLL_MS);
  }
  io.out(`The daemon stopped (pid ${String(pid)}).\n`);
  return true;
}

function uptime(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts = [
    days > 0 ? `${String(days)}d` : '',
    days > 0 || hours > 0 ? `${String(hours)}h` : '',
    days > 0 || hours > 0 || minutes > 0 ? `${String(minutes)}m` : '',
    `${String(seconds % 60)}s`,
  ];
  return parts.filter((part) => part !== '').join(' ');
}

async function status(dataDir: string, io: DaemonIo, json: boolean): Promise<number> {
  const found = await probe(dataDir);
  if (found.state !== 'running') {
    const reason =
      found.state === 'unconfirmed'
        ? `a process holds the data directory, but ${found.reason}`
        : null;
    if (json) {
      io.out(
        `${safeJson(JSON.stringify({ running: false, dataDir, reason, cliProtocolVersion: INTERLOCK_PROTOCOL_VERSION }, null, 2))}\n`,
      );
    } else {
      io.out(
        `not running  ${safeText(dataDir)}${reason === null ? '' : `\n  ${safeText(reason)}`}\n`,
      );
    }
    return EXIT_UNAVAILABLE;
  }

  const { health: answer, port } = found;
  const mismatch = answer.protocolVersion !== INTERLOCK_PROTOCOL_VERSION;
  const now = Date.now();
  if (json) {
    const facts = {
      running: true,
      dataDir,
      pid: answer.pid,
      port,
      startedAt: answer.startedAt,
      uptimeMs: Math.max(0, now - Date.parse(answer.startedAt)),
      protocolVersion: answer.protocolVersion,
      cliProtocolVersion: INTERLOCK_PROTOCOL_VERSION,
      protocolMismatch: mismatch,
    };
    io.out(`${safeJson(JSON.stringify(facts, null, 2))}\n`);
    return EXIT_OK;
  }
  const lines = [
    'running',
    `  pid       ${String(answer.pid)}`,
    `  port      ${String(port)}`,
    `  uptime    ${uptime(answer.startedAt, now)}`,
    `  data dir  ${safeText(dataDir)}`,
    `  protocol  ${String(answer.protocolVersion)}`,
  ];
  if (mismatch) {
    lines.push(
      `  warning: the daemon speaks protocol ${String(answer.protocolVersion)} and this command speaks ${String(INTERLOCK_PROTOCOL_VERSION)}. Restart the daemon from the same build.`,
    );
  }
  io.out(`${lines.join('\n')}\n`);
  return EXIT_OK;
}

/**
 * One log line as a person reads it: time, level, component and message,
 * then the rest as `key=value`. Every part is escaped — a path or a reason
 * in a record can carry whatever a repository named a file.
 */
export function formatLogLine(line: string): string {
  const record = parseRecord(line);
  if (record === null) return safeText(line);
  const { time, level, component, msg, ...fields } = record;
  const text = (value: unknown): string =>
    typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  const head = [
    typeof time === 'string' ? time : '',
    typeof level === 'string' ? level.toUpperCase().padEnd(5) : '',
    typeof component === 'string' ? `${component}:` : '',
    typeof msg === 'string' ? msg : '',
  ]
    .filter((part) => part !== '')
    .join(' ');
  const rest = Object.entries(fields).map(([key, value]) => `${key}=${text(value)}`);
  return safeText([head, ...rest].join(' '));
}

/** One log line as JSON: a record re-serialised, anything else carried as `raw`. */
export function jsonLogLine(line: string): string {
  const record = parseRecord(line);
  return safeJson(JSON.stringify(record ?? { raw: line }));
}

async function logs(dataDir: string, io: DaemonIo, options: LogOptions): Promise<number> {
  const { rotatedLogPath } = await import('@interlock/daemon');
  const path = logPath(dataDir);
  const emit = (line: string): void => {
    if (line === '') return;
    io.out(`${options.json ? jsonLogLine(line) : formatLogLine(line)}\n`);
  };

  if (!existsSync(path) && !options.follow) {
    io.err(
      `No daemon log at ${safeText(path)}.\n\nThe daemon writes one when started with \`interlock daemon start\` or autostart.\n`,
    );
    return EXIT_UNAVAILABLE;
  }

  const open = (): number | null => {
    try {
      return openSync(path, 'r');
    } catch {
      return null;
    }
  };
  // Followed by descriptor, not by name: a rotation renames the file under
  // the name, and a read by name after it would take the new file at the old
  // one's offset.
  let handle = existsSync(path) ? open() : null;
  let offset = 0;
  let pending = '';
  try {
    if (handle !== null) {
      const previous = existsSync(rotatedLogPath(path))
        ? readFileSync(rotatedLogPath(path), 'utf8')
        : '';
      const current = readRange(handle, 0, fstatSync(handle).size).toString('utf8');
      // A partial last line is left for `--follow` to finish.
      const complete =
        current.endsWith('\n') || current === ''
          ? current
          : current.slice(0, current.lastIndexOf('\n') + 1);
      offset = Buffer.byteLength(complete);
      const lines = `${previous}${complete}`.split('\n').filter((line) => line !== '');
      for (const line of options.lines === 0 ? [] : lines.slice(-options.lines)) emit(line);
    }
    if (!options.follow) return EXIT_OK;

    /** Everything written to the held file since the last read, as complete lines. */
    const drain = (held: number): void => {
      const size = fstatSync(held).size;
      // Truncated in place: start again from what is there.
      if (size < offset) {
        offset = 0;
        pending = '';
      }
      if (size === offset) return;
      const chunk = readRange(held, offset, size);
      offset += chunk.length;
      pending += chunk.toString('utf8');
      const end = pending.lastIndexOf('\n');
      if (end === -1) return;
      for (const line of pending.slice(0, end).split('\n')) emit(line);
      pending = pending.slice(end + 1);
    };

    const signal = io.stopped();
    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FOLLOW_POLL_MS);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (handle === null) {
        handle = open();
        offset = 0;
        pending = '';
        if (handle === null) continue;
      }
      drain(handle);
      let named;
      try {
        named = statSync(path);
      } catch {
        // Between the rename and the new file: the next poll finds it.
        continue;
      }
      const held = fstatSync(handle);
      if (named.ino === held.ino && named.dev === held.dev) continue;
      // Rotated. What was written to the old file before the switch is read
      // to its end first, so no line is lost to the rename.
      drain(handle);
      if (pending !== '') emit(pending);
      closeSync(handle);
      handle = open();
      offset = 0;
      pending = '';
      if (handle !== null) drain(handle);
    }
    return EXIT_OK;
  } finally {
    if (handle !== null) closeSync(handle);
  }
}

function readRange(handle: number, from: number, to: number): Buffer {
  const buffer = Buffer.alloc(to - from);
  const read = readSync(handle, buffer, 0, buffer.length, from);
  return buffer.subarray(0, read);
}

function autostartContext(dataDir: string, io: DaemonIo): AutostartContext {
  const { command, args } = io.launch();
  const [entry, ...extra] = args;
  if (entry === undefined || extra.length > 0) {
    throw new InterlockError('CONFIG_INVALID', 'Autostart needs the daemon as one entry point', {
      remedy: 'Run autostart from an installed build of Interlock.',
    });
  }
  return { ...io.autostart, node: command, entry, dataDir, path: io.env.PATH ?? '' };
}

async function autostart(dataDir: string, io: DaemonIo, rest: readonly string[]): Promise<number> {
  const [toggle, ...extra] = rest;
  if ((toggle !== 'on' && toggle !== 'off') || extra.length > 0) {
    throw usage('autostart takes on or off', 'Run `interlock daemon autostart on` or `off`.');
  }
  const context = autostartContext(dataDir, io);
  if (toggle === 'on') {
    // The service manager opens the log in the data dir before the daemon
    // runs, and cannot create the directory itself.
    await prepareDataDir(dataDir, io);
    const item = await enableAutostart(context);
    io.out(
      `Autostart is on: ${safeText(item.path)}\nThe daemon starts at login for ${safeText(dataDir)}.\n`,
    );
    return EXIT_OK;
  }
  const { removed, warnings } = await disableAutostart(context);
  for (const warning of warnings) io.err(`warning: ${safeText(warning)}\n`);
  io.out(removed ? 'Autostart is off.\n' : 'Autostart was not on.\n');
  return EXIT_OK;
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * The kill switch. Every refusal comes before the question, the question
 * before the stop, and the stop before anything is deleted.
 */
async function purge(dataDir: string, io: DaemonIo, yes: boolean): Promise<number> {
  const daemon = await import('@interlock/daemon');
  // The watched repositories, to refuse a data dir inside one. A config that
  // does not load leaves that unanswerable, and an unanswered safety check
  // is a refusal.
  const repos = (): readonly string[] => loadConfig(dataDir).repos;
  const options = { repos, home: io.home, logger: warningsTo(io) };
  const found = await daemon.inspectPurge(dataDir, options);
  // A data dir no login item can name — a control character in it — has none
  // installed, and is still purged.
  const [context, installed] = ((): [AutostartContext | null, boolean] => {
    try {
      const made = autostartContext(dataDir, io);
      return [made, autostartInstalled(made)];
    } catch {
      return [null, false];
    }
  })();

  if (!found.existed && !installed) {
    io.out(`Nothing to purge: ${safeText(dataDir)} does not exist.\n`);
    return EXIT_OK;
  }

  if (!yes) {
    if (!io.interactive) {
      throw usage(
        'A purge needs confirmation, and there is no terminal to ask',
        'Run `interlock daemon stop --purge --yes` to purge without asking.',
      );
    }
    const what = found.existed
      ? `everything in ${safeText(found.dataDir)} (${mib(found.bytes)})`
      : 'the autostart item';
    const answer = await io.ask(
      `Stop the daemon and delete ${what}? This cannot be undone. [y/N] `,
    );
    if (!/^y(es)?$/iu.test(answer.trim())) {
      io.out('Nothing was deleted.\n');
      return EXIT_OK;
    }
  }

  if (found.existed) {
    const running = await probe(dataDir);
    if (running.state === 'unconfirmed') {
      io.err(unconfirmed(dataDir, running.reason));
      return EXIT_UNAVAILABLE;
    }
    if (running.state === 'running' && !(await terminate(dataDir, running.health.pid, io))) {
      return EXIT_SOFTWARE;
    }
  }
  if (installed && context !== null) {
    const { warnings } = await disableAutostart(context);
    for (const warning of warnings) io.err(`warning: ${safeText(warning)}\n`);
    io.out('Autostart is off.\n');
  }
  if (!found.existed) return EXIT_OK;

  let report: PurgeReport;
  try {
    report = await daemon.purgeDataDir(dataDir, options);
  } catch (error) {
    // A daemon started between the stop and the hold.
    if (isInterlockError(error) && error.code === 'CONFIG_INVALID') {
      io.err(`${describeError(error)}\n`);
      return EXIT_UNAVAILABLE;
    }
    throw error;
  }
  io.out(`Purged ${safeText(report.dataDir)}: ${mib(report.bytes)} reclaimed.\n`);
  return EXIT_OK;
}

export const daemonCommand: Command = {
  name: 'daemon',
  summary: 'Manage the background service: daemon start|stop|status|logs|autostart',
  run: (args) => runDaemon(args),
};
