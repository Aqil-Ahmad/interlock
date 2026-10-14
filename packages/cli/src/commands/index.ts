import { notImplemented } from '@interlock/shared';
import { checkCommand } from './check.js';
import { daemonCommand } from './daemon.js';
import { dismissCommand } from './dismiss.js';
import { hookCommand } from './hook.js';
import { statusCommand } from './status.js';
import type { Command } from './command.js';

/**
 * CLI command surface.
 *
 * Every read path the dashboard offers is available here too, so Interlock is
 * usable over SSH and scriptable.
 */

export type { Command } from './command.js';
export { checkCommand, runCheck } from './check.js';
export type { CheckIo } from './check.js';
export { daemonCommand, formatLogLine, jsonLogLine, runDaemon } from './daemon.js';
export type { DaemonIo } from './daemon.js';
export { dismissCommand, runDismiss } from './dismiss.js';
export type { DismissIo } from './dismiss.js';
export { MAX_STDIN_BYTES, hookCommand, readBounded, runHook } from './hook.js';
export type { HookIo } from './hook.js';
export { runStatus, statusCommand } from './status.js';
export type { StatusIo } from './status.js';

const todo = (name: string): Command['run'] => {
  return () => notImplemented(`interlock ${name}`);
};

export const COMMANDS: readonly Command[] = [
  statusCommand,
  hookCommand,
  checkCommand,
  dismissCommand,
  daemonCommand,
  {
    name: 'watch',
    summary: 'Follow findings live in the terminal',
    run: todo('watch'),
  },
  {
    name: 'order',
    summary: 'Show the recommended landing order for in-flight branches',
    run: todo('order'),
  },
  {
    name: 'init',
    summary: 'Set up Interlock for a repository, including agent hooks',
    run: todo('init'),
  },
  {
    name: 'doctor',
    summary: 'Diagnose the environment: git, Docker sandbox, toolchain, permissions',
    run: todo('doctor'),
  },
];
