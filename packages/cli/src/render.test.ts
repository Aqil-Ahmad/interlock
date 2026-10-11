import { ulid } from '@interlock/shared';
import type {
  AgentSession,
  AgentSessionId,
  BranchRef,
  BranchRefId,
  Finding,
  FindingId,
  Repo,
  RepoId,
  SnapshotId,
  SpeculativeRunId,
} from '@interlock/shared';
import { describe, expect, it } from 'vitest';
import type { BudgetReport, BudgetWindow, CheckReport } from './client/index.js';
import {
  branchState,
  findingView,
  renderBudget,
  renderCheck,
  renderCheckJson,
  renderDismissal,
  renderDismissalJson,
  renderJson,
  renderStatus,
  safeText,
} from './render.js';
import type { RepoView } from './render.js';

/**
 * The report as a pure function of what the daemon said, which is what lets
 * every case below — an unreadable worktree, a path with an escape in it, a
 * branch that touched two thousand files — be constructed rather than staged.
 */

const ESC = String.fromCharCode(0x1b);
/** CSI as one character: what `ESC [` does, without the ESC. */
const CSI = String.fromCharCode(0x9b);
const DEL = String.fromCharCode(0x7f);
const ALM = String.fromCharCode(0x061c);
const LRM = String.fromCharCode(0x200e);
const RLO = String.fromCharCode(0x202e);

function repo(overrides: Partial<Repo> = {}): Repo {
  const id = ulid<RepoId>();
  return {
    id,
    rootPath: '/work/repo',
    defaultBranch: 'main',
    shadowPath: `/data/shadows/${id}`,
    config: {},
    discoveredAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function branch(overrides: Partial<BranchRef> = {}): BranchRef {
  return {
    id: ulid<BranchRefId>(),
    repoId: ulid<RepoId>(),
    ref: 'refs/heads/main',
    name: 'main',
    headSha: 'a'.repeat(40),
    worktreePath: '/work/repo',
    dirty: {
      isDirty: false,
      snapshotId: null,
      stagedFiles: [],
      unstagedFiles: [],
      untrackedFiles: [],
      capturedAt: '2026-01-01T00:00:00.000Z',
    },
    sessionId: null,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function dirty(files: Partial<Record<'staged' | 'unstaged' | 'untracked', string[]>>): BranchRef {
  return branch({
    name: 'feature/login',
    dirty: {
      isDirty: true,
      snapshotId: ulid<SnapshotId>(),
      stagedFiles: files.staged ?? [],
      unstagedFiles: files.unstaged ?? [],
      untrackedFiles: files.untracked ?? [],
      capturedAt: '2026-01-01T00:00:00.000Z',
    },
  });
}

describe('safeText', () => {
  it('leaves an ordinary path exactly as it is', () => {
    expect(safeText('src/auth/session.ts')).toBe('src/auth/session.ts');
    expect(safeText('a file with spaces.md')).toBe('a file with spaces.md');
    expect(safeText('café — naïve.txt')).toBe('café — naïve.txt');
  });

  it('renders an escape sequence inert', () => {
    // Left alone this clears the screen and repositions the cursor, so a path
    // can erase the report that was about to name it.
    expect(safeText(`${ESC}[2J${ESC}[H`)).toBe('\\x1b[2J\\x1b[H');
  });

  it('escapes a newline, so one path cannot pose as two lines', () => {
    expect(safeText('a.txt\nfeature/other  clean')).toBe('a.txt\\x0afeature/other  clean');
  });

  it('escapes the C1 block, where CSI is one character rather than two', () => {
    // A guard against ESC alone lets the compact form of every sequence past.
    expect(safeText(`${CSI}31mred.ts`)).toBe('\\x9b31mred.ts');
    expect(safeText(DEL)).toBe('\\x7f');
  });

  it('escapes every code point Unicode calls a bidi control', () => {
    // Enumerated rather than sampled, because the list this used to hand-hold
    // was missing one: U+061C, which behaves like the right-to-left mark.
    const controls: string[] = [];
    for (let point = 0; point <= 0xffff; point++) {
      const character = String.fromCodePoint(point);
      if (/\p{Bidi_Control}/u.test(character)) controls.push(character);
    }
    expect(controls.length).toBeGreaterThan(0);
    for (const character of controls) {
      expect(safeText(character), character.codePointAt(0)?.toString(16)).not.toBe(character);
    }
  });

  it('escapes the marks as well as the overrides', () => {
    expect(safeText(ALM)).toBe('\\u{61c}');
    expect(safeText(LRM)).toBe('\\u{200e}');
    expect(safeText(RLO)).toBe('\\u{202e}');
  });

  it('escapes the bidi controls that reorder what is displayed', () => {
    // The trojan-source family: the bytes on disk and the name on screen differ.
    expect(safeText('‮anything')).toBe('\\u{202e}anything');
    expect(safeText('⁦x⁩')).toBe('\\u{2066}x\\u{2069}');
  });

  it('keeps a surrogate pair whole rather than escaping half of it', () => {
    expect(safeText('emoji 🙂 here')).toBe('emoji 🙂 here');
  });
});

describe('branchState', () => {
  it('reads an unreadable worktree as unknown, never as clean', () => {
    // The one display that is actively misleading: "nothing to see" is exactly
    // wrong about work nobody could look at.
    expect(branchState(branch({ dirty: null }))).toBe('unknown');
    expect(branchState(branch())).toBe('clean');
    expect(branchState(dirty({ unstaged: ['a.ts'] }))).toBe('dirty');
  });
});

describe('renderStatus', () => {
  const view = (branches: BranchRef[], overrides: Partial<Repo> = {}): RepoView[] => [
    { repo: repo(overrides), branches, sessions: [] },
  ];

  it('says so when nothing is watched, rather than printing an empty report', () => {
    const out = renderStatus([]);
    expect(out).toContain('No repositories are being watched');
    expect(out).toContain('repos');
  });

  it('names the repository, its default branch and every branch in it', () => {
    const out = renderStatus(view([branch(), dirty({ unstaged: ['src/a.ts'] })]));
    expect(out).toContain('/work/repo');
    expect(out).toContain('default main');
    expect(out).toContain('main');
    expect(out).toContain('feature/login');
  });

  it('shows touched files grouped the way git groups them', () => {
    const out = renderStatus(
      view([dirty({ staged: ['src/a.ts'], unstaged: ['src/b.ts'], untracked: ['notes.md'] })]),
    );
    expect(out).toContain('staged');
    expect(out).toContain('src/a.ts');
    expect(out).toContain('unstaged');
    expect(out).toContain('src/b.ts');
    expect(out).toContain('untracked');
    expect(out).toContain('notes.md');
    expect(out).toContain('3 files');
  });

  it('writes unknown, and why, for a worktree that could not be read', () => {
    const out = renderStatus(view([branch({ name: 'feature/gone', dirty: null })]));
    expect(out).toContain('unknown');
    expect(out).toContain('worktree could not be read');
    // The word that must not appear against this branch, in any casing.
    expect(out).not.toMatch(/clean/iu);
    // Nor a file count, which would be zero and would read as "nothing changed".
    expect(out).not.toContain('0 file');
  });

  it('caps the file list and says how many it did not print', () => {
    const paths = Array.from({ length: 25 }, (_, index) => `src/file${String(index)}.ts`);
    const out = renderStatus(view([dirty({ unstaged: paths })]), { fileLimit: 3 });
    expect(out).toContain('src/file0.ts');
    expect(out).toContain('src/file2.ts');
    expect(out).not.toContain('src/file3.ts');
    expect(out).toContain('and 22 more');
  });

  it('renders a path the repository chose without letting it reach the terminal', () => {
    const out = renderStatus(view([dirty({ untracked: [`${ESC}[31mred.ts`] })]));
    expect(out).not.toContain(ESC);
    expect(out).toContain('\\x1b[31mred.ts');
  });

  it('renders a branch name the same way', () => {
    const out = renderStatus(view([branch({ name: `main${ESC}[2K` })]));
    expect(out).not.toContain(ESC);
  });

  it('separates repositories rather than running them together', () => {
    const out = renderStatus([
      { repo: repo({ rootPath: '/work/one' }), sessions: [], branches: [branch()] },
      { repo: repo({ rootPath: '/work/two' }), sessions: [], branches: [branch()] },
    ]);
    expect(out).toContain('/work/one');
    expect(out).toContain('/work/two');
  });

  it('says a repository has no branches rather than showing nothing under it', () => {
    expect(renderStatus(view([]))).toContain('no branches');
  });
});

describe('the owning session', () => {
  const session = (
    branchRefId: BranchRefId,
    overrides: Partial<AgentSession> = {},
  ): AgentSession => ({
    id: ulid<AgentSessionId>(),
    repoId: ulid<RepoId>(),
    kind: 'claude-code',
    externalSessionId: 'sess-1',
    branchRefId,
    attribution: 'reported',
    cwd: '/work/repo',
    pid: 100,
    startedAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    ...overrides,
  });

  it('names the agent beside the branch it drives', () => {
    const owner = session(ulid<BranchRefId>());
    const driven = branch({ name: 'feature', sessionId: owner.id });
    const out = renderStatus([{ repo: repo(), branches: [driven, branch()], sessions: [owner] }]);
    expect(out).toContain('feature');
    expect(out).toMatch(/feature.*claude-code/u);
    expect(out).not.toMatch(/main.*claude-code/u);
  });

  it('says when the branch was a guess rather than a report', () => {
    const owner = session(ulid<BranchRefId>(), { attribution: 'inferred' });
    const out = renderStatus([
      { repo: repo(), branches: [branch({ sessionId: owner.id })], sessions: [owner] },
    ]);
    expect(out).toContain('claude-code (inferred)');
  });

  it('shows nothing for a branch whose session is not in the live list', () => {
    // The store may still name a session the registry has since reaped.
    const out = renderStatus([
      { repo: repo(), branches: [branch({ sessionId: ulid<AgentSessionId>() })], sessions: [] },
    ]);
    expect(out).not.toContain('claude-code');
    expect(out).not.toContain('inferred');
  });

  it('carries the owner into the JSON, with the id the agent chose', () => {
    const owner = session(ulid<BranchRefId>(), { externalSessionId: 'abc' });
    const parsed = JSON.parse(
      renderJson([
        { repo: repo(), branches: [branch({ sessionId: owner.id })], sessions: [owner] },
      ]),
    ) as { repos: { branches: { owner: unknown }[] }[] };
    expect(parsed.repos[0]?.branches[0]?.owner).toStrictEqual({
      kind: 'claude-code',
      attribution: 'reported',
      externalSessionId: 'abc',
    });
  });
});

describe('renderJson', () => {
  it('carries the same facts as the table', () => {
    const views = [
      {
        repo: repo(),
        sessions: [],
        branches: [
          dirty({ staged: ['src/a.ts'], untracked: ['notes.md'] }),
          branch({ name: 'feature/gone', dirty: null }),
        ],
      },
    ];
    const parsed = JSON.parse(renderJson(views)) as {
      repos: {
        rootPath: string;
        branches: { name: string; state: string; fileCount: number | null }[];
      }[];
    };

    expect(parsed.repos[0]?.rootPath).toBe('/work/repo');
    expect(parsed.repos[0]?.branches[0]).toMatchObject({
      name: 'feature/login',
      state: 'dirty',
      fileCount: 2,
    });
    // Not zero: a count for a worktree nobody read is not a count of nothing.
    expect(parsed.repos[0]?.branches[1]).toMatchObject({ state: 'unknown', fileCount: null });
  });

  it('leaves a path as it is on disk, since the consumer is not a terminal', () => {
    const parsed = JSON.parse(
      renderJson([{ repo: repo(), sessions: [], branches: [dirty({ untracked: [`${ESC}x`] })] }]),
    ) as {
      repos: { branches: { files: { untracked: string[] } | null }[] }[];
    };
    expect(parsed.repos[0]?.branches[0]?.files?.untracked[0]).toBe(`${ESC}x`);
  });

  it('leaves no control character raw in the document, whatever JSON escapes', () => {
    // `JSON.stringify` escapes U+0000-U+001F and nothing else, so DEL, the C1
    // block and every bidi control reach the output verbatim — and this is
    // piped to a terminal as often as it is parsed.
    const paths = [`${ESC}a`, `${CSI}b`, `${DEL}c`, `${RLO}d`, `${ALM}e`, `${LRM}f`];
    const text = renderJson([
      { repo: repo(), sessions: [], branches: [dirty({ untracked: paths })] },
    ]);

    for (const raw of [ESC, CSI, DEL, RLO, ALM, LRM]) {
      expect(text, raw.codePointAt(0)?.toString(16)).not.toContain(raw);
    }
    expect(text).toContain('\\u001b');
    expect(text).toContain('\\u009b');
    expect(text).toContain('\\u202e');
  });

  it('parses back to the paths that are on disk, byte for byte', () => {
    // The escaping must cost the consumer nothing: an escaped name is a
    // different name, and a consumer wants one it can open.
    const paths = [`${ESC}a`, `${CSI}b`, `${DEL}c`, `${RLO}d`, `${ALM}e`];
    const parsed = JSON.parse(
      renderJson([{ repo: repo(), sessions: [], branches: [dirty({ untracked: paths })] }]),
    ) as { repos: { branches: { files: { untracked: string[] } | null }[] }[] };

    expect(parsed.repos[0]?.branches[0]?.files?.untracked).toStrictEqual(paths);
  });
});

describe('renderCheck', () => {
  /** ESC, BEL, CSI and a bidi override: each acts on a terminal if it reaches one. */
  const CONTROLS = ['\u001b', '\u0007', '\u009b', '\u202e'];
  const a = ulid<BranchRefId>();
  const b = ulid<BranchRefId>();

  /** A conflict whose every field the repository chose carries an escape. */
  const report = (): CheckReport => ({
    repoId: ulid<RepoId>(),
    a: { id: a, name: 'one\u001b[2J' },
    b: { id: b, name: 'two' },
    mergeBaseSha: 'a'.repeat(40),
    clean: false,
    findings: [
      {
        id: ulid<FindingId>(),
        runId: ulid<SpeculativeRunId>(),
        kind: 'textual',
        rule: 'overlapping-edit',
        severity: 'medium',
        confidence: 1,
        status: 'open',
        title: 'Both branches changed the same lines',
        description: '',
        // Named the other way round from the check, as a Finding may be.
        attribution: { branchA: b, branchB: a, originBranch: null, rationale: '' },
        evidence: [
          {
            type: 'span',
            branchRefId: a,
            path: 'src/\u009b31mx.ts',
            startLine: 2,
            endLine: 3,
            excerpt: 'line \u001b]0;pwned\u0007\n\u202eevil',
          },
        ],
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
      },
    ],
    dismissed: [],
  });

  it('escapes every piece of the repository it prints, excerpts a line at a time', () => {
    const text = renderCheck(report());

    for (const control of CONTROLS) expect(text).not.toContain(control);
    expect(text).toContain('one\\x1b[2J');
    expect(text).toContain('src/\\x9b31mx.ts:2-3');
    expect(text).toContain('│ line \\x1b]0;pwned\\x07\n');
    expect(text).toContain('│ \\u{202e}evil\n');
  });

  it('puts each side in the order the pair was named, whatever the Finding says', () => {
    const view = findingView(report().findings[0]!, report());
    expect(view.sides.map((side) => side.branch)).toEqual(['one\u001b[2J', 'two']);
    expect(view.sides[0].spans).toHaveLength(1);
    expect(view.sides[1].spans).toEqual([]);
  });

  it('keeps names as they are in JSON, with every control escaped', () => {
    const json = renderCheckJson(report());
    for (const control of CONTROLS) expect(json).not.toContain(control);
    const parsed = JSON.parse(json) as { a: { name: string } };
    expect(parsed.a.name).toBe('one\u001b[2J');
  });

  it('prints each Finding’s whole id, which is what `dismiss` takes', () => {
    const shown = report();
    expect(renderCheck(shown)).toContain(`\n  finding ${shown.findings[0]!.id}\n`);
  });

  /** The report's conflict, dismissed with a note and a path the repository chose. */
  const dismissedReport = (): CheckReport => {
    const shown = report();
    const finding: Finding = {
      ...shown.findings[0]!,
      status: 'dismissed',
      evidence: [...shown.findings[0]!.evidence, mergeConflict('src/\u001b[31mx.ts')],
      dismissal: { reason: 'wrong', note: 'n', dismissedAt: '2026-01-02T00:00:00.000Z' },
    };
    return { ...shown, clean: true, findings: [], dismissed: [finding] };
  };

  it('never calls a pair holding a dismissed conflict clean, and lists it escaped', () => {
    const shown = dismissedReport();
    const text = renderCheck(shown);

    expect(text).not.toContain('merge cleanly');
    expect(text).toContain('one\\x1b[2J and two: no open conflicts, 1 dismissed');
    expect(text).toContain(
      `  overlapping-edit  src/\\x1b[31mx.ts  as wrong  finding ${shown.dismissed[0]!.id}\n`,
    );
    for (const control of CONTROLS) expect(text).not.toContain(control);
  });

  it('lists dismissed conflicts beside open ones, and carries them in JSON', () => {
    const shown = { ...dismissedReport(), clean: false, findings: report().findings };
    expect(renderCheck(shown)).toContain('and two: 1 conflict');
    expect(renderCheck(shown)).toContain(
      'Dismissed, and not raised while both sides stay unchanged:',
    );

    const parsed = JSON.parse(renderCheckJson(shown)) as {
      dismissed: { rule: string; reason: string; note: string }[];
    };
    expect(parsed.dismissed).toMatchObject([
      { rule: 'overlapping-edit', reason: 'wrong', note: 'n' },
    ]);
  });
});

/** A merge-conflict evidence entry at a path, with a blob on each side. */
function mergeConflict(path: string): Finding['evidence'][number] {
  return {
    type: 'merge-conflict',
    mergeBaseSha: 'b'.repeat(40),
    commitA: 'c'.repeat(40),
    commitB: 'd'.repeat(40),
    path,
    conflictTypes: ['CONFLICT (contents)'],
    base: null,
    sideA: { path, mode: '100644', oid: '1'.repeat(40) },
    sideB: { path, mode: '100644', oid: '2'.repeat(40) },
  };
}

describe('renderBudget', () => {
  const window = (overrides: Partial<BudgetWindow> = {}): BudgetWindow => ({
    hours: 24,
    since: '2026-10-05T15:00:00.000Z',
    until: '2026-10-06T14:35:12.000Z',
    raised: 0,
    dismissedWrong: 0,
    dismissedKnown: 0,
    rate: null,
    delivered: null,
    rules: [],
    ...overrides,
  });
  const rule = (name: string, raised: number, wrong: number) => ({
    kind: 'textual' as const,
    rule: name,
    raised,
    dismissedWrong: wrong,
    dismissedKnown: 0,
    rate: raised === 0 ? null : wrong / raised,
  });

  it('says no data for a window with nothing raised, never 0%, and delivered as not measured', () => {
    const text = renderBudget({
      windows: [window(), window({ hours: 168, since: '2026-09-29T15:00:00.000Z' })],
    });

    expect(text).toContain(
      '  last 24 hours  since 2026-10-05 15:00 UTC  0 raised, rate: no data\n',
    );
    expect(text).toContain(
      '  last 7 days    since 2026-09-29 15:00 UTC  0 raised, rate: no data\n',
    );
    expect(text).toContain('  delivered      not measured\n');
    expect(text).not.toMatch(/0%|delivered +0/u);
    expect(text).toContain('No rule had a Finding dismissed as wrong in the last 7 days.');
  });

  it('gives the counts and the rate, and lists the rules most dismissed as wrong', () => {
    const rules = [
      rule('modify-delete', 4, 3),
      rule('overlapping-edit', 10, 0),
      ...['a', 'b', 'c', 'd', 'e'].map((name) => rule(`rule-${name}`, 2, 1)),
    ];
    const budget: BudgetReport = {
      windows: [
        window({ raised: 3, dismissedWrong: 0, dismissedKnown: 1, rate: 0 }),
        window({ hours: 168, raised: 20, dismissedWrong: 8, dismissedKnown: 2, rate: 0.4, rules }),
      ],
    };

    const text = renderBudget(budget);

    expect(text).toContain('3 raised, 0 dismissed as wrong (0%), 1 as known\n');
    expect(text).toContain('20 raised, 8 dismissed as wrong (40%), 2 as known\n');
    expect(text).toContain(
      'Most dismissed as wrong, last 7 days:\n    modify-delete  3 of 4 (75%)\n',
    );
    expect(text).not.toContain('overlapping-edit');
    expect(text).toContain('    rule-d         1 of 2 (50%)\n    … and 1 more\n');
    expect(text).not.toContain('rule-e');
  });

  it('escapes a rule name, which comes from the daemon', () => {
    const text = renderBudget({
      windows: [
        window({ raised: 1, dismissedWrong: 1, rate: 1, rules: [rule(`x${ESC}[2J`, 1, 1)] }),
      ],
    });
    expect(text).not.toContain(ESC);
    expect(text).toContain('x\\x1b[2J  1 of 1 (100%)');
  });

  it('carries the budget in the status JSON, delivered as null', () => {
    const budget: BudgetReport = { windows: [window()] };
    const parsed = JSON.parse(renderJson([], budget)) as { budget: BudgetReport };
    expect(parsed.budget).toEqual(budget);
    expect(parsed.budget.windows[0]!.delivered).toBeNull();
  });
});

describe('renderDismissal', () => {
  const dismissed = (note: string | null): Finding => ({
    id: ulid<FindingId>(),
    runId: ulid<SpeculativeRunId>(),
    kind: 'textual',
    rule: 'overlapping-edit',
    severity: 'medium',
    confidence: 1,
    status: 'dismissed',
    title: 't',
    description: '',
    attribution: {
      branchA: ulid<BranchRefId>(),
      branchB: ulid<BranchRefId>(),
      originBranch: null,
      rationale: '',
    },
    evidence: [mergeConflict(`cfg${RLO}.ts`)],
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    resolvedAt: null,
    dismissal: { reason: 'known', note, dismissedAt: '2026-01-02T00:00:00.000Z' },
  });

  it('says what was dismissed and how long it lasts, the path and the note escaped', () => {
    const finding = dismissed(`line one ${ESC}]0;pwned\u0007\n${CSI}31m two`);
    const text = renderDismissal(finding);

    for (const control of [ESC, CSI, RLO, '\u0007']) expect(text).not.toContain(control);
    expect(text).toBe(
      [
        `Dismissed ${finding.id} as known: overlapping-edit at cfg\\u{202e}.ts`,
        'It stays dismissed while both sides of cfg\\u{202e}.ts are unchanged.',
        'note: line one \\x1b]0;pwned\\x07',
        '      \\x9b31m two',
        '',
      ].join('\n'),
    );
  });

  it('prints no note line without a note, and the same facts as JSON', () => {
    const finding = dismissed(null);
    expect(renderDismissal(finding)).not.toContain('note:');

    const json = renderDismissalJson({
      ...finding,
      dismissal: { ...finding.dismissal!, note: `a${ESC}` },
    });
    expect(json).not.toContain(ESC);
    expect(JSON.parse(json)).toEqual({
      id: finding.id,
      kind: 'textual',
      rule: 'overlapping-edit',
      path: `cfg${RLO}.ts`,
      reason: 'known',
      note: `a${ESC}`,
      dismissedAt: '2026-01-02T00:00:00.000Z',
    });
  });
});
