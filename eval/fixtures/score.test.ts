import { ulid } from '../../packages/shared/src/index.js';
import type {
  BranchRefId,
  Evidence,
  Finding,
  FindingId,
  SpeculativeRunId,
} from '../../packages/shared/src/index.js';
import { describe, expect, it } from 'vitest';
import type { Expectation, Fixture } from './format.js';
import { containsIdentifier, matches, precision, recall, score, total } from './score.js';
import type { Sides } from './score.js';

/**
 * The scorer against hand-built findings: every clause of the matching rule,
 * each shown to decide a match on its own, because each is a way a report can
 * credit a finding it should not.
 */
describe('scoring', () => {
  const sides: Sides = { a: ulid<BranchRefId>(), b: ulid<BranchRefId>() };

  const expectation: Expectation = {
    analyzer: 'textual',
    class: 'overlapping-edit',
    path: 'src/pricing.ts',
    symbol: 'subtotal',
    spanA: { path: 'src/pricing.ts', start: 3, end: 4 },
    spanB: { path: 'src/pricing.ts', start: 3, end: 3 },
  };

  const span = (
    branch: BranchRefId,
    startLine: number,
    endLine: number,
    excerpt = 'export function subtotal(items) {',
    path = 'src/pricing.ts',
  ): Evidence => ({ type: 'span', branchRefId: branch, path, startLine, endLine, excerpt });

  const finding = (overrides: Partial<Finding> = {}): Finding => ({
    id: ulid<FindingId>(),
    runId: ulid<SpeculativeRunId>(),
    kind: 'textual',
    rule: 'overlapping-edit',
    severity: 'medium',
    confidence: 1,
    status: 'open',
    title: 'Conflict',
    description: '',
    attribution: { branchA: sides.a, branchB: sides.b, originBranch: null, rationale: '' },
    evidence: [span(sides.a, 3, 3), span(sides.b, 3, 3)],
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  });

  const fixture = (expected: readonly Expectation[]): Fixture => ({
    id: 'f',
    title: 'f',
    covers: 'textual-overlap',
    base: {},
    a: { committed: [], uncommitted: [] },
    b: { committed: [], uncommitted: [] },
    expected,
    twinOf: expected.length === 0 ? 'g' : null,
  });

  describe('a match', () => {
    it('holds when every clause holds', () => {
      expect(matches(expectation, finding(), sides)).toBe(true);
    });

    it('needs the analyzer', () => {
      expect(matches(expectation, finding({ kind: 'typecheck' }), sides)).toBe(false);
    });

    it('needs the class', () => {
      expect(matches(expectation, finding({ rule: 'adjacent-addition' }), sides)).toBe(false);
    });

    it('needs the path named by the evidence', () => {
      const elsewhere = { ...expectation, path: 'src/other.ts' };
      expect(matches(elsewhere, finding(), sides)).toBe(false);
    });

    it('takes the path from the merge conflict when no span names it', () => {
      const renamed = { ...expectation, path: 'src/renamed.ts' };
      const conflict: Evidence = {
        type: 'merge-conflict',
        mergeBaseSha: 'a'.repeat(40),
        commitA: 'b'.repeat(40),
        commitB: 'c'.repeat(40),
        path: 'src/renamed.ts',
        conflictTypes: ['CONFLICT (contents)'],
        base: null,
        sideA: null,
        sideB: null,
      };
      const found = finding({ evidence: [...finding().evidence, conflict] });
      expect(matches(renamed, found, sides)).toBe(true);
    });

    it('needs the symbol, as a whole identifier', () => {
      const bare = finding({
        evidence: [span(sides.a, 3, 3, 'const subtotals = 1;'), span(sides.b, 3, 3, '}')],
      });
      expect(matches(expectation, bare, sides)).toBe(false);
      expect(matches(expectation, finding({ ...bare, title: 'subtotal changed' }), sides)).toBe(
        true,
      );
    });

    it("needs a span on branch a's lines", () => {
      const off = finding({ evidence: [span(sides.a, 5, 6), span(sides.b, 3, 3)] });
      expect(matches(expectation, off, sides)).toBe(false);
    });

    it("needs a span on branch b's lines", () => {
      const off = finding({ evidence: [span(sides.a, 3, 3), span(sides.b, 4, 4)] });
      expect(matches(expectation, off, sides)).toBe(false);
    });

    it('overlaps at either edge of the labelled lines', () => {
      const edges = finding({ evidence: [span(sides.a, 4, 9), span(sides.b, 1, 3)] });
      expect(matches(expectation, edges, sides)).toBe(true);
    });

    it('needs the span on the right branch, not the other', () => {
      const swapped = finding({ evidence: [span(sides.b, 3, 3), span(sides.b, 3, 3)] });
      expect(matches(expectation, swapped, sides)).toBe(false);
    });

    it("needs the span in the label's own path", () => {
      const moved = finding({
        evidence: [span(sides.a, 3, 3, 'subtotal', 'src/other.ts'), span(sides.b, 3, 3)],
      });
      expect(matches(expectation, moved, sides)).toBe(false);
    });

    it('counts an empty span as its first line', () => {
      const empty = finding({ evidence: [span(sides.a, 4, 3), span(sides.b, 3, 3)] });
      expect(matches(expectation, empty, sides)).toBe(true);
      const past = finding({ evidence: [span(sides.a, 5, 4), span(sides.b, 3, 3)] });
      expect(matches(expectation, past, sides)).toBe(false);
    });

    it('asks nothing of a side the label has no lines on', () => {
      const deleted = { ...expectation, spanB: null };
      expect(matches(deleted, finding({ evidence: [span(sides.a, 3, 3)] }), sides)).toBe(true);
    });
  });

  describe('a fixture', () => {
    it('counts a match once, and a second finding for it as a false positive', () => {
      const scored = score(fixture([expectation]), [finding(), finding()], sides);
      expect(scored.matched).toHaveLength(1);
      expect(scored.falsePositives).toHaveLength(1);
      expect(scored.falseNegatives).toEqual([]);
    });

    it('counts everything found on a twin as a false positive', () => {
      const scored = score(fixture([]), [finding()], sides);
      expect(scored.falsePositives).toHaveLength(1);
      expect(scored.matched).toEqual([]);
    });

    it('counts an expectation nothing matched as a false negative', () => {
      const scored = score(fixture([expectation]), [finding({ kind: 'typecheck' })], sides);
      expect(scored.falseNegatives).toEqual([expectation]);
      expect(scored.falsePositives).toHaveLength(1);
    });

    it('pairs to match the most, not the first that fits', () => {
      // The broad finding fits both labels and sorts first; given the first
      // label it would leave the narrow finding with nothing.
      const narrowLabel = { ...expectation, spanA: { ...expectation.spanA!, start: 8, end: 8 } };
      const broad = finding({
        title: 'a',
        evidence: [span(sides.a, 3, 8), span(sides.b, 3, 3)],
      });
      const narrow = finding({ title: 'b', evidence: [span(sides.a, 3, 3), span(sides.b, 3, 3)] });
      const scored = score(fixture([expectation, narrowLabel]), [narrow, broad], sides);
      expect(scored.matched).toHaveLength(2);
      expect(scored.falsePositives).toEqual([]);
      expect(scored.falseNegatives).toEqual([]);
    });
  });

  describe('totals', () => {
    it('counts true positives and misses under the label, false positives under the finding', () => {
      const labelled = score(fixture([expectation]), [finding()], sides);
      const twin = score(fixture([]), [finding({ rule: 'adjacent-addition' })], sides);
      const missed = score(
        fixture([{ ...expectation, analyzer: 'typecheck', class: 'x' }]),
        [],
        sides,
      );

      const totals = total([labelled, twin, missed]);

      expect(totals.byAnalyzer.get('textual')).toEqual({ tp: 1, fp: 1, fn: 0 });
      expect(totals.byAnalyzer.get('typecheck')).toEqual({ tp: 0, fp: 0, fn: 1 });
      expect(totals.byClass.get('textual/overlapping-edit')).toEqual({ tp: 1, fp: 0, fn: 0 });
      expect(totals.byClass.get('textual/adjacent-addition')).toEqual({ tp: 0, fp: 1, fn: 0 });
      expect(totals.byClass.get('typecheck/x')).toEqual({ tp: 0, fp: 0, fn: 1 });
      expect(totals.combined).toEqual({ tp: 1, fp: 1, fn: 1 });
    });

    it('leaves precision and recall blank when their denominator is 0', () => {
      expect(precision({ tp: 0, fp: 0, fn: 3 })).toBeNull();
      expect(recall({ tp: 0, fp: 2, fn: 0 })).toBeNull();
      expect(precision({ tp: 3, fp: 1, fn: 0 })).toBe(0.75);
      expect(recall({ tp: 1, fp: 0, fn: 3 })).toBe(0.25);
      expect(recall({ tp: 0, fp: 0, fn: 3 })).toBe(0);
    });
  });

  describe('an identifier in text', () => {
    it('is found with anything but an identifier character either side', () => {
      expect(containsIdentifier('input.split(",")', 'split')).toBe(true);
      expect(containsIdentifier('Math.max(0, n)', 'max')).toBe(true);
      expect(containsIdentifier('subtotal', 'subtotal')).toBe(true);
    });

    it('is not found inside a longer one, on either side', () => {
      expect(containsIdentifier('subtotals', 'subtotal')).toBe(false);
      expect(containsIdentifier('$subtotal', 'subtotal')).toBe(false);
      expect(containsIdentifier('_subtotal', 'subtotal')).toBe(false);
      expect(containsIdentifier('maxValue and max', 'max')).toBe(true);
    });

    it('is never the empty string', () => {
      expect(containsIdentifier('anything', '')).toBe(false);
    });
  });
});
