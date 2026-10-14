import { describe, expect, it } from 'vitest';
import { matchSegment, matchSegments, readPnpmWorkspacePackages, stripJsonc } from './toolchain.js';

describe('stripJsonc', () => {
  const parse = (source: string): unknown => JSON.parse(stripJsonc(source));

  it('drops line and block comments outside strings', () => {
    expect(parse('// head\n{ "a": 1, /* mid */ "b": 2 } // tail')).toEqual({ a: 1, b: 2 });
  });

  it('keeps comment-like text inside strings, escaped quotes included', () => {
    expect(parse('{ "url": "http://x/*y*/", "q": "say \\"//hi\\"" }')).toEqual({
      url: 'http://x/*y*/',
      q: 'say "//hi"',
    });
  });

  it('drops a trailing comma before a closer, through whitespace and comments', () => {
    expect(parse('{ "a": [1, 2, ], "b": { "c": 1, // x\n }, }')).toEqual({
      a: [1, 2],
      b: { c: 1 },
    });
    expect(parse('[1, /* gap */ ]')).toEqual([1]);
  });

  it('keeps a comma that something other than a closer follows', () => {
    expect(parse('[1, 2]')).toEqual([1, 2]);
    expect(() => parse('[1,, ]')).toThrow();
  });

  it('leaves an unterminated string or comment to fail the parse', () => {
    expect(() => parse('{ "a": "open')).toThrow();
    expect(() => parse('{ "a": 1 /* open')).toThrow();
    expect(stripJsonc('// only a comment')).toBe('');
    // An unclosed comment runs to the end, so nothing after its opener is read as JSON.
    expect(parse('{ "a": 1 } /* } tail')).toEqual({ a: 1 });
  });

  it('is linear on input built to make a naive scanner backtrack', () => {
    const hostile = '['.repeat(50_000) + ',' + ' '.repeat(50_000) + '/*'.repeat(50_000);
    const started = performance.now();
    stripJsonc(hostile);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('matchSegment', () => {
  it.each([
    ['*', '', true],
    ['*', 'anything', true],
    ['pkg-*', 'pkg-a', true],
    ['pkg-*', 'pkg-', true],
    ['pkg-*', 'lib-a', false],
    ['*-ui', 'web-ui', true],
    ['a*b*c', 'axxbyyc', true],
    ['a*b*c', 'axxbyy', false],
    ['exact', 'exact', true],
    ['exact', 'exactly', false],
    ['exactly', 'exact', false],
    ['**', 'x', true],
  ])('%s against %s is %s', (pattern, text, expected) => {
    expect(matchSegment(pattern, text)).toBe(expected);
  });

  it('is fast on a pattern alternating wildcards with literals', () => {
    const pattern = '*a'.repeat(30) + '*b';
    const started = performance.now();
    expect(matchSegment(pattern, 'a'.repeat(200))).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('matchSegments', () => {
  const match = (pattern: string, path: string): boolean =>
    matchSegments(pattern.split('/'), path.split('/'));

  it.each([
    ['packages/*', 'packages/a', true],
    ['packages/*', 'packages/a/b', false],
    ['packages/*', 'packages', false],
    ['packages/**', 'packages/a/b', true],
    ['packages/**', 'packages', true],
    ['**/ui', 'apps/web/ui', true],
    ['**/ui', 'ui', true],
    ['apps/**/site', 'apps/x/y/site', true],
    ['apps/**/site', 'apps/x/y/other', false],
    ['libs/x', 'libs/x', true],
  ])('%s against %s is %s', (pattern, path, expected) => {
    expect(match(pattern, path)).toBe(expected);
  });

  it('is bounded on many globstars', () => {
    const pattern = Array.from({ length: 40 }, () => '**').concat('z');
    const started = performance.now();
    expect(
      matchSegments(
        pattern,
        Array.from({ length: 60 }, () => 'a'),
      ),
    ).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('readPnpmWorkspacePackages', () => {
  it('reads a block list of plain and quoted scalars, with comments', () => {
    expect(
      readPnpmWorkspacePackages(
        [
          '# workspace',
          'packages:',
          '  # the libraries',
          '  - packages/*',
          "  - 'apps/**'   # all apps",
          '  - "!**/test/**"',
          '',
          'onlyBuiltDependencies:',
          '  - esbuild',
        ].join('\n'),
      ),
    ).toEqual({ list: ['packages/*', 'apps/**', '!**/test/**'] });
  });

  it('reads a list indented at the key, and CRLF line ends', () => {
    expect(readPnpmWorkspacePackages('packages:\r\n- a/*\r\n- b\r\nother: 1\r\n')).toEqual({
      list: ['a/*', 'b'],
    });
  });

  it('reads a one-line flow list', () => {
    expect(readPnpmWorkspacePackages('packages: [\'a/*\', "b", c] # flow')).toEqual({
      list: ['a/*', 'b', 'c'],
    });
    expect(readPnpmWorkspacePackages('packages: []')).toEqual({ list: [] });
  });

  it('answers no patterns for a file without a packages key', () => {
    expect(readPnpmWorkspacePackages('catalog:\n  react: ^18\n')).toEqual({ list: [] });
    expect(readPnpmWorkspacePackages('')).toEqual({ list: [] });
  });

  it.each([
    ['an anchor', 'packages: &a\n  - x\n'],
    ['a mapping entry', 'packages:\n  - name: x\n'],
    ['a nested list', 'packages:\n  - - x\n'],
    ['an empty entry', 'packages:\n  -\n'],
    ['a non-list line', 'packages:\n  x\n'],
    ['an escape in a quoted scalar', 'packages:\n  - "a\\"b"\n'],
    ['an unclosed quote', "packages:\n  - 'a\n"],
    ['a multi-line flow list', 'packages: [\n  a ]\n'],
    ['an empty flow entry', 'packages: [a, , b]\n'],
    ['an alias', 'packages:\n  - *ref\n'],
  ])('refuses %s rather than reading part of it', (_name, source) => {
    expect(readPnpmWorkspacePackages(source)).toEqual({
      problem: 'pnpm-workspace.yaml has a packages list in a form this reader does not parse',
    });
  });
});
