#!/usr/bin/env node
/**
 * `interlock` — the user-facing CLI.
 *
 * A thin client over the daemon's localhost API; it performs no analysis of its
 * own.
 */
import { COMMANDS } from './commands/index.js';

function usage(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const lines = COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`);
  return [
    'interlock — early conflict detection for parallel coding agents',
    '',
    'Usage: interlock <command> [options]',
    '',
    'Commands:',
    ...lines,
  ].join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
  const [name, ...rest] = argv;

  if (name === undefined || name === '--help' || name === '-h') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const command = COMMANDS.find((candidate) => candidate.name === name);
  if (command === undefined) {
    process.stderr.write(`Unknown command: ${name}\n\n${usage()}\n`);
    return 64; // EX_USAGE
  }

  return command.run(rest);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
