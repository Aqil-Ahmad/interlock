import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { analysisBuildId, analysisModuleDirs, buildIdOf, buildIdOfAll } from '../src/build-id.js';

/** What a cached verdict names as the code that reached it. */
describe('buildIdOf', () => {
  let root: string;

  const write = (path: string, content: string): void => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-build-')));
    write('index.js', 'export * from "./merge/merge.js";\n');
    write('merge/merge.js', 'export const style = "diff3";\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is the same for the same code, wherever it was read from', () => {
    const first = buildIdOf(root);
    const copy = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-build-copy-')));
    try {
      mkdirSync(join(copy, 'merge'));
      writeFileSync(join(copy, 'index.js'), 'export * from "./merge/merge.js";\n');
      writeFileSync(join(copy, 'merge', 'merge.js'), 'export const style = "diff3";\n');
      expect(buildIdOf(copy)).toBe(first);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it.each([
    ['a module changes', () => write('merge/merge.js', 'export const style = "merge";\n')],
    ['a module is added', () => write('merge/classify.ts', 'export {};\n')],
    ['a module moves', () => renameSync(join(root, 'merge', 'merge.js'), join(root, 'moved.js'))],
  ])('changes when %s', (_, change) => {
    const before = buildIdOf(root);
    change();
    expect(buildIdOf(root)).not.toBe(before);
  });

  it('ignores what describes code rather than being it', () => {
    const before = buildIdOf(root);
    write('merge/merge.d.ts', 'export declare const style: string;\n');
    write('merge/merge.js.map', '{}');
    write('merge/merge.test.ts', 'it("x", () => {});\n');
    write('merge/merge.test.js', 'it("x", () => {});\n');
    expect(buildIdOf(root)).toBe(before);
  });
});

describe('buildIdOfAll', () => {
  let roots: string[];

  beforeEach(() => {
    roots = ['one', 'two'].map((name) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), `interlock-build-${name}-`)));
      writeFileSync(join(root, 'index.js'), `export const name = "${name}";\n`);
      return root;
    });
  });

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it.each([0, 1])('changes when the code in directory %i changes', (index) => {
    const before = buildIdOfAll(roots);
    writeFileSync(join(roots[index]!, 'index.js'), 'export const name = "changed";\n');
    expect(buildIdOfAll(roots)).not.toBe(before);
  });

  it('changes when the same code sits in the other directory', () => {
    expect(buildIdOfAll([...roots].reverse())).not.toBe(buildIdOfAll(roots));
  });
});

describe('analysisBuildId', () => {
  it('covers the redaction in @interlock/shared as well as this package', () => {
    // Excerpts are redacted by shared's logger module: a secret pattern added
    // there has to change the key a verdict and its excerpts are cached under.
    const [core, shared] = analysisModuleDirs();
    const present = (dir: string, name: string): boolean =>
      existsSync(join(dir, `${name}.ts`)) || existsSync(join(dir, `${name}.js`));
    expect(present(shared!, 'logger')).toBe(true);
    expect(present(core!, 'build-id')).toBe(true);
    expect(analysisBuildId()).toBe(buildIdOfAll([core!, shared!]));
  });

  it('is read once and answers the same thereafter', () => {
    expect(analysisBuildId()).toMatch(/^[0-9a-f]{16}$/u);
    expect(analysisBuildId()).toBe(analysisBuildId());
  });
});
