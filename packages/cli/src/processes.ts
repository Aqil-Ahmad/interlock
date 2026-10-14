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

export function runCommand(file: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: COMMAND_TIMEOUT_MS }, (error, _stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolve({
        // A spawn failure — no such binary — carries a string code, and is a
        // failure all the same.
        exitCode: error === null ? 0 : typeof code === 'number' ? code : 1,
        stderr: String(stderr),
      });
    });
  });
}

/**
 * Start a process in its own session, outliving this one, with stdout and
 * stderr on `log` — an open file descriptor — and no stdin.
 */
export function launchDetached(
  command: string,
  args: readonly string[],
  log: number,
  env: Record<string, string | undefined>,
): ChildProcess {
  const child = spawn(command, [...args], { detached: true, stdio: ['ignore', log, log], env });
  child.unref();
  return child;
}
