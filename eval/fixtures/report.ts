import { execFileSync } from 'node:child_process';
import { arch, cpus, platform, release } from 'node:os';
import { ANALYZER_KINDS } from '../../packages/shared/src/index.js';
import type { AnalyzerKind, Finding } from '../../packages/shared/src/index.js';
import type { Expectation } from './format.js';
import { ANALYZERS } from './runner.js';
import type { FixtureRun } from './runner.js';
import { MATCHING_RULE, classKey, precision, recall, score, total } from './score.js';
import type { FixtureScore, Tally } from './score.js';

/**
 * Where a report was produced. git's merge output has changed between versions,
 * so a number without the git that produced it is not reproducible.
 */
export interface Environment {
  readonly os: string;
  readonly cpu: string;
  readonly node: string;
  readonly git: string;
  /** The Interlock commit measured, and whether the tree had changes on top of it. */
  readonly commit: string;
  readonly dirty: boolean;
}

export function environment(repoRoot: string): Environment {
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repoRoot, ...args], {
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
  return {
    os: `${platform()} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model.trim() ?? 'unknown',
    node: process.version,
    git: git('--version').replace(/^git version /u, ''),
    commit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain', '--untracked-files=no') !== '',
  };
}

/** The whole report, as data: what `fixtures.json` holds and `fixtures.md` renders. */
export interface Report {
  readonly suite: 'fixtures';
  readonly environment: Environment;
  readonly matchingRule: string;
  readonly analyzers: readonly AnalyzerRow[];
  readonly classes: readonly ClassRow[];
  readonly combined: Row;
  readonly fixtures: readonly FixtureRow[];
}

interface Row extends Tally {
  readonly precision: number | null;
  readonly recall: number | null;
}

interface AnalyzerRow extends Row {
  readonly analyzer: AnalyzerKind;
  /** False for an analyzer the set has labels for and that does not exist yet. */
  readonly ran: boolean;
}

interface ClassRow extends Row {
  readonly analyzer: AnalyzerKind;
  readonly class: string;
}

interface FixtureRow {
  readonly id: string;
  readonly covers: string;
  readonly twinOf: string | null;
  /** Why no analyzer is meant to catch this case, for one the set keeps anyway. */
  readonly notDetected: string | null;
  readonly status: 'scored' | 'infra-failure';
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  /** What was found and matched nothing, and what was expected and not found. */
  readonly unmatchedFindings: readonly string[];
  readonly missed: readonly string[];
  /** For an infrastructure failure: which analyzer, or null for the path, and why. */
  readonly failure: { readonly analyzer: AnalyzerKind | null; readonly message: string } | null;
}

export function buildReport(runs: readonly FixtureRun[], env: Environment): Report {
  const scores: FixtureScore[] = [];
  const fixtures: FixtureRow[] = [];
  for (const run of runs) {
    const { fixture } = run;
    if (run.kind === 'infra-failure') {
      fixtures.push({
        id: fixture.id,
        covers: fixture.covers,
        twinOf: fixture.twinOf,
        notDetected: fixture.notDetected ?? null,
        status: 'infra-failure',
        tp: 0,
        fp: 0,
        fn: 0,
        unmatchedFindings: [],
        missed: [],
        failure: { analyzer: run.analyzer, message: run.message },
      });
      continue;
    }
    const scored = score(fixture, run.findings, run.sides);
    scores.push(scored);
    fixtures.push({
      id: fixture.id,
      covers: fixture.covers,
      twinOf: fixture.twinOf,
      notDetected: fixture.notDetected ?? null,
      status: 'scored',
      tp: scored.matched.length,
      fp: scored.falsePositives.length,
      fn: scored.falseNegatives.length,
      unmatchedFindings: scored.falsePositives.map(describeFinding),
      missed: scored.falseNegatives.map(describeExpectation),
      failure: null,
    });
  }

  const totals = total(scores);
  const ran = new Set<AnalyzerKind>(ANALYZERS.map((analyzer) => analyzer.kind));
  // Every analyzer that ran, or that anything expected or found names, in the
  // order the model declares them.
  const named = new Set<AnalyzerKind>([...ran, ...totals.byAnalyzer.keys()]);
  const analyzers = ANALYZER_KINDS.filter((kind) => named.has(kind)).map((analyzer) => ({
    analyzer,
    ran: ran.has(analyzer),
    ...row(totals.byAnalyzer.get(analyzer)),
  }));
  const classes = [...totals.byClass.entries()]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([key, tally]) => {
      const [analyzer, cls] = splitClassKey(key);
      return { analyzer, class: cls, ...row(tally) };
    });

  return {
    suite: 'fixtures',
    environment: env,
    matchingRule: MATCHING_RULE,
    analyzers,
    classes,
    combined: row(totals.combined),
    fixtures,
  };
}

export function renderJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderMarkdown(report: Report): string {
  const { environment: env } = report;
  const table = (head: readonly string[], rows: readonly (readonly string[])[]): string[] => [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((cells) => `| ${cells.join(' | ')} |`),
  ];
  const counts = (r: Row): string[] => [
    String(r.tp),
    String(r.fp),
    String(r.fn),
    ratio(r.precision),
    ratio(r.recall),
  ];
  const lines = [
    '# Golden fixtures',
    '',
    `Generated by \`pnpm eval --suite fixtures\`. Protocol: \`plan_docs/evaluation.md\`.`,
    '',
    '## Environment',
    '',
    `- OS: ${env.os}`,
    `- CPU: ${env.cpu}`,
    `- Node: ${env.node}`,
    `- git: ${env.git}`,
    `- Interlock: ${env.commit}${env.dirty ? ' (with uncommitted changes)' : ''}`,
    '',
    '## Matching rule',
    '',
    report.matchingRule,
    '',
    '## By analyzer',
    '',
    ...table(
      ['Analyzer', 'Ran', 'TP', 'FP', 'FN', 'Precision', 'Recall'],
      report.analyzers.map((r) => [r.analyzer, r.ran ? 'yes' : 'no', ...counts(r)]),
    ),
    '',
    '## By class',
    '',
    ...table(
      ['Analyzer', 'Class', 'TP', 'FP', 'FN', 'Precision', 'Recall'],
      report.classes.map((r) => [r.analyzer, r.class, ...counts(r)]),
    ),
    '',
    '## Combined',
    '',
    ...table(['TP', 'FP', 'FN', 'Precision', 'Recall'], [counts(report.combined)]),
    '',
    '## Fixtures',
    '',
    ...table(
      ['Fixture', 'Case', 'Twin of', 'Status', 'TP', 'FP', 'FN', 'Unmatched'],
      report.fixtures.map((f) => [
        f.id,
        f.covers,
        f.twinOf ?? '',
        f.status,
        String(f.tp),
        String(f.fp),
        String(f.fn),
        [
          ...f.unmatchedFindings.map((text) => `found ${text}`),
          ...f.missed.map((text) => `missed ${text}`),
          ...(f.failure === null
            ? []
            : [`${f.failure.analyzer ?? 'pipeline'}: ${f.failure.message}`]),
        ]
          .join('; ')
          .replaceAll('|', '\\|'),
      ]),
    ),
    '',
    ...notDetectedSection(report.fixtures),
  ];
  return lines.join('\n');
}

function row(tally: Tally | undefined): Row {
  const counted = tally ?? { tp: 0, fp: 0, fn: 0 };
  return { ...counted, precision: rounded(precision(counted)), recall: rounded(recall(counted)) };
}

/** Three places, so a report is the same bytes wherever floating point is printed. */
function rounded(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

function ratio(value: number | null): string {
  return value === null ? '—' : value.toFixed(3);
}

function splitClassKey(key: string): [AnalyzerKind, string] {
  const at = key.indexOf('/');
  return [key.slice(0, at) as AnalyzerKind, key.slice(at + 1)];
}

function describeFinding(finding: Finding): string {
  const paths = [
    ...new Set(finding.evidence.flatMap((item) => (item.type === 'span' ? [item.path] : []))),
  ];
  return `${finding.kind}/${finding.rule} in ${paths.join(', ') || 'no file'}`;
}

function describeExpectation(expectation: Expectation): string {
  return `${classKey(expectation.analyzer, expectation.class)} in ${expectation.path}`;
}

/**
 * The cases the set keeps that no analyzer is meant to catch, with why: listed
 * so a case the protocol names is visibly out of scope rather than missing.
 */
function notDetectedSection(fixtures: readonly FixtureRow[]): string[] {
  const rows = fixtures.filter((f) => f.notDetected !== null);
  if (rows.length === 0) return [];
  return [
    '## Not detected by design',
    '',
    ...rows.map((f) => `- \`${f.id}\`: ${f.notDetected ?? ''}`),
    '',
  ];
}
