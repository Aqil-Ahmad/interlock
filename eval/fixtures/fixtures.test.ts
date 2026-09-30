import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitRunner } from '../../packages/core/src/index.js';
import type { Analyzer } from '../../packages/core/src/index.js';
import { InterlockError } from '../../packages/shared/src/index.js';
import type { AnalyzerKind } from '../../packages/shared/src/index.js';
import { describe, expect, it } from 'vitest';
import { FIXTURE_CASES } from './format.js';
import type { Fixture, Span } from './format.js';
import { FIXTURES } from './index.js';
import { renderJson, renderMarkdown } from './report.js';
import { ANALYZERS, runFixture } from './runner.js';
import { containsIdentifier } from './score.js';
import { runSuite } from './suite.js';

const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What each analyzer that runs scores on the whole set today, as a floor.
 *
 * A regression check, not a target: raised when an analyzer improves, never
 * lowered to let a change through — the same rule as the coverage floors. An
 * analyzer that runs with no floor here fails the test, so the one that lands
 * next is held to its numbers from the day it does.
 */
const FLOORS: Partial<
  Record<AnalyzerKind, { readonly precision: number; readonly recall: number }>
> = { textual: { precision: 1, recall: 1 } };
const REPO_ROOT = join(EVAL_DIR, '..');

/** A branch's files once its committed and uncommitted operations are applied, in memory. */
function filesOf(fixture: Fixture, side: 'a' | 'b'): Map<string, string> {
  const files = new Map(Object.entries(fixture.base));
  for (const operation of [...fixture[side].committed, ...fixture[side].uncommitted]) {
    if (operation.op === 'write') files.set(operation.path, operation.content);
    if (operation.op === 'delete') files.delete(operation.path);
    if (operation.op === 'rename') {
      files.set(operation.to, files.get(operation.from)!);
      files.delete(operation.from);
    }
  }
  return files;
}

function linesOf(files: Map<string, string>, span: Span): string[] | undefined {
  return files
    .get(span.path)
    ?.split('\n')
    .slice(span.start - 1, span.end);
}

/**
 * The golden set, checked two ways: statically, every fixture against the
 * rules the format sets; and end to end, a conflict and its twin through the
 * whole runner, so a runner that no longer works fails here and not on the
 * day a report is due.
 */
describe('the golden set', () => {
  it('names each fixture once, in lowercase kebab', () => {
    const ids = FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  });

  it('gives every conflict a twin, and every twin a conflict of its own case', () => {
    const byId = new Map(FIXTURES.map((fixture) => [fixture.id, fixture]));
    for (const fixture of FIXTURES) {
      if (fixture.twinOf === null) {
        expect(fixture.expected.length, fixture.id).toBeGreaterThan(0);
        expect(
          FIXTURES.some((twin) => twin.twinOf === fixture.id),
          `${fixture.id} has no twin`,
        ).toBe(true);
      } else {
        expect(fixture.expected, fixture.id).toEqual([]);
        const conflict = byId.get(fixture.twinOf);
        expect(conflict?.twinOf, `${fixture.id} mirrors no conflict`).toBeNull();
        expect(conflict?.covers).toBe(fixture.covers);
      }
    }
  });

  it('covers every case the protocol lists with a conflict', () => {
    const covered = new Set(
      FIXTURES.filter((fixture) => fixture.twinOf === null).map((fixture) => fixture.covers),
    );
    expect([...covered].sort()).toEqual([...FIXTURE_CASES].sort());
  });

  it('labels lines that exist on their branch, and names the symbol in them', () => {
    for (const fixture of FIXTURES) {
      const files = { a: filesOf(fixture, 'a'), b: filesOf(fixture, 'b') };
      for (const expected of fixture.expected) {
        const labelled: string[] = [];
        for (const [side, span] of [
          ['a', expected.spanA],
          ['b', expected.spanB],
        ] as const) {
          if (span === null) continue;
          expect(span.start, fixture.id).toBeGreaterThanOrEqual(1);
          expect(span.end, fixture.id).toBeGreaterThanOrEqual(span.start);
          const lines = linesOf(files[side], span);
          expect(lines, `${fixture.id}: ${span.path} on ${side}`).toBeDefined();
          expect(lines!.length, `${fixture.id}: ${span.path} lines on ${side}`).toBe(
            span.end - span.start + 1,
          );
          labelled.push(...lines!);
        }
        expect(
          labelled.some((line) => containsIdentifier(line, expected.symbol)),
          `${fixture.id}: ${expected.symbol} is in no labelled line`,
        ).toBe(true);
      }
    }
  });

  it('runs a conflict and its twin through the runner, the same way twice', async () => {
    const pair = FIXTURES.filter(
      (fixture) => fixture.id === 'overlap-uncommitted' || fixture.twinOf === 'overlap-uncommitted',
    );
    expect(pair).toHaveLength(2);

    const first = await runSuite(pair, REPO_ROOT);
    const second = await runSuite(pair, REPO_ROOT);

    expect(first.combined).toMatchObject({ tp: 1, fp: 0, fn: 0 });
    expect(
      first.fixtures.map((fixture) => [fixture.id, fixture.status, fixture.tp, fixture.fp]),
    ).toEqual([
      ['overlap-uncommitted', 'scored', 1, 0],
      ['overlap-uncommitted-twin-far-lines', 'scored', 0, 0],
    ]);
    expect(renderJson(second)).toBe(renderJson(first));
    expect(renderMarkdown(second)).toBe(renderMarkdown(first));
  }, 60_000);

  it('holds every analyzer that runs to its floor across the whole set', async () => {
    const report = await runSuite(FIXTURES, REPO_ROOT);

    const unscored = report.fixtures.filter((fixture) => fixture.status !== 'scored');
    expect(unscored.map((fixture) => `${fixture.id}: ${fixture.failure?.message ?? ''}`)).toEqual(
      [],
    );
    // Named on failure: which fixture a lost hit or a new false positive came from.
    const wrong = report.fixtures
      .filter((fixture) => fixture.fp > 0 || fixture.fn > 0)
      .map(
        (fixture) =>
          `${fixture.id}: ${[...fixture.unmatchedFindings, ...fixture.missed].join('; ')}`,
      );
    // A floor for an analyzer that no longer runs would pass on nothing.
    const ran = report.analyzers.filter((each) => each.ran).map((each) => each.analyzer);
    expect(ran).toEqual(expect.arrayContaining(Object.keys(FLOORS)));
    for (const row of report.analyzers.filter((each) => each.ran)) {
      const floor = FLOORS[row.analyzer];
      expect(floor, `${row.analyzer} runs and has no floor here`).toBeDefined();
      // Blank precision is nothing found at all, which recall catches.
      expect(
        row.precision ?? 1,
        `${row.analyzer} precision\n${wrong.join('\n')}`,
      ).toBeGreaterThanOrEqual(floor!.precision);
      expect(row.recall ?? 0, `${row.analyzer} recall\n${wrong.join('\n')}`).toBeGreaterThanOrEqual(
        floor!.recall,
      );
    }
  }, 180_000);

  describe('an analyzer that throws', () => {
    const throwing = (error: Error): Analyzer => ({
      ...ANALYZERS[0]!,
      appliesTo: () => true,
      analyze: () => Promise.reject(error),
    });
    const conflict = FIXTURES.find((fixture) => fixture.id === 'overlap-uncommitted')!;

    it('reports an infrastructure failure apart, naming the analyzer', async () => {
      const failed = new InterlockError('GIT_COMMAND_FAILED', 'git did not finish', {
        infra: true,
      });

      const run = await runFixture(conflict, createGitRunner(), [throwing(failed)]);

      expect(run).toMatchObject({
        kind: 'infra-failure',
        analyzer: 'textual',
        message: 'git did not finish',
      });
    });

    it('stops the suite for anything else, which is a fault in the analyzer or the runner', async () => {
      await expect(
        runFixture(conflict, createGitRunner(), [throwing(new Error('a bug'))]),
      ).rejects.toThrow('a bug');
    });
  });

  it('is never imported by anything in packages/', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name === 'coverage') continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(?:ts|tsx|js|mjs)$/u.test(name)) {
          // Any module specifier that reaches into the eval directory.
          if (/from\s+['"][^'"]*\/eval\//u.test(readFileSync(path, 'utf8'))) offenders.push(path);
        }
      }
    };
    walk(join(REPO_ROOT, 'packages'));
    expect(offenders).toEqual([]);
  });
});
