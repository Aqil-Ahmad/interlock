import { describe, expect, it } from 'vitest';
import { MAX_IGNORE_PATTERN_LENGTH } from './config.js';
import { matchesGlob, matchesPath, pathIgnored } from './glob.js';

describe('matchesGlob', () => {
  it('spans `/`, which is what a branch rule wants', () => {
    expect(matchesGlob('release/1.0', 'release/*')).toBe(true);
    expect(matchesGlob('release/1.0/hotfix', 'release/*')).toBe(true);
  });

  it('matches `?` per code point rather than per UTF-16 unit', () => {
    // A surrogate pair is one character; consuming half of it would leave the
    // scan aligned on nothing and match a name it should not.
    expect(matchesGlob('a😀b', 'a?b')).toBe(true);
    expect(matchesGlob('a😀b', 'a??b')).toBe(false);
  });

  it('expands `*` rather than matching a literal one in the name', () => {
    expect(matchesGlob('a*b', 'a*b')).toBe(true);
    expect(matchesGlob('axxb', 'a*b')).toBe(true);
  });

  it('refuses a pattern longer than the cap instead of scanning it', () => {
    const long = `${'a*'.repeat(MAX_IGNORE_PATTERN_LENGTH)}b`;
    expect(matchesGlob('aaaa', long)).toBe(false);
  });
});

/**
 * The cases marked as git's were measured with `git check-ignore` against a real
 * repository, not read off the documentation.
 */
describe('matchesPath', () => {
  it('keeps `*` inside one segment, as git does', () => {
    expect(matchesPath('src/a.ts', 'src/*.ts')).toBe(true);
    // git keeps `src/deep/x.ts` under this pattern; the branch matcher would
    // exclude it, which is the whole reason paths get their own matcher.
    expect(matchesPath('src/deep/x.ts', 'src/*.ts')).toBe(false);
    expect(matchesGlob('src/deep/x.ts', 'src/*.ts')).toBe(true);
  });

  it('matches a bare name at any depth, as git does', () => {
    expect(matchesPath('packages/app/node_modules/x/y.js', 'node_modules')).toBe(true);
    expect(matchesPath('src/a.ts', 'node_modules')).toBe(false);
  });

  it('excludes everything under a directory it matches, as git does', () => {
    expect(matchesPath('dist/out.js', 'dist/')).toBe(true);
    expect(matchesPath('dist/nested/deep/out.js', 'dist/')).toBe(true);
  });

  it('walks directory prefixes for a rooted pattern', () => {
    // A bare `dist/` takes the any-depth branch and never reaches the prefix
    // walk; only a pattern with a slash in it does.
    expect(matchesPath('pkg/dist/keep.js', 'pkg/dist/')).toBe(true);
    expect(matchesPath('pkg/dist/deep/keep.js', 'pkg/dist/')).toBe(true);
    expect(matchesPath('other/dist/keep.js', 'pkg/dist/')).toBe(false);
  });

  it('spans segments with `**`', () => {
    expect(matchesPath('a/b/c/d.ts', 'a/**/d.ts')).toBe(true);
    expect(matchesPath('a/d.ts', 'a/**/d.ts')).toBe(true);
    expect(matchesPath('a/b/c/e.ts', 'a/**/d.ts')).toBe(false);
  });

  it('anchors a pattern containing a slash to the worktree root', () => {
    expect(matchesPath('src/a.ts', 'src/a.ts')).toBe(true);
    expect(matchesPath('vendor/src/a.ts', 'src/a.ts')).toBe(false);
  });

  it('reads a leading slash as the same anchor', () => {
    expect(matchesPath('src/a.ts', '/src/a.ts')).toBe(true);
  });

  it('normalises the path it is given', () => {
    expect(matchesPath('./src//a.ts', 'src/a.ts')).toBe(true);
  });

  it('departs from git on the directory itself, deliberately', () => {
    // Measured: git keeps a *file* named `build` under `build/`, and keeps `a`
    // itself under `a/**`, excluding only what is inside. Both distinctions
    // need a stat on a path that may already be gone by the time the event
    // naming it is read, and for a watcher the directory node is noise either
    // way — so a match on the name excludes the name too.
    expect(matchesPath('build', 'build/')).toBe(true);
    expect(matchesPath('a', 'a/**')).toBe(true);
    expect(matchesPath('a/dist/out.js', 'a/**')).toBe(true);
    expect(matchesPath('a2', 'a/**')).toBe(false);
  });

  it('matches nothing on an empty pattern or an empty path', () => {
    expect(matchesPath('src/a.ts', '')).toBe(false);
    expect(matchesPath('src/a.ts', '///')).toBe(false);
    expect(matchesPath('', 'src')).toBe(false);
  });

  it('matches nothing on a pattern longer than the cap', () => {
    // Either cap produces this: the whole-pattern one is an early-out, and the
    // per-segment one inside `matchesGlob` decides the answer on its own. What
    // the outer cap uniquely bounds is the *number* of segments, which no
    // result can distinguish.
    const segments = `${'a*'.repeat(MAX_IGNORE_PATTERN_LENGTH)}/b`;
    expect(segments.length).toBeGreaterThan(MAX_IGNORE_PATTERN_LENGTH);
    expect(matchesPath('a/b', segments)).toBe(false);
  });

  it('completes on a pattern built to make a regex backtrack', () => {
    // The reason this is a scan: translated to a regex, this shape takes tens of
    // seconds on the event loop, once per path, and the pattern is repository
    // content.
    const pattern = `${'*a'.repeat(40)}/b`;
    const path = `${'a'.repeat(400)}/c`;

    const startedAt = performance.now();
    expect(matchesPath(path, pattern)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it('completes on a `**` shape built to make the segment scan backtrack', () => {
    const pattern = `${'**/a/'.repeat(40)}b`;
    const path = `${'a/'.repeat(200)}c`;

    const startedAt = performance.now();
    expect(matchesPath(path, pattern)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });
});

describe('pathIgnored', () => {
  it('is true when any pattern excludes the path', () => {
    expect(pathIgnored('dist/out.js', ['node_modules', 'dist/'])).toBe(true);
    expect(pathIgnored('src/a.ts', ['node_modules', 'dist/'])).toBe(false);
  });

  it('excludes nothing when the repository asked for nothing', () => {
    expect(pathIgnored('src/a.ts', [])).toBe(false);
  });
});
