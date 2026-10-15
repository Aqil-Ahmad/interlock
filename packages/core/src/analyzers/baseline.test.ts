import { describe, expect, it } from 'vitest';
import type { GitRunner, ShadowRepo } from '../git/repo-handle.js';
import { BASELINE_VERSION, cacheKey, identify, mergeInduced, unjudgeable } from './baseline.js';
import type { BaselineTree, IdentifiedReport, Rename } from './baseline.js';
import { TYPESCRIPT_VERSION } from './typecheck-paths.js';
import type { ConfigDiagnostic, FileDiagnostic } from './typecheck.js';

/**
 * The comparison over reports built by hand, where every count and name is
 * chosen: the cases a real tree reaches only by contrivance — three copies,
 * a rename seen by one tree's diff alone — are a line each here.
 */

let line = 0;

/** A file diagnostic whose identity is its code, file, message and span; its line is new each time. */
const diagnostic = (
  file: string,
  span = 'span',
  code = 2322,
  message = 'Type is wrong.',
): IdentifiedReport['files'][number] => {
  line += 1;
  const found: FileDiagnostic = {
    code,
    category: 'error',
    message,
    file,
    start: line * 10,
    length: 4,
    line,
    column: 1,
  };
  return { diagnostic: found, message, span };
};

const config = (
  code: number,
  category: ConfigDiagnostic['category'] = 'error',
): IdentifiedReport['config'][number] => {
  const found: ConfigDiagnostic = {
    code,
    category,
    message: `Option ${code} is wrong.`,
    file: 'tsconfig.json',
    start: 0,
    length: 1,
  };
  return { diagnostic: found, message: found.message, span: null };
};

const report = (
  files: IdentifiedReport['files'] = [],
  configs: IdentifiedReport['config'] = [],
): IdentifiedReport => ({ files, config: configs });

const trees = (
  given: Partial<Record<BaselineTree, IdentifiedReport>>,
): Record<BaselineTree, IdentifiedReport> => ({
  base: given.base ?? report(),
  a: given.a ?? report(),
  b: given.b ?? report(),
  merge: given.merge ?? report(),
});

const copies = (count: number, file = 'src/a.ts'): IdentifiedReport =>
  report(Array.from({ length: count }, () => diagnostic(file)));

describe('mergeInduced', () => {
  it('reports what only the merge has', () => {
    const found = mergeInduced(trees({ merge: copies(1) }), []);
    expect(found.files).toHaveLength(1);
    expect(found.config).toEqual([]);
  });

  it.each([{ tree: 'base' as const }, { tree: 'a' as const }, { tree: 'b' as const }])(
    'does not report what the $tree tree has too, on whatever line',
    ({ tree }) => {
      expect(mergeInduced(trees({ [tree]: copies(1), merge: copies(1) }), []).files).toEqual([]);
    },
  );

  it.each([
    { name: 'the code', other: diagnostic('src/a.ts', 'span', 2345) },
    { name: 'the file', other: diagnostic('src/b.ts') },
    { name: 'the message', other: diagnostic('src/a.ts', 'span', 2322, 'Type is other.') },
    { name: 'the span text', other: diagnostic('src/a.ts', 'other span') },
  ])('tells diagnostics apart by $name', ({ other }) => {
    const found = mergeInduced(trees({ base: report([other]), merge: copies(1) }), []);
    expect(found.files).toHaveLength(1);
  });

  it.each([
    { base: 1, a: 1, b: 1, merge: 2, induced: 1 },
    { base: 0, a: 2, b: 0, merge: 2, induced: 0 },
    { base: 0, a: 0, b: 2, merge: 3, induced: 1 },
    // Each side added one over the base: the merge carries both.
    { base: 0, a: 1, b: 1, merge: 2, induced: 0 },
    { base: 1, a: 2, b: 2, merge: 3, induced: 0 },
    { base: 1, a: 2, b: 2, merge: 4, induced: 1 },
    // One side added a copy and the other removed one: either alone explains the merge.
    { base: 1, a: 2, b: 0, merge: 2, induced: 0 },
    { base: 1, a: 0, b: 2, merge: 2, induced: 0 },
    // A side fixed one: the merge keeping the base's count is not new.
    { base: 2, a: 1, b: 2, merge: 2, induced: 0 },
    { base: 0, a: 0, b: 0, merge: 3, induced: 3 },
  ])(
    'counts copies: base $base, A $a, B $b, merge $merge leaves $induced',
    ({ base, a, b, merge, induced }) => {
      const found = mergeInduced(
        trees({ base: copies(base), a: copies(a), b: copies(b), merge: copies(merge) }),
        [],
      );
      expect(found.files).toHaveLength(induced);
    },
  );

  it('reports the copies past the count, in the merge’s order', () => {
    const merge = copies(3);
    const found = mergeInduced(trees({ base: copies(1), merge }), []);
    expect(found.files).toEqual([merge.files[1]!.diagnostic, merge.files[2]!.diagnostic]);
  });

  it('compares a renamed file under one name', () => {
    const renames: Rename[] = [['src/old.ts', 'src/new.ts']];
    const separate = trees({ b: copies(1, 'src/old.ts'), merge: copies(1, 'src/new.ts') });
    expect(mergeInduced(separate, []).files).toHaveLength(1);
    expect(mergeInduced(separate, renames).files).toEqual([]);
    // Either direction: the class has one name whichever is asked.
    const reversed = trees({ b: copies(1, 'src/new.ts'), merge: copies(1, 'src/old.ts') });
    expect(mergeInduced(reversed, renames).files).toEqual([]);
  });

  it('joins renames each seen by one diff into one class', () => {
    const renames: Rename[] = [
      ['src/old.ts', 'src/mid.ts'],
      ['src/new.ts', 'src/mid.ts'],
      ['src/zzz.ts', 'src/old.ts'],
    ];
    for (const [one, two] of [
      ['src/old.ts', 'src/new.ts'],
      ['src/zzz.ts', 'src/new.ts'],
      ['src/new.ts', 'src/zzz.ts'],
      ['src/mid.ts', 'src/zzz.ts'],
    ] as const) {
      expect(
        mergeInduced(trees({ a: copies(1, one), merge: copies(1, two) }), renames).files,
      ).toEqual([]);
    }
    // A path already joined, joined again from elsewhere: the class grows, nothing leaves it.
    const regrown: Rename[] = [
      ['src/b.ts', 'src/c.ts'],
      ['src/b.ts', 'src/a.ts'],
    ];
    expect(
      mergeInduced(trees({ a: copies(1, 'src/c.ts'), merge: copies(1, 'src/a.ts') }), regrown)
        .files,
    ).toEqual([]);
    // An unrelated rename joins nothing else.
    expect(
      mergeInduced(trees({ a: copies(1, 'src/old.ts'), merge: copies(1, 'src/other.ts') }), [
        ...renames,
        ['src/other.ts', 'src/elsewhere.ts'],
      ]).files,
    ).toHaveLength(1);
  });

  it('keeps configuration diagnostics apart from files', () => {
    const found = mergeInduced(
      trees({ base: report([], [config(5053)]), merge: report([], [config(5053), config(5101)]) }),
      [],
    );
    expect(found.files).toEqual([]);
    expect(found.config.map((d) => d.code)).toEqual([5101]);
  });
});

describe('unjudgeable', () => {
  it('refuses a report whose configuration has an error, naming each code once', () => {
    expect(unjudgeable(report([], [config(6046), config(6046), config(5023)]))).toBe(
      'its configuration has 3 errors (TS6046, TS5023)',
    );
    expect(unjudgeable(report([], [config(6046)]))).toBe('its configuration has 1 error (TS6046)');
  });

  it('accepts file errors, and configuration that only warns', () => {
    expect(unjudgeable(report([diagnostic('src/a.ts')], [config(6385, 'warning')]))).toBeNull();
  });
});

describe('cacheKey', () => {
  const parts = {
    treeOid: 'a'.repeat(40),
    dependencyTreeOid: 'b'.repeat(40),
    project: 'tsconfig.json',
  };

  it('changes with each part', () => {
    const keys = new Set([
      cacheKey(parts),
      cacheKey({ ...parts, treeOid: 'c'.repeat(40) }),
      cacheKey({ ...parts, dependencyTreeOid: 'c'.repeat(40) }),
      cacheKey({ ...parts, project: 'tsconfig.check.json' }),
    ]);
    expect(keys.size).toBe(4);
  });

  it('names the comparison’s version and the compiler’s', () => {
    expect(cacheKey(parts)).toContain(TYPESCRIPT_VERSION);
    expect(JSON.parse(cacheKey(parts))).toContain(BASELINE_VERSION);
  });
});

describe('identify', () => {
  const shadow: ShadowRepo = {
    kind: 'shadow',
    rootPath: '/data/shadows/repo',
    gitDir: '/data/shadows/repo',
    originPath: '/user/repo',
    generation: 'test',
  };
  const tree = 'd'.repeat(40);

  /** A runner answering `cat-file blob` from a table, and recording what was asked. */
  const blobs = (contents: Record<string, string>) => {
    const asked: (readonly string[])[] = [];
    const runner: GitRunner = {
      run: (_repo, args) => {
        asked.push(args);
        const spec = args[2]!;
        const path = spec.slice(spec.indexOf(':') + 1);
        const content = contents[path];
        return Promise.resolve(
          content === undefined
            ? { stdout: '', stderr: 'fatal: not a blob', exitCode: 128 }
            : { stdout: content, stderr: '', exitCode: 0 },
        );
      },
    };
    return { runner, asked };
  };

  const at = (file: string, start: number, length: number, message = 'Wrong.'): FileDiagnostic => ({
    code: 2322,
    category: 'error',
    message,
    file,
    start,
    length,
    line: 1,
    column: start + 1,
  });

  it('identifies a span by the text it covers in the tree, wherever it sits', async () => {
    const { runner, asked } = blobs({ 'src/a.ts': 'xx wrong yy wrong', 'src/b.ts': 'right' });
    const found = await identify(
      {
        files: [at('src/a.ts', 3, 5), at('src/a.ts', 12, 5), at('src/b.ts', 0, 5)],
        config: [],
        projects: [],
      },
      { runner, shadow, treeOid: tree, root: '/slot', dependencyRoot: '/deps' },
    );
    expect(found.files[0]!.span).toBe(found.files[1]!.span);
    expect(found.files[0]!.span).not.toBe(found.files[2]!.span);
    // Read once per file, from the tree's object.
    expect(asked).toEqual([
      ['cat-file', 'blob', `${tree}:src/a.ts`],
      ['cat-file', 'blob', `${tree}:src/b.ts`],
    ]);
  });

  it('reads no span for a dependency’s file, which is not in the tree', async () => {
    const { runner, asked } = blobs({});
    const found = await identify(
      { files: [at('node_modules/x/index.d.ts', 0, 3)], config: [], projects: [] },
      { runner, shadow, treeOid: tree, root: '/slot', dependencyRoot: '/deps' },
    );
    expect(found.files[0]!.span).toBeNull();
    expect(asked).toEqual([]);
  });

  it('fails rather than guess when a file in the tree cannot be read', async () => {
    const { runner } = blobs({});
    await expect(
      identify(
        { files: [at('src/gone.ts', 0, 3)], config: [], projects: [] },
        { runner, shadow, treeOid: tree, root: '/slot', dependencyRoot: '/deps' },
      ),
    ).rejects.toMatchObject({ code: 'GIT_COMMAND_FAILED', infra: true });
  });

  it('takes the check’s own paths out of messages, the longer first', async () => {
    const { runner } = blobs({ 'src/a.ts': 'wrong' });
    const found = await identify(
      {
        files: [at('src/a.ts', 0, 5, "File '/pool/slot/src/a.ts' is not under '/pool/slot-deps'.")],
        config: [
          {
            code: 6059,
            category: 'error',
            message: "rootDir '/pool/slot/lib' is outside.",
            file: null,
            start: null,
            length: null,
          },
        ],
        projects: [],
      },
      { runner, shadow, treeOid: tree, root: '/pool/slot', dependencyRoot: '/pool/slot-deps' },
    );
    expect(found.files[0]!.message).toBe("File '<tree>/src/a.ts' is not under '<tree>'.");
    expect(found.config[0]!.message).toBe("rootDir '<tree>/lib' is outside.");
    // The report itself is left as the compiler wrote it.
    expect(found.files[0]!.diagnostic.message).toContain('/pool/slot/src/a.ts');
  });
});
