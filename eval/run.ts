#!/usr/bin/env tsx
/**
 * Evaluation entry point: `pnpm eval`.
 *
 * Every reported number is regenerable by this command. Suites and metric
 * definitions are documented in docs/EVALUATION.md.
 *
 *   fixtures     — golden synthetic repos with planted conflicts
 *   replay       — concurrent branch histories from OSS repos
 *   agenticflict — adapted cases from the AgenticFlict dataset
 *   overhead     — CPU/RAM/disk and time-to-verdict
 *   ablations    — textual only → +typecheck → +AST → full
 *
 * Reports are written to eval/reports/ with the environment recorded alongside:
 * OS, CPU, Node, git and Docker versions, analyzer configuration.
 */

const SUITES = ['fixtures', 'replay', 'agenticflict', 'overhead', 'ablations'] as const;
type Suite = (typeof SUITES)[number];

function parseSuites(argv: readonly string[]): Suite[] {
  const index = argv.indexOf('--suite');
  if (index === -1) return [...SUITES];
  const requested = argv[index + 1];
  if (requested === undefined || !SUITES.includes(requested as Suite)) {
    console.error(`Unknown suite. Available: ${SUITES.join(', ')}`);
    process.exit(64);
  }
  return [requested as Suite];
}

function main(): void {
  const suites = parseSuites(process.argv.slice(2));
  console.log(`Interlock evaluation — suites: ${suites.join(', ')}\n`);
  console.log('Not implemented yet. Protocols: docs/EVALUATION.md');
}

main();
