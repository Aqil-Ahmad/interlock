import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/**
 * Every process the CLI starts: the daemon, and the commands that load or
 * unload its login item.
 *
 * One file, so the places Interlock spawns anything stay a short list that
 * review can hold. Both take an argument array and never a shell: a data dir
 * or an entry point is a path, and a path is not a command line.
 */

/** A command's exit code and what it said on stderr. Never throws for a non-zero exit. */
export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
}

/** Long enough for `systemctl` or `launchctl` on a loaded machine; a hang is not a wait. */
const COMMAND_TIMEOUT_MS = 30_000;

/** The service managers autostart drives, by name: all this runs, besides the daemon. */
const SERVICE_MANAGERS = ['launchctl', 'systemctl'] as const;
export type ServiceManager = (typeof SERVICE_MANAGERS)[number];

/**
 * Run `launchctl` or `systemctl`, and nothing else.
 *
 * Named rather than taken as any binary, so this file being on the list of
 * places that spawn processes still says what they can run.
 */
export function runServiceManager(
  file: ServiceManager,
  args: readonly string[],
): Promise<CommandResult> {
  if (!(SERVICE_MANAGERS as readonly string[]).includes(file)) {
    throw new TypeError(`Not a service manager: ${String(file)}`);
  }
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: COMMAND_TIMEOUT_MS }, (error, _stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      const exited = error === null || typeof code === 'number';
      resolve({
        // A spawn failure — no such binary — carries a string code, and is a
        // failure all the same. It says nothing on stderr, so what it was is
        // said there instead: "exited 1" with nothing after it explains nothing.
        exitCode: error === null ? 0 : typeof code === 'number' ? code : 1,
        stderr: exited ? String(stderr) : `${String(stderr)}${error.message}`,
      });
    });
  });
}

/**
 * Start the running node on `args` — the daemon's entry point — in its own
 * session, outliving this one, with stdout and stderr on `log`, an open file
 * descriptor, and no stdin.
 */
export function launchNode(
  args: readonly string[],
  log: number,
  env: Record<string, string | undefined>,
): ChildProcess {
  const child = spawn(process.execPath, [...args], {
    detached: true,
    stdio: ['ignore', log, log],
    env,
  });
  child.unref();
  return child;
}
