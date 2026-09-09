import { notImplemented } from '@interlock/shared';
import { statusCommand } from './status.js';
import type { Command } from './command.js';

/**
 * CLI command surface.
 *
 * Every read path the dashboard offers is available here too, so Interlock is
 * usable over SSH and scriptable.
 */

export type { Command } from './command.js';
export { runStatus, statusCommand } from './status.js';
export type { StatusIo } from './status.js';

const todo = (name: string): Command['run'] => {
  return () => notImplemented(`interlock ${name}`);
};

export const COMMANDS: readonly Command[] = [
  statusCommand,
  {
    name: 'watch',
    summary: 'Follow findings live in the terminal',
    run: todo('watch'),
  },
  {
    name: 'check',
    summary: 'Force an immediate speculative merge of two branches: check <A> <B>',
    run: todo('check'),
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
    name: 'daemon',
    summary: 'Manage the background service: daemon start|stop|status|logs',
    run: todo('daemon'),
  },
  {
    name: 'doctor',
    summary: 'Diagnose the environment: git, Docker sandbox, toolchain, permissions',
    run: todo('doctor'),
  },
];
