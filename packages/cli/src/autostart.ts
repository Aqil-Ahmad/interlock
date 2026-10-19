import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { InterlockError, logPath } from '@interlock/shared';
import type { CommandResult, ServiceManager } from './processes.js';

/**
 * The login item that starts the daemon: a launchd agent on macOS, a systemd
 * user unit on Linux.
 *
 * Off unless asked for. The item names absolute paths — the node binary, the
 * daemon's entry point and the data dir — and carries the `PATH` of the shell
 * that turned it on, since a login session sets its own: launchd's finds only
 * the system git, which Interlock does not support. Each data dir gets its own
 * item, so turning one off never touches another's. What the daemon prints
 * before it has a logger, and a crash, go to its log file.
 *
 * Every command runs through an injected runner, so the suite asserts on the
 * generated file and the argv without loading anything into the session it
 * runs in.
 */

/** One command, as an argument array: there is no shell anywhere here. */
export type AutostartRunner = (
  file: ServiceManager,
  args: readonly string[],
) => Promise<CommandResult>;

/** A service manager and its arguments. */
type Command = readonly [ServiceManager, ...string[]];

export interface AutostartContext {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** launchd addresses a user's agents by uid. */
  readonly uid: number;
  /** The node binary the item runs, absolute. */
  readonly node: string;
  /** The daemon's entry point, absolute. */
  readonly entry: string;
  readonly dataDir: string;
  /** The `PATH` the daemon runs with, which is where it finds git. Relative entries are dropped. */
  readonly path?: string;
  readonly run: AutostartRunner;
}

/** What `on` writes: where, and exactly what. */
export interface AutostartItem {
  readonly path: string;
  readonly content: string;
  /** The launchd label or the systemd unit name. */
  readonly name: string;
}

/** Long enough that two data dirs never collide, short enough to read in a listing. */
const NAME_HASH_LENGTH = 12;

/** Readable by the session manager, writable by the user alone, like any login item. */
const ITEM_MODE = 0o644;

/** The flag `main.ts` takes to log into the data dir rather than stderr. */
const LOG_TO_FILE = '--log-to-file';

/**
 * How long `off` waits for launchd to finish unloading an agent. `bootout`
 * returns before the agent is gone, and a `bootstrap` of the same label before
 * then fails with an I/O error — `on` over an existing item is exactly that.
 */
const BOOTOUT_WAIT_MS = 10_000;
const BOOTOUT_POLL_MS = 100;

function unsupported(platform: NodeJS.Platform): InterlockError {
  return new InterlockError('CONFIG_INVALID', `Autostart is not supported on ${platform}`, {
    remedy: 'Start the daemon with `interlock daemon start` after logging in.',
  });
}

/**
 * Refuse a path the item cannot carry exactly.
 *
 * A control character has no faithful spelling in a unit file — a newline ends
 * the directive and starts another — and a relative path would resolve against
 * wherever the session manager happens to run.
 */
function hasControl(text: string): boolean {
  return [...text].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 0x20 || point === 0x7f;
  });
}

function checkPath(what: string, path: string): void {
  if (!isAbsolute(path) || hasControl(path)) {
    throw new InterlockError('CONFIG_INVALID', `The ${what} cannot be written into a login item`, {
      details: { [what]: path },
      remedy: `Use an absolute ${what} with no control characters in it.`,
    });
  }
}

/**
 * The search path an item carries: absolute entries only, since a relative one
 * resolves against wherever the session manager runs. One with a control
 * character is refused, as any other path is; empty when none is left.
 */
function searchPath(path: string | undefined): string {
  if (path === undefined) return '';
  if (hasControl(path)) {
    throw new InterlockError('CONFIG_INVALID', 'The PATH cannot be written into a login item', {
      remedy: 'Remove the control characters from PATH and turn autostart on again.',
    });
  }
  return path
    .split(delimiter)
    .filter((entry) => isAbsolute(entry))
    .join(delimiter);
}

function hashOf(dataDir: string): string {
  return createHash('sha256').update(dataDir).digest('hex').slice(0, NAME_HASH_LENGTH);
}

function xml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * One systemd word, quoted.
 *
 * Inside double quotes systemd still reads `\` escapes and expands `%`
 * specifiers everywhere, so each is escaped rather than trusted to mean
 * itself. `$` is expanded on `ExecStart` alone: there it is doubled, and
 * anywhere else a doubled one would reach the daemon as two.
 */
function systemdWord(text: string, onExecStart = false): string {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return `"${onExecStart ? escaped.replaceAll('$', '$$$$') : escaped}"`;
}

/** The item `on` would install, without installing it. */
export function autostartItem(context: AutostartContext): AutostartItem {
  checkPath('node', context.node);
  checkPath('entry', context.entry);
  checkPath('dataDir', context.dataDir);
  // One item per directory however it was spelled: `~/.interlock/` and
  // `~/.interlock` are the same data dir, and a purge of one must find the item
  // the other installed.
  const dataDir = resolve(context.dataDir);
  const hash = hashOf(dataDir);
  const path = searchPath(context.path);
  const log = logPath(dataDir);

  if (context.platform === 'darwin') {
    const name = `ai.interlock.daemon.${hash}`;
    const strings = (values: readonly string[]): string =>
      values.map((value) => `    <string>${xml(value)}</string>`).join('\n');
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      `  <string>${name}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      strings([context.node, context.entry, LOG_TO_FILE]),
      '  </array>',
      '  <key>EnvironmentVariables</key>',
      '  <dict>',
      '    <key>INTERLOCK_DATA_DIR</key>',
      `    <string>${xml(dataDir)}</string>`,
      ...(path === '' ? [] : ['    <key>PATH</key>', `    <string>${xml(path)}</string>`]),
      '  </dict>',
      '  <key>StandardOutPath</key>',
      `  <string>${xml(log)}</string>`,
      '  <key>StandardErrorPath</key>',
      `  <string>${xml(log)}</string>`,
      '  <key>RunAtLoad</key>',
      '  <true/>',
      // Not kept alive: a daemon stopped on purpose stays stopped, and one that
      // fails at start would otherwise be restarted into the same failure.
      '  <key>KeepAlive</key>',
      '  <false/>',
      '  <key>ProcessType</key>',
      '  <string>Background</string>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
    return { name, content, path: join(context.home, 'Library', 'LaunchAgents', `${name}.plist`) };
  }

  if (context.platform === 'linux') {
    const name = `interlock-daemon-${hash}.service`;
    const content = [
      '[Unit]',
      // Specifiers expand here too.
      `Description=Interlock daemon for ${dataDir.replaceAll('%', '%%')}`,
      '',
      '[Service]',
      'Type=simple',
      `Environment=${systemdWord(`INTERLOCK_DATA_DIR=${dataDir}`)}`,
      ...(path === '' ? [] : [`Environment=${systemdWord(`PATH=${path}`)}`]),
      `ExecStart=${[context.node, context.entry].map((word) => systemdWord(word, true)).join(' ')} ${LOG_TO_FILE}`,
      // Read whole to the end of the line, with specifiers expanded: no quoting.
      `StandardOutput=append:${log.replaceAll('%', '%%')}`,
      `StandardError=append:${log.replaceAll('%', '%%')}`,
      // No `Restart=`, for the reason the launchd agent is not kept alive.
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    return { name, content, path: join(context.home, '.config', 'systemd', 'user', name) };
  }

  throw unsupported(context.platform);
}

/** Whether `on` has installed an item for this data dir. */
export function autostartInstalled(context: AutostartContext): boolean {
  return existsSync(autostartItem(context).path);
}

/** The commands that load an installed item, in order. */
function loadCommands(context: AutostartContext, item: AutostartItem): Command[] {
  if (context.platform === 'darwin') {
    return [['launchctl', 'bootstrap', `gui/${String(context.uid)}`, item.path]];
  }
  return [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', item.name],
  ];
}

/** The commands that unload it. Run before the file goes, which they read. */
function unloadCommands(context: AutostartContext, item: AutostartItem): Command[] {
  if (context.platform === 'darwin') {
    return [['launchctl', 'bootout', `gui/${String(context.uid)}/${item.name}`]];
  }
  return [['systemctl', '--user', 'disable', '--now', item.name]];
}

/** After the file goes, so the manager forgets the unit rather than reporting it missing. */
function forgetCommands(context: AutostartContext): Command[] {
  return context.platform === 'darwin' ? [] : [['systemctl', '--user', 'daemon-reload']];
}

/**
 * Install and load the item. One already installed is replaced: it may name a
 * node binary or an entry point from before an upgrade.
 *
 * @throws InterlockError `CONFIG_INVALID` when a load command fails; the file
 *         it wrote is removed again, so `on` either works or leaves nothing.
 */
export async function enableAutostart(context: AutostartContext): Promise<AutostartItem> {
  const item = autostartItem(context);
  if (existsSync(item.path)) await disableAutostart(context);
  mkdirSync(dirname(item.path), { recursive: true });
  writeFileSync(item.path, item.content, { mode: ITEM_MODE });
  for (const [file, ...args] of loadCommands(context, item)) {
    const result = await context.run(file, args);
    if (result.exitCode !== 0) {
      // Undone as `off` would: `enable --now` can enable the unit and then fail
      // to start it, and an enablement left behind would load at the next
      // login an item nothing here reports as installed.
      await undo(context, item);
      throw new InterlockError('CONFIG_INVALID', `${file} could not load the login item`, {
        details: { args, exitCode: result.exitCode, stderr: result.stderr.trim() },
        remedy: `Run \`${[file, ...args].join(' ')}\` to see why, then turn autostart on again.`,
      });
    }
  }
  return item;
}

/**
 * Unload and remove the item, if there is one. Answers whether there was.
 *
 * An unload that fails is not a reason to keep the file: it fails when the
 * item was never loaded or has already been, and the file is what would load
 * it again at the next login. What it said is handed back for the caller to
 * show.
 */
export async function disableAutostart(
  context: AutostartContext,
): Promise<{ readonly removed: boolean; readonly warnings: readonly string[] }> {
  const item = autostartItem(context);
  if (!existsSync(item.path)) return { removed: false, warnings: [] };
  const warnings: string[] = [];
  for (const [file, ...args] of unloadCommands(context, item)) {
    const result = await context.run(file, args);
    if (result.exitCode !== 0) {
      warnings.push(
        `${[file, ...args].join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`,
      );
    }
  }
  if (context.platform === 'darwin') await bootedOut(context, item);
  rmSync(item.path, { force: true });
  for (const [file, ...args] of forgetCommands(context)) {
    const result = await context.run(file, args);
    if (result.exitCode !== 0) {
      warnings.push(
        `${[file, ...args].join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`,
      );
    }
  }
  return { removed: true, warnings };
}

/**
 * Wait until launchd no longer knows the agent: `print` fails for a label it
 * does not have. Bounded, and a wait that runs out is not an error here — a
 * `bootstrap` after it says so itself.
 */
async function bootedOut(context: AutostartContext, item: AutostartItem): Promise<void> {
  const target = `gui/${String(context.uid)}/${item.name}`;
  const deadline = Date.now() + BOOTOUT_WAIT_MS;
  while ((await context.run('launchctl', ['print', target])).exitCode === 0) {
    if (Date.now() > deadline) return;
    await new Promise((done) => setTimeout(done, BOOTOUT_POLL_MS));
  }
}

/** Unload and forget an item `on` failed to load, whatever each step answers. */
async function undo(context: AutostartContext, item: AutostartItem): Promise<void> {
  for (const [file, ...args] of unloadCommands(context, item)) await context.run(file, args);
  rmSync(item.path, { force: true });
  for (const [file, ...args] of forgetCommands(context)) await context.run(file, args);
}
