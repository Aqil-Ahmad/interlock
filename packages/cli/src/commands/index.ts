import { notImplemented } from '@interlock/shared';

/**
 * CLI command surface.
 *
 * Every read path the dashboard offers is available here too, so Interlock is
 * usable over SSH and scriptable.
 */

export interface Command {
  readonly name: string;
  readonly summary: string;
  /** Returns a process exit code. */
  run(args: readonly string[]): Promise<number>;
}

const todo = (name: string, milestone: string): Command['run'] => {
  return () => notImplemented(`interlock ${name}`, milestone);
};

export const COMMANDS: readonly Command[] = [
  {
    name: 'status',
    summary: 'Show in-flight branches, their dirty state and open findings',
    run: todo('status', 'M1'),
  },
  {
    name: 'watch',
    summary: 'Follow findings live in the terminal',
    run: todo('watch', 'M2'),
  },
  {
    name: 'check',
    summary: 'Force an immediate speculative merge of two branches: check <A> <B>',
    run: todo('check', 'M2'),
  },
  {
    name: 'order',
    summary: 'Show the recommended landing order for in-flight branches',
    run: todo('order', 'M7'),
  },
  {
    name: 'init',
    summary: 'Set up Interlock for a repository, including agent hooks',
    run: todo('init', 'M6'),
  },
  {
    name: 'daemon',
    summary: 'Manage the background service: daemon start|stop|status|logs',
    run: todo('daemon', 'M1'),
  },
  {
    name: 'doctor',
    summary: 'Diagnose the environment: git, Docker sandbox, toolchain, permissions',
    run: todo('doctor', 'M3'),
  },
];
