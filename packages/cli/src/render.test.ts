import { ulid } from '@interlock/shared';
import type { BranchRef, BranchRefId, Repo, RepoId, SnapshotId } from '@interlock/shared';
import { describe, expect, it } from 'vitest';
import { branchState, renderJson, renderStatus, safeText } from './render.js';
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
    { repo: repo(overrides), branches },
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
      { repo: repo({ rootPath: '/work/one' }), branches: [branch()] },
      { repo: repo({ rootPath: '/work/two' }), branches: [branch()] },
    ]);
    expect(out).toContain('/work/one');
    expect(out).toContain('/work/two');
  });

  it('says a repository has no branches rather than showing nothing under it', () => {
    expect(renderStatus(view([]))).toContain('no branches');
  });
});

describe('renderJson', () => {
  it('carries the same facts as the table', () => {
    const views = [
      {
        repo: repo(),
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
      renderJson([{ repo: repo(), branches: [dirty({ untracked: [`${ESC}x`] })] }]),
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
    const text = renderJson([{ repo: repo(), branches: [dirty({ untracked: paths })] }]);

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
      renderJson([{ repo: repo(), branches: [dirty({ untracked: paths })] }]),
    ) as { repos: { branches: { files: { untracked: string[] } | null }[] }[] };

    expect(parsed.repos[0]?.branches[0]?.files?.untracked).toStrictEqual(paths);
  });
});
