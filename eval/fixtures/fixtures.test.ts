import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIXTURE_CASES } from './format.js';
import type { Fixture, Span } from './format.js';
import { FIXTURES } from './index.js';
import { renderJson, renderMarkdown } from './report.js';
import { containsIdentifier } from './score.js';
import { runSuite } from './suite.js';

const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
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

  it('runs a conflict and its twin through the real pipeline, the same way twice', async () => {
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
