import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  Confinement,
  createTypecheckService,
  matchFilesOf,
  NODE_FILE_SYSTEM,
  readProject,
  serveTypecheck,
  siblingModule,
} from './typecheck-service.js';
import type {
  HostFileSystem,
  Port,
  TypecheckResult,
  TypecheckService,
  WorkerRequest,
  WorkerResponse,
} from './typecheck-service.js';

/**
 * The service in this thread, over plain directories: what it reads, how it
 * decides a file changed, and how it stops.
 *
 * The same module runs in the daemon's workers; `test/typecheck.test.ts` drives
 * it there, against trees in pool slots.
 */

const tsconfig = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    compilerOptions: {
      target: 'es2022',
      module: 'esnext',
      moduleResolution: 'bundler',
      lib: ['es2022'],
      types: [],
      strict: true,
      ...extra,
    },
    include: ['src'],
  });

describe('typecheck service', () => {
  let base: string;
  let tree: string;
  let deps: string;
  let outside: string;
  const services: TypecheckService[] = [];

  const write = (root: string, files: Record<string, string>): void => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  };

  const open = (options: { project?: string; fileSystem?: HostFileSystem } = {}) => {
    const service = createTypecheckService({ root: tree, dependencyRoot: deps, ...options });
    services.push(service);
    return service;
  };

  const report = (result: TypecheckResult) => {
    if (result.kind !== 'checked') throw new Error(`expected a check, got ${result.kind}`);
    return result.report;
  };

  const codes = (result: TypecheckResult): [string, number][] =>
    report(result).files.map((d) => [d.file, d.code]);

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-service-')));
    tree = join(base, 'tree');
    deps = join(base, 'deps');
    outside = join(base, 'outside');
    mkdirSync(tree);
    mkdirSync(deps);
    mkdirSync(outside);
  });

  afterEach(() => {
    for (const service of services.splice(0)) service.dispose();
    rmSync(base, { recursive: true, force: true });
  });

  describe('confinement', () => {
    it('reads the tree, node_modules from the dependency checkout, and nothing else', () => {
      write(tree, { 'src/a.ts': 'a', 'packages/lib/index.ts': 'merged' });
      write(deps, { 'node_modules/dep/index.d.ts': 'dep', 'packages/lib/index.ts': 'user' });
      write(outside, { 'secret.ts': 'secret' });
      symlinkSync('../packages/lib', join(deps, 'node_modules', 'lib'));
      symlinkSync(join(outside, 'secret.ts'), join(tree, 'src', 'leak.ts'));
      mkdirSync(join(deps, 'node_modules', '@scope'));
      symlinkSync(join(outside), join(deps, 'node_modules', '@scope', 'away'));
      const confinement = new Confinement(tree, deps, NODE_FILE_SYSTEM);

      expect(confinement.readFile(join(tree, 'src/a.ts'))).toBe('a');
      expect(confinement.readFile('src/a.ts')).toBe('a');
      expect(confinement.readFile(join(tree, 'node_modules/dep/index.d.ts'))).toBe('dep');
      // A workspace link resolves into the tree, never to the user's copy.
      expect(confinement.readFile(join(tree, 'node_modules/lib/index.ts'))).toBe('merged');
      expect(confinement.realpath(join(tree, 'node_modules/lib/index.ts'))).toBe(
        join(tree, 'packages/lib/index.ts'),
      );
      // Outside, directly, through `..`, through a link in the tree, or
      // through a link in the dependency checkout: absent.
      expect(confinement.readFile(join(outside, 'secret.ts'))).toBeUndefined();
      expect(confinement.readFile(join(tree, '../outside/secret.ts'))).toBeUndefined();
      expect(confinement.readFile(join(tree, 'src/leak.ts'))).toBeUndefined();
      expect(confinement.fileExists(join(tree, 'src/leak.ts'))).toBe(false);
      expect(
        confinement.readFile(join(tree, 'node_modules/@scope/away/secret.ts')),
      ).toBeUndefined();
      expect(confinement.readFile(join(deps, 'node_modules/dep/index.d.ts'))).toBeUndefined();
      // A link out of the tree is its own identity, never its target's.
      expect(confinement.realpath(join(tree, 'src/leak.ts'))).toBe(join(tree, 'src/leak.ts'));
      expect(confinement.realpath(join(tree, 'node_modules/@scope/away'))).toBe(
        join(tree, 'node_modules/@scope/away'),
      );
      expect(confinement.realpath(join(outside, 'secret.ts'))).toBe(join(outside, 'secret.ts'));
      expect(confinement.realpath(join(tree, 'node_modules/missing'))).toBe(
        join(tree, 'node_modules/missing'),
      );
      expect(confinement.readFile(join(tree, 'node_modules/missing'))).toBeUndefined();
    });

    it('lists a directory by where each entry leads', () => {
      write(tree, { 'src/a.ts': '', 'src/inner/b.ts': '' });
      write(outside, { 'c.ts': '' });
      symlinkSync(join(tree, 'src', 'a.ts'), join(tree, 'src', 'alias.ts'));
      symlinkSync(join(tree, 'src', 'inner'), join(tree, 'src', 'dir-alias'));
      symlinkSync(join(outside, 'c.ts'), join(tree, 'src', 'away.ts'));
      const confinement = new Confinement(tree, deps, NODE_FILE_SYSTEM);

      expect(confinement.entries(join(tree, 'src'))).toEqual({
        files: ['a.ts', 'alias.ts'],
        directories: ['dir-alias', 'inner'],
      });
      expect(confinement.entries(outside)).toEqual({ files: [], directories: [] });
      expect(confinement.directoryExists(join(tree, 'src'))).toBe(true);
      expect(confinement.directoryExists(outside)).toBe(false);
    });

    it('answers an unreadable directory, and a path asked after twice, as absent', () => {
      write(tree, { 'file.ts': '' });
      expect(NODE_FILE_SYSTEM.readdir(join(tree, 'file.ts'))).toEqual([]);
      const asked: string[] = [];
      const confinement = new Confinement(tree, deps, {
        ...NODE_FILE_SYSTEM,
        realpath: (path) => (asked.push(path), NODE_FILE_SYSTEM.realpath(path)),
      });
      const missing = join(tree, 'missing.ts');
      expect(confinement.realpath(missing)).toBe(missing);
      expect(confinement.realpath(missing)).toBe(missing);
      // Remembered within a check, absent answers included.
      expect(asked.filter((path) => path === missing)).toHaveLength(1);
    });

    it('decides containment on whole path segments', () => {
      write(base, { 'tree-other/x.ts': 'x' });
      write(tree, { '..tree/y.ts': 'y' });
      const confinement = new Confinement(tree, deps, NODE_FILE_SYSTEM);
      expect(confinement.readFile(join(base, 'tree-other/x.ts'))).toBeUndefined();
      // `..tree` is a directory in the tree, not a way out of it.
      expect(confinement.readFile(join(tree, '..tree/y.ts'))).toBe('y');
    });

    it('never asks the file system about a path outside its roots during a check', () => {
      const touched: string[] = [];
      const recording: HostFileSystem = {
        readFile: (path) => (touched.push(path), NODE_FILE_SYSTEM.readFile(path)),
        stat: (path) => (touched.push(path), NODE_FILE_SYSTEM.stat(path)),
        readdir: (path) => (touched.push(path), NODE_FILE_SYSTEM.readdir(path)),
        realpath: (path) => (touched.push(path), NODE_FILE_SYSTEM.realpath(path)),
      };
      write(outside, { 'secret.ts': 'export const s = 1;', 'types/leak/index.d.ts': '' });
      write(tree, {
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            strict: true,
            lib: ['es2022'],
            module: 'esnext',
            moduleResolution: 'bundler',
            paths: { leak: [join(outside, 'secret.ts')], near: ['../outside/secret.ts'] },
            typeRoots: [join(outside, 'types'), '../outside/types'],
          },
          include: ['src', '../outside/**/*', `${outside}/**/*`],
        }),
        'src/a.ts':
          "import { s } from 'leak';\nimport { t } from 'near';\nexport const a = [s, t];\n",
      });
      symlinkSync(join(outside, 'secret.ts'), join(tree, 'src', 'link.ts'));
      const result = open({ fileSystem: recording }).check();

      expect(codes(result)).toEqual([
        ['src/a.ts', 2307],
        ['src/a.ts', 2307],
      ]);
      const roots = [
        tree,
        deps,
        realpathSync(dirname(createRequire(import.meta.url).resolve('typescript/lib/lib.d.ts'))),
      ];
      expect(touched.length).toBeGreaterThan(0);
      expect(
        touched.filter(
          (path) => !roots.some((root) => path === root || path.startsWith(`${root}/`)),
        ),
      ).toEqual([]);
      // The link in the tree is resolved, which names its target; nothing reads it.
      expect(touched.filter((path) => path.startsWith(outside))).toEqual([]);
    });
  });

  describe('dependencies', () => {
    it('resolves packages, links and automatic types from the dependency checkout', () => {
      write(deps, {
        'node_modules/@types/ambient/index.d.ts': 'declare const ambient: number;\n',
        'node_modules/@types/ambient/package.json': JSON.stringify({ name: '@types/ambient' }),
        'node_modules/.store/dep/package.json': JSON.stringify({
          name: 'dep',
          types: 'index.d.ts',
        }),
        'node_modules/.store/dep/index.d.ts': 'export declare const dep: string;\n',
      });
      // pnpm's layout: a package is a link into its store directory.
      symlinkSync('.store/dep', join(deps, 'node_modules', 'dep'));
      write(tree, {
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            strict: true,
            lib: ['es2022'],
            module: 'esnext',
            moduleResolution: 'bundler',
            // Every package under `@types`, which TypeScript 6 no longer includes unasked.
            types: ['*'],
          },
          include: ['src'],
        }),
        'src/a.ts':
          "import { dep } from 'dep';\nexport const a: number = dep;\nexport const b: string = ambient;\n",
      });
      const result = open().check();
      expect(report(result).files.map((d) => [d.file, d.line, d.code])).toEqual([
        ['src/a.ts', 2, 2322],
        ['src/a.ts', 3, 2322],
      ]);
    });
  });

  describe('projects', () => {
    it('strips plugins once the whole extends chain has been read', () => {
      write(deps, {
        'node_modules/shared-config/tsconfig.json': JSON.stringify({
          compilerOptions: { strict: true, plugins: [{ name: 'evil' }] },
        }),
      });
      write(tree, {
        'tsconfig.json': JSON.stringify({
          extends: 'shared-config/tsconfig.json',
          compilerOptions: { plugins: [{ name: 'local' }] },
          include: ['src'],
        }),
        'src/a.ts': '',
      });
      const parsed = readProject(
        join(tree, 'tsconfig.json'),
        new Confinement(tree, deps, NODE_FILE_SYSTEM),
      );
      expect(parsed.errors).toEqual([]);
      expect(parsed.options.strict).toBe(true);
      expect(parsed.options).not.toHaveProperty('plugins');
      expect(parsed.fileNames).toEqual([join(tree, 'src/a.ts')]);
    });

    it('reports an unreadable tsconfig and checks nothing', () => {
      const result = open().check();
      expect(report(result)).toMatchObject({
        files: [],
        config: [{ code: 5083, file: null, start: null, length: null, category: 'error' }],
      });
    });

    it('reports a tsconfig’s own errors on every check, read again each time', () => {
      write(tree, {
        'tsconfig.json': JSON.stringify({ compilerOptions: { strictest: true }, include: ['src'] }),
        'src/a.ts': '',
      });
      const service = open();
      const first = report(service.check()).config;
      expect(first.map((d) => [d.code, d.file, d.category])).toEqual([
        [5025, 'tsconfig.json', 'error'],
      ]);
      expect(report(service.check()).config).toEqual(first);
    });

    it('refuses a TypeScript without the file matcher a tsconfig is read with', () => {
      expect(typeof matchFilesOf(ts)).toBe('function');
      expect(() => matchFilesOf({})).toThrow('does not provide matchFiles');
    });

    it('checks the project it is given, relative to the tree', () => {
      write(tree, {
        'app/tsconfig.json': tsconfig(),
        'app/src/a.ts': 'export const a: number = "";\n',
        'src/ignored.ts': 'export const b: number = "";\n',
      });
      const result = open({ project: 'app/tsconfig.json' }).check();
      expect(report(result).projects).toEqual(['app/tsconfig.json']);
      expect(codes(result)).toEqual([['app/src/a.ts', 2322]]);
    });

    it('drops a project no longer referenced, and checks one newly referenced', () => {
      const project = (name: string, body: string) => ({
        [`${name}/tsconfig.json`]: JSON.stringify({
          compilerOptions: { composite: true, lib: ['es2022'], types: [], strict: true },
          include: ['src'],
        }),
        [`${name}/src/index.ts`]: body,
      });
      write(tree, {
        'tsconfig.json': JSON.stringify({ files: [], references: [{ path: 'one' }] }),
        ...project('one', 'export const one: number = "";\n'),
        ...project('two', 'export const two: number = "";\n'),
      });
      const service = open();
      expect(codes(service.check())).toEqual([['one/src/index.ts', 2322]]);
      write(tree, {
        'tsconfig.json': JSON.stringify({ files: [], references: [{ path: 'two' }] }),
      });
      const after = service.check();
      expect(report(after).projects).toEqual(['two/tsconfig.json', 'tsconfig.json']);
      expect(codes(after)).toEqual([['two/src/index.ts', 2322]]);
    });

    it('judges a referenced project’s file by its own project’s options', () => {
      write(tree, {
        'tsconfig.json': JSON.stringify({
          files: [],
          references: [{ path: 'lib' }, { path: 'app' }],
        }),
        // Lax: an untyped parameter is fine here, and `tsc -b` says nothing of it.
        'lib/tsconfig.json': JSON.stringify({
          compilerOptions: { composite: true, lib: ['es2022'], types: [], strict: false },
          include: ['src'],
        }),
        'lib/src/index.ts': 'export function id(x) {\n  return x;\n}\n',
        'app/tsconfig.json': JSON.stringify({
          compilerOptions: { composite: true, lib: ['es2022'], types: [], strict: true },
          include: ['src'],
          references: [{ path: '../lib' }],
        }),
        'app/src/main.ts':
          "import { id } from '../../lib/src/index';\nexport const app: string = id(1);\nexport function f(y) {\n  return y;\n}\n",
      });
      expect(codes(open().check())).toEqual([['app/src/main.ts', 7006]]);
    });

    it('reports a referenced project’s file once, from the project that lists it', () => {
      write(tree, {
        'tsconfig.json': JSON.stringify({
          files: [],
          references: [{ path: 'lib' }, { path: 'app' }],
        }),
        'lib/tsconfig.json': JSON.stringify({
          compilerOptions: { composite: true, lib: ['es2022'], types: [], strict: true },
          include: ['src'],
        }),
        'lib/src/index.ts': 'export const lib: number = "";\n',
        'app/tsconfig.json': JSON.stringify({
          compilerOptions: { composite: true, lib: ['es2022'], types: [], strict: true },
          include: ['src'],
          references: [{ path: '../lib' }],
        }),
        'app/src/main.ts':
          "import { lib } from '../../lib/src/index';\nexport const app: string = lib;\n",
      });
      const result = open().check();
      expect(codes(result)).toEqual([
        ['app/src/main.ts', 2322],
        ['lib/src/index.ts', 2322],
      ]);
    });

    it('survives a reference cycle', () => {
      const cyclic = (name: string, other: string) => ({
        [`${name}/tsconfig.json`]: JSON.stringify({
          compilerOptions: { composite: true, lib: ['es2022'], types: [] },
          include: ['src'],
          references: [{ path: `../${other}` }],
        }),
        [`${name}/src/index.ts`]: `export const ${name} = 1;\n`,
      });
      write(tree, {
        'tsconfig.json': JSON.stringify({ files: [], references: [{ path: 'a' }] }),
        ...cyclic('a', 'b'),
        ...cyclic('b', 'a'),
      });
      const result = open().check();
      expect(report(result).projects).toEqual([
        'b/tsconfig.json',
        'a/tsconfig.json',
        'tsconfig.json',
      ]);
    });
  });

  describe('diagnostics', () => {
    it('stops at a syntax error before the semantic check', () => {
      write(tree, {
        'tsconfig.json': tsconfig(),
        'src/a.ts': 'export const a: number = "";\nconst b = (;\n',
      });
      expect(codes(open().check())).toEqual([['src/a.ts', 1109]]);
    });

    it('stops at a configuration error before the semantic check', () => {
      write(tree, {
        'tsconfig.json': tsconfig({ lib: ['es2099'] }),
        'src/a.ts': 'export const a: number = "";\n',
      });
      const result = report(open().check());
      expect(result.files).toEqual([]);
      expect(result.config.map((d) => d.code)).toContain(6046);
    });

    it('reports an error in a lib file with the configuration, and its twin with the code', () => {
      // A global class named as a lib's own declaration is a duplicate in both.
      write(tree, {
        'tsconfig.json': tsconfig({ moduleDetection: 'legacy' }),
        'src/a.ts': 'declare class Symbol {}\n',
      });
      const result = report(open().check());
      expect(result.files.map((d) => [d.file, d.code])).toContainEqual(['src/a.ts', 2300]);
      expect(result.config.find((d) => d.code === 2300)).toMatchObject({
        file: null,
        start: null,
        length: null,
      });
    });

    it('reports a file two projects list once, from the first', () => {
      const project = { composite: true, lib: ['es2022'], types: [], strict: true };
      write(tree, {
        'tsconfig.json': JSON.stringify({
          files: [],
          references: [{ path: 'one' }, { path: 'two' }],
        }),
        'one/tsconfig.json': JSON.stringify({ compilerOptions: project, include: ['../shared'] }),
        'two/tsconfig.json': JSON.stringify({ compilerOptions: project, include: ['../shared'] }),
        'shared/a.ts': 'export const a: number = "";\n',
      });
      expect(codes(open().check())).toEqual([['shared/a.ts', 2322]]);
    });

    it('notices a file that has gone', () => {
      write(tree, {
        'tsconfig.json': tsconfig(),
        'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
        'src/b.ts': 'export const b = 1;\n',
      });
      const service = open();
      expect(codes(service.check())).toEqual([]);
      rmSync(join(tree, 'src/b.ts'));
      expect(codes(service.check())).toEqual([['src/a.ts', 2307]]);
    });

    it('reports a tree that is not there as having no tsconfig', () => {
      const service = createTypecheckService({ root: join(base, 'gone'), dependencyRoot: deps });
      services.push(service);
      expect(report(service.check()).config.map((d) => d.code)).toEqual([5083]);
    });
  });

  describe('incremental state', () => {
    it('sees a file rewritten with the same size and modification time', () => {
      write(tree, { 'tsconfig.json': tsconfig(), 'src/a.ts': 'export const a: number = 1;\n' });
      const path = join(tree, 'src/a.ts');
      // Whole seconds, so setting the time back restores it exactly.
      utimesSync(path, 1_700_000_000, 1_700_000_000);
      const service = open();
      expect(codes(service.check())).toEqual([]);
      const before = statSync(path);
      writeFileSync(path, 'export const a: string = 1;\n');
      utimesSync(path, 1_700_000_000, 1_700_000_000);
      expect(statSync(path)).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs });
      expect(codes(service.check())).toEqual([['src/a.ts', 2322]]);
    });

    it('answers from what it holds until told the tree was written whole', () => {
      write(tree, { 'tsconfig.json': tsconfig(), 'src/a.ts': 'export const a: number = 1;\n' });
      // A file system whose stat never moves: only the epoch can say a file changed.
      const frozen: HostFileSystem = {
        ...NODE_FILE_SYSTEM,
        stat: (path) => {
          const found = NODE_FILE_SYSTEM.stat(path);
          return found === undefined
            ? undefined
            : { ...found, mtimeMs: 0, ctimeMs: 0, ino: 0, size: 0 };
        },
      };
      const service = open({ fileSystem: frozen });
      expect(codes(service.check())).toEqual([]);
      writeFileSync(join(tree, 'src/a.ts'), 'export const a: string = 1;\n');
      expect(codes(service.check())).toEqual([]);
      expect(codes(service.check({ cold: true }))).toEqual([['src/a.ts', 2322]]);
    });

    it('resolves an import again once the file it names appears', () => {
      write(tree, {
        'tsconfig.json': tsconfig(),
        'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
      });
      const service = open();
      expect(codes(service.check())).toEqual([['src/a.ts', 2307]]);
      write(tree, { 'src/b.ts': 'export const b = 1;\n' });
      expect(codes(service.check())).toEqual([]);
    });

    it('resolves an import outside include again once a merge adds its file', () => {
      write(tree, {
        'tsconfig.json': tsconfig(),
        'src/a.ts': "import { b } from '../extra/b';\nexport const a: string = b;\n",
      });
      const service = open();
      expect(codes(service.check())).toEqual([['src/a.ts', 2307]]);
      write(tree, { 'extra/b.ts': 'export const b = 1;\n' });
      expect(codes(service.check())).toEqual([['src/a.ts', 2322]]);
    });

    it('resolves every import again after a check that did not reach the semantic pass', () => {
      write(tree, {
        'tsconfig.json': tsconfig(),
        'src/a.ts': "import { b } from '../extra/b';\nexport const a: string = b;\nconst c = (;\n",
      });
      const service = open();
      expect(codes(service.check())).toEqual([['src/a.ts', 1109]]);
      write(tree, { 'extra/b.ts': 'export const b = 1;\n' });
      write(tree, { 'src/a.ts': "import { b } from '../extra/b';\nexport const a: string = b;\n" });
      expect(codes(service.check())).toEqual([['src/a.ts', 2322]]);
    });

    it('resolves every import again after a check that was cancelled', () => {
      write(tree, {
        'tsconfig.json': tsconfig(),
        'src/a.ts': "import { b } from '../extra/b';\nexport const a: string = b;\n",
      });
      const service = open();
      expect(service.check({ isCancelled: () => true })).toEqual({ kind: 'cancelled' });
      expect(codes(service.check())).toEqual([['src/a.ts', 2307]]);
      write(tree, { 'extra/b.ts': 'export const b = 1;\n' });
      expect(codes(service.check())).toEqual([['src/a.ts', 2322]]);
    });

    it('reports declaration errors only once nothing else is wrong, as tsc does', () => {
      write(tree, {
        'tsconfig.json': tsconfig({ declaration: true }),
        'src/a.ts': 'export const make = () => class {\n  private x = 1;\n};\n',
        'src/b.ts': 'export const b: number = "";\n',
      });
      expect(codes(open().check())).toEqual([['src/b.ts', 2322]]);
    });

    it('reuses declaration diagnostics only for files no change affected', () => {
      write(tree, {
        'tsconfig.json': tsconfig({ declaration: true }),
        'src/a.ts': 'export const make = () => class {\n  private x = 1;\n};\n',
        'src/b.ts': 'export const b = 1;\n',
      });
      const service = open();
      expect(codes(service.check())).toEqual([['src/a.ts', 4094]]);
      expect(codes(service.check())).toEqual([['src/a.ts', 4094]]);
      write(tree, { 'src/a.ts': 'export const make = () => class {\n  x = 1;\n};\n' });
      expect(codes(service.check())).toEqual([]);
      write(tree, { 'src/b.ts': 'export const make = () => class {\n  protected y = 1;\n};\n' });
      expect(codes(service.check())).toEqual([['src/b.ts', 4094]]);
    });
  });

  describe('cancellation', () => {
    it('stops part way through when the token says so, and checks whole afterwards', () => {
      const files: Record<string, string> = { 'tsconfig.json': tsconfig() };
      for (let i = 0; i < 40; i++)
        files[`src/f${String(i)}.ts`] = `export const v${String(i)}: number = "";\n`;
      write(tree, files);
      const service = open();
      let polls = 0;
      // Cancelled after the check has begun type-checking, not before it.
      const cancelled = service.check({ isCancelled: () => (polls += 1) > 20 });
      expect(cancelled).toEqual({ kind: 'cancelled' });
      expect(polls).toBeGreaterThan(20);
      expect(codes(service.check())).toHaveLength(40);
    });

    it('rethrows anything that is not a cancellation', () => {
      write(tree, { 'tsconfig.json': tsconfig(), 'src/a.ts': '' });
      const failing: HostFileSystem = {
        ...NODE_FILE_SYSTEM,
        readdir: () => {
          throw new Error('disk gone');
        },
      };
      expect(() => open({ fileSystem: failing }).check()).toThrow('disk gone');
    });
  });

  describe('the worker module', () => {
    it('is the source file under source, and the built one once built', () => {
      expect(siblingModule('file:///p/src/a/typecheck.ts', 'worker').href).toBe(
        'file:///p/src/a/worker.ts',
      );
      expect(siblingModule('file:///p/dist/a/typecheck.js', 'worker').href).toBe(
        'file:///p/dist/a/worker.js',
      );
    });
  });

  describe('serving a port', () => {
    const port = () => {
      const sent: WorkerResponse[] = [];
      let listener: ((message: WorkerRequest) => void) | undefined;
      let closed = false;
      const fake: Port = {
        on: (_event, handler) => {
          listener = handler;
        },
        postMessage: (message) => sent.push(message),
        close: () => {
          closed = true;
        },
      };
      return {
        fake,
        sent,
        send: (message: WorkerRequest) => listener!(message),
        closed: () => closed,
      };
    };

    it('answers each check with its result, its time and its heap', () => {
      write(tree, { 'tsconfig.json': tsconfig(), 'src/a.ts': 'export const a: number = "";\n' });
      const { fake, sent, send, closed } = port();
      serveTypecheck(fake, { root: tree, dependencyRoot: deps, project: 'tsconfig.json' });
      send({ type: 'check', id: 7, cold: false, cancel: new SharedArrayBuffer(4) });

      expect(sent[0]).toEqual({ type: 'started', id: 7 });
      expect(sent[1]).toMatchObject({ type: 'result', id: 7, result: { kind: 'checked' } });
      const result = sent[1] as Extract<WorkerResponse, { type: 'result' }>;
      expect(codes(result.result)).toEqual([['src/a.ts', 2322]]);
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.heapBytes).toBeGreaterThan(0);

      send({ type: 'dispose' });
      expect(closed()).toBe(true);
    });

    it('cancels through shared memory', () => {
      write(tree, { 'tsconfig.json': tsconfig(), 'src/a.ts': 'export const a = 1;\n' });
      const { fake, sent, send } = port();
      serveTypecheck(fake, { root: tree, dependencyRoot: deps, project: 'tsconfig.json' });
      const cancel = new SharedArrayBuffer(4);
      Atomics.store(new Int32Array(cancel), 0, 1);
      send({ type: 'check', id: 1, cold: true, cancel });
      expect(sent[1]).toMatchObject({ type: 'result', id: 1, result: { kind: 'cancelled' } });
    });

    it('lets a check the compiler threw on take the thread down with it', () => {
      write(tree, { 'tsconfig.json': tsconfig(), 'src/a.ts': '' });
      const { fake, sent, send } = port();
      const failing: HostFileSystem = {
        ...NODE_FILE_SYSTEM,
        readdir: () => {
          throw new Error('disk gone');
        },
      };
      serveTypecheck(fake, { root: tree, dependencyRoot: deps, project: 'tsconfig.json' }, failing);
      expect(() => {
        send({ type: 'check', id: 2, cold: false, cancel: new SharedArrayBuffer(4) });
      }).toThrow('disk gone');
      expect(sent).toEqual([{ type: 'started', id: 2 }]);
    });
  });
});
