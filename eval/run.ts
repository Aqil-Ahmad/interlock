#!/usr/bin/env tsx
/**
 * Evaluation entry point: `pnpm eval`.
 *
 * Every reported number is regenerable by this command. Suites and metric
 * definitions are documented in plan_docs/evaluation.md.
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

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSuite } from './fixtures/suite.js';

const SUITES = ['fixtures', 'replay', 'agenticflict', 'overhead', 'ablations'] as const;
type Suite = (typeof SUITES)[number];

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(EVAL_DIR, '..');
const REPORTS_DIR = join(EVAL_DIR, 'reports');

/** The oldest git the merge runs on: `merge-tree --write-tree` against a given base, with `--attr-source`. */
const MIN_GIT: readonly [number, number] = [2, 41];

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

/**
 * Refuse an old git before building anything: every fixture would fail the
 * same way, and a report of nothing but infrastructure failures says less than
 * this does.
 */
function requireGit(): void {
  const version = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
  const [major = 0, minor = 0] = (/(\d+)\.(\d+)/u.exec(version) ?? []).slice(1).map(Number);
  if (major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])) {
    console.error(
      `${version} is too old: the fixtures need git ${MIN_GIT.join('.')} or later first on PATH.`,
    );
    process.exit(69);
  }
}

async function main(): Promise<void> {
  const suites = parseSuites(process.argv.slice(2));
  console.log(`Interlock evaluation — suites: ${suites.join(', ')}\n`);
  for (const suite of suites) {
    if (suite !== 'fixtures') {
      console.log(`${suite}: no runner for this suite; protocols in plan_docs/evaluation.md`);
      continue;
    }
    requireGit();
    const report = await writeSuite(REPO_ROOT, REPORTS_DIR);
    const { combined } = report;
    console.log(
      `fixtures: ${String(report.fixtures.length)} run — TP ${String(combined.tp)}, FP ${String(combined.fp)}, FN ${String(combined.fn)}`,
    );
    console.log(`  written to ${join(REPORTS_DIR, 'fixtures.md')} and fixtures.json`);
  }
}

await main();
