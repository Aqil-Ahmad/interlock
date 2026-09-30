import type {
  AnalyzerKind,
  BranchRefId,
  Evidence,
  Finding,
} from '../../packages/shared/src/index.js';
import type { Expectation, Fixture, Span } from './format.js';

/**
 * How a finding is scored against a fixture's labels. Printed at the head of
 * every report, because it defines what the numbers mean: a change to it is a
 * change to every metric, and has to be visible as one.
 */
export const MATCHING_RULE = [
  'A finding matches an expectation when all of these hold:',
  "- its analyzer and its rule are the expectation's analyzer and class;",
  "- the expectation's path is named by its evidence: a span, the merge conflict, a tool location or a symbol-trail step;",
  "- the expectation's symbol appears, as a whole identifier, in its title, description, span excerpts, tool output or symbol-trail steps;",
  "- for each branch the expectation has a span on, it has a span on that branch, in that span's path, whose lines overlap it (an empty span counts as its first line).",
  'Findings and expectations are paired by a maximum matching, each used at most once.',
  'A matched pair is a true positive. A finding left unmatched is a false positive — every finding on a negative twin is one.',
  'An expectation left unmatched is a false negative. A fixture that failed for environmental reasons is listed apart and counted as neither.',
  'Precision = TP / (TP + FP) and recall = TP / (TP + FN), each blank when its denominator is 0.',
].join('\n');

/** The branch ids a fixture's two sides were given in the run. */
export interface Sides {
  readonly a: BranchRefId;
  readonly b: BranchRefId;
}

export interface Tally {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
}

/** What one fixture scored, and what went unmatched, for a reader chasing a number. */
export interface FixtureScore {
  readonly matched: readonly { readonly expectation: Expectation; readonly finding: Finding }[];
  readonly falsePositives: readonly Finding[];
  readonly falseNegatives: readonly Expectation[];
}

/** Whether `finding` satisfies `expectation`, by {@link MATCHING_RULE}. */
export function matches(expectation: Expectation, finding: Finding, sides: Sides): boolean {
  return (
    finding.kind === expectation.analyzer &&
    finding.rule === expectation.class &&
    namesPath(finding.evidence, expectation.path) &&
    namesSymbol(finding, expectation.symbol) &&
    coversSide(finding.evidence, expectation.spanA, sides.a) &&
    coversSide(finding.evidence, expectation.spanB, sides.b)
  );
}

/**
 * Pair a fixture's findings with its expectations.
 *
 * A maximum matching, not first-come: a finding that could satisfy two
 * expectations must not take the one another finding needed, and turn one
 * true positive into a false positive and a false negative. Inputs are sorted
 * first, so the pairing — and every report — is the same on every run.
 */
export function score(fixture: Fixture, findings: readonly Finding[], sides: Sides): FixtureScore {
  const ordered = [...findings].sort((x, y) => compare(findingKey(x), findingKey(y)));
  const expectations = fixture.expected;
  // For each expectation, the finding it is paired with, by index.
  const owner = new Array<number | null>(expectations.length).fill(null);

  const augment = (finding: number, seen: boolean[]): boolean => {
    for (let e = 0; e < expectations.length; e++) {
      if (seen[e] === true || !matches(expectations[e]!, ordered[finding]!, sides)) continue;
      seen[e] = true;
      const held = owner[e]!;
      if (held === null || augment(held, seen)) {
        owner[e] = finding;
        return true;
      }
    }
    return false;
  };
  for (let f = 0; f < ordered.length; f++) augment(f, new Array<boolean>(expectations.length));

  const used = new Set(owner.filter((f): f is number => f !== null));
  return {
    matched: owner.flatMap((f, e) =>
      f === null ? [] : [{ expectation: expectations[e]!, finding: ordered[f]! }],
    ),
    falsePositives: ordered.filter((_, f) => !used.has(f)),
    falseNegatives: expectations.filter((_, e) => owner[e] === null),
  };
}

/** Counts keyed by analyzer, and by analyzer and class, over every scored fixture. */
export interface Totals {
  readonly byAnalyzer: ReadonlyMap<AnalyzerKind, Tally>;
  readonly byClass: ReadonlyMap<string, Tally>;
  readonly combined: Tally;
}

/** The key a class is counted under: its analyzer and its name. */
export function classKey(analyzer: AnalyzerKind, cls: string): string {
  return `${analyzer}/${cls}`;
}

export function total(scores: readonly FixtureScore[]): Totals {
  const byAnalyzer = new Map<AnalyzerKind, Tally>();
  const byClass = new Map<string, Tally>();
  let combined: Tally = { tp: 0, fp: 0, fn: 0 };
  const count = (analyzer: AnalyzerKind, cls: string, field: keyof Tally): void => {
    byAnalyzer.set(analyzer, bump(byAnalyzer.get(analyzer), field));
    byClass.set(classKey(analyzer, cls), bump(byClass.get(classKey(analyzer, cls)), field));
    combined = bump(combined, field);
  };
  for (const each of scores) {
    for (const { expectation } of each.matched)
      count(expectation.analyzer, expectation.class, 'tp');
    for (const finding of each.falsePositives) count(finding.kind, finding.rule, 'fp');
    for (const expectation of each.falseNegatives) {
      count(expectation.analyzer, expectation.class, 'fn');
    }
  }
  return { byAnalyzer, byClass, combined };
}

/** TP / (TP + FP), or null when nothing was found. */
export function precision(tally: Tally): number | null {
  return tally.tp + tally.fp === 0 ? null : tally.tp / (tally.tp + tally.fp);
}

/** TP / (TP + FN), or null when nothing was expected. */
export function recall(tally: Tally): number | null {
  return tally.tp + tally.fn === 0 ? null : tally.tp / (tally.tp + tally.fn);
}

function bump(tally: Tally | undefined, field: keyof Tally): Tally {
  const from = tally ?? { tp: 0, fp: 0, fn: 0 };
  return { ...from, [field]: from[field] + 1 };
}

function namesPath(evidence: readonly Evidence[], path: string): boolean {
  return evidence.some((item) => {
    switch (item.type) {
      case 'span':
        return item.path === path;
      case 'merge-conflict':
        return item.path === path;
      case 'process-output':
        return item.locations.some((location) => location.path === path);
      case 'symbol-trail':
        return item.steps.some((step) => step.location.path === path);
      case 'test':
        return item.location?.path === path;
    }
  });
}

function namesSymbol(finding: Finding, symbol: string): boolean {
  const texts = [finding.title, finding.description];
  for (const item of finding.evidence) {
    if (item.type === 'span') texts.push(item.excerpt);
    if (item.type === 'process-output') texts.push(item.output);
    if (item.type === 'symbol-trail') texts.push(...item.steps.map((step) => step.symbol));
  }
  return texts.some((text) => containsIdentifier(text, symbol));
}

/** `symbol` in `text` with no identifier character on either side of it. */
export function containsIdentifier(text: string, symbol: string): boolean {
  if (symbol === '') return false;
  for (let at = text.indexOf(symbol); at !== -1; at = text.indexOf(symbol, at + 1)) {
    const before = at === 0 ? '' : text[at - 1]!;
    const after = text[at + symbol.length] ?? '';
    if (!isIdentifierChar(before) && !isIdentifierChar(after)) return true;
  }
  return false;
}

function isIdentifierChar(char: string): boolean {
  return /^[A-Za-z0-9_$]$/u.test(char);
}

function coversSide(
  evidence: readonly Evidence[],
  label: Span | null,
  branch: BranchRefId,
): boolean {
  if (label === null) return true;
  return evidence.some(
    (item) =>
      item.type === 'span' &&
      item.branchRefId === branch &&
      item.path === label.path &&
      item.startLine <= label.end &&
      label.start <= Math.max(item.endLine, item.startLine),
  );
}

/** A finding's identity for ordering: never its id, which is new on every run. */
function findingKey(finding: Finding): string {
  const spans = finding.evidence
    .flatMap((item) =>
      item.type === 'span'
        ? [`${item.path}:${String(item.startLine)}-${String(item.endLine)}`]
        : [],
    )
    .join(',');
  return `${finding.kind}\u0000${finding.rule}\u0000${spans}\u0000${finding.title}`;
}

function compare(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}
