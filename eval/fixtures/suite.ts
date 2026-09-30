import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitRunner } from '../../packages/core/src/index.js';
import type { Fixture } from './format.js';
import { FIXTURES } from './index.js';
import { buildReport, environment, renderJson, renderMarkdown } from './report.js';
import type { Report } from './report.js';
import { runFixture } from './runner.js';
import type { FixtureRun } from './runner.js';

/**
 * Run `fixtures` one after another and score them.
 *
 * In sequence, not in parallel: the order findings arrive in never reaches the
 * report, but a run that competes with itself for the disk measures the
 * machine, and the report should measure Interlock.
 */
export async function runSuite(fixtures: readonly Fixture[], repoRoot: string): Promise<Report> {
  const runner = createGitRunner();
  const runs: FixtureRun[] = [];
  for (const fixture of fixtures) runs.push(await runFixture(fixture, runner));
  return buildReport(runs, environment(repoRoot));
}

/** The whole set, written to `fixtures.md` and `fixtures.json` under `reportsDir`. */
export async function writeSuite(repoRoot: string, reportsDir: string): Promise<Report> {
  const report = await runSuite(FIXTURES, repoRoot);
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(reportsDir, 'fixtures.json'), renderJson(report));
  writeFileSync(join(reportsDir, 'fixtures.md'), renderMarkdown(report));
  return report;
}
