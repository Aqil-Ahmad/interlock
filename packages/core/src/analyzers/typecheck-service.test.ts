import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  Confinement,
  createTypecheckService,
  DEFAULT_PROJECT,
  filesCheckedBy,
  matchFilesOf,
  NODE_FILE_SYSTEM,
  readProject,
  serveTypecheck,
} from './typecheck-service.js';
import { DEFAULT_PROJECT as REGISTRY_DEFAULT_PROJECT, siblingModule } from './typecheck-paths.js';
import type {
  CheckOptions,
  HostFileSystem,
  Port,
  TreeEntry,
  TreeListing,
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

/**
 * A directory's files as `git ls-tree` would list them once committed: each
 * blob named as git names it, links as links, and what is under `.git` left out.
 */
function listingOf(root: string): TreeListing {
  const entries: TreeEntry[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const rel = relative(root, path).split('\\').join('/');
      if (rel === '.git') continue;
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      const symlink = stat.isSymbolicLink();
      const content = symlink ? Buffer.from(readlinkSync(path)) : readFileSync(path);
      const oid = createHash('sha1')
        .update(`blob ${String(content.length)}\0`)
        .update(content)
        .digest('hex');
      entries.push({ path: rel, oid, symlink });
    }
  };
  walk(root);
  const oid = createHash('sha1').update(JSON.stringify(entries)).digest('hex');
  return { oid, entries };
}

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

  /** A check of the tree as it is now, against no recorded install unless one is named. */
  const check = (service: TypecheckService, options: Partial<CheckOptions> = {}): TypecheckResult =>
    service.check({ tree: listingOf(tree), install: null, ...options });

  /** A confinement over the tree as it is now. */
  const confine = (
    fileSystem: HostFileSystem = NODE_FILE_SYSTEM,
    install: string | null = null,
  ) => {
    const confinement = new Confinement(tree, deps, fileSystem);
    confinement.begin(listingOf(tree), install);
    return confinement;
  };

  const report = (result: TypecheckResult) => {
    if (result.kind !== 'checked') throw new Error(`expected a check, got ${result.kind}`);
    return result.report;
  };

  const codes = (result: TypecheckResult): [string, number][] =>
    report(result).files.map((d) => [d.file, d.code]);

  /** The node file system, with every call it is asked to make written down. */
  const recording = (): { fileSystem: HostFileSystem; touched: string[] } => {
    const touched: string[] = [];
    const fileSystem: HostFileSystem = {
      readFile: (path) => (touched.push(path), NODE_FILE_SYSTEM.readFile(path)),
      stat: (path) => (touched.push(path), NODE_FILE_SYSTEM.stat(path)),
      readdir: (path) => (touched.push(path), NODE_FILE_SYSTEM.readdir(path)),
      realpath: (path) => (touched.push(path), NODE_FILE_SYSTEM.realpath(path)),
      readlink: (path) => (touched.push(path), NODE_FILE_SYSTEM.readlink(path)),
    };
    return { fileSystem, touched };
  };

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
      const confinement = confine();

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
      // A directory is not read as a file, and nothing lies beneath a file.
      expect(confinement.readFile(join(tree, 'src'))).toBeUndefined();
      expect(confinement.fileExists(join(tree, 'src/a.ts/x'))).toBe(false);
      // Interlock's own `lib` is read where it is.
      const lib = ts.getDefaultLibFilePath({});
      expect(confinement.realpath(lib)).toBe(lib);
      expect(confinement.directoryExists(dirname(lib))).toBe(true);
      expect(confinement.entries(dirname(lib)).files).toContain(basename(lib));
      expect(confinement.fileExists(join(dirname(lib), 'missing.d.ts'))).toBe(false);
    });

    it('finds nothing through a link out of the checkout into another node_modules', () => {
      // A package manager's global store, or an `npm link`: a real
      // `node_modules`, but not the checkout's.
      write(outside, { 'node_modules/pkg/index.d.ts': 'outside' });
      mkdirSync(join(deps, 'node_modules'), { recursive: true });
      symlinkSync(join(outside, 'node_modules', 'pkg'), join(deps, 'node_modules', 'linked'));
      const confinement = confine();
      expect(confinement.fileExists(join(tree, 'node_modules/linked/index.d.ts'))).toBe(false);
      expect(confinement.readFile(join(tree, 'node_modules/linked/index.d.ts'))).toBeUndefined();
      expect(confinement.directoryExists(join(tree, 'node_modules/linked'))).toBe(false);
      expect(confinement.fileExists(join(tree, 'node_modules/linked/added.d.ts'))).toBe(false);
    });

    it('finds nothing in node_modules that is neither a file nor a directory', () => {
      mkdirSync(join(deps, 'node_modules', 'dep'), { recursive: true });
      // Opening a pipe for reading waits for a writer, so a read would hang the check.
      execFileSync('mkfifo', [join(deps, 'node_modules', 'dep', 'index.d.ts')]);
      const confinement = confine();
      expect(confinement.fileExists(join(tree, 'node_modules/dep/index.d.ts'))).toBe(false);
      expect(confinement.readFile(join(tree, 'node_modules/dep/index.d.ts'))).toBeUndefined();
      expect(confinement.entries(join(tree, 'node_modules/dep'))).toEqual({
        files: [],
        directories: [],
      });
    });

    it('holds what the listing holds, and nothing the slot holds besides', () => {
      write(tree, { 'src/a.ts': 'a' });
      const confinement = confine();
      // Written after the listing: there on disk, and not the tree's.
      write(tree, { 'src/stale.ts': 'stale', 'dist/a.d.ts': 'built' });

      expect(confinement.fileExists(join(tree, 'src/stale.ts'))).toBe(false);
      expect(confinement.readFile(join(tree, 'src/stale.ts'))).toBeUndefined();
      expect(confinement.directoryExists(join(tree, 'dist'))).toBe(false);
      expect(confinement.entries(join(tree, 'src'))).toEqual({ files: ['a.ts'], directories: [] });
      expect(confinement.entries(tree)).toEqual({ files: [], directories: ['src'] });
      // A file the listing holds but the slot lost reads as nothing.
      rmSync(join(tree, 'src/a.ts'));
      expect(confinement.fileExists(join(tree, 'src/a.ts'))).toBe(true);
      expect(confinement.readFile(join(tree, 'src/a.ts'))).toBeUndefined();
    });

    it('ignores a node_modules the tree commits, in favour of the installed one', () => {
      write(tree, { 'node_modules/dep/index.d.ts': 'committed', 'src/a.ts': '' });
      write(deps, { 'node_modules/dep/index.d.ts': 'installed' });
      const confinement = confine();
      expect(confinement.readFile(join(tree, 'node_modules/dep/index.d.ts'))).toBe('installed');
      rmSync(join(deps, 'node_modules/dep'), { recursive: true });
      expect(confine().readFile(join(tree, 'node_modules/dep/index.d.ts'))).toBeUndefined();
    });

    it('follows a symlink the tree holds, from where it sits, and refuses one that leaves', () => {
      write(tree, { 'src/a.ts': 'a', 'src/inner/b.ts': 'b' });
      write(outside, { 'c.ts': 'c' });
      symlinkSync('a.ts', join(tree, 'src', 'alias.ts'));
      symlinkSync(join(tree, 'src', 'inner'), join(tree, 'src', 'dir-alias'));
      symlinkSync('../../outside/c.ts', join(tree, 'src', 'up.ts'));
      symlinkSync(join(outside, 'c.ts'), join(tree, 'src', 'away.ts'));
      symlinkSync('loop-b', join(tree, 'src', 'loop-a'));
      symlinkSync('loop-a', join(tree, 'src', 'loop-b'));
      const confinement = confine();

      expect(confinement.readFile(join(tree, 'src/alias.ts'))).toBe('a');
      expect(confinement.realpath(join(tree, 'src/alias.ts'))).toBe(join(tree, 'src/a.ts'));
      expect(confinement.readFile(join(tree, 'src/dir-alias/b.ts'))).toBe('b');
      for (const name of ['up.ts', 'away.ts', 'loop-a']) {
        expect(confinement.fileExists(join(tree, 'src', name))).toBe(false);
        expect(confinement.directoryExists(join(tree, 'src', name))).toBe(false);
      }
      expect(confinement.entries(join(tree, 'src'))).toEqual({
        files: ['a.ts', 'alias.ts'],
        directories: ['dir-alias', 'inner'],
      });
      expect(confinement.entries(outside)).toEqual({ files: [], directories: [] });
      expect(confinement.directoryExists(outside)).toBe(false);
    });

    it('reads nothing through a file the slot holds as a link out of it', () => {
      write(tree, { 'src/a.ts': 'a' });
      write(outside, { 'secret.ts': 'secret' });
      const confinement = new Confinement(tree, deps, NODE_FILE_SYSTEM);
      confinement.begin(listingOf(tree), null);
      // The listing says a file; the slot, rewritten since, holds a link.
      rmSync(join(tree, 'src/a.ts'));
      symlinkSync(join(outside, 'secret.ts'), join(tree, 'src/a.ts'));
      expect(confinement.readFile(join(tree, 'src/a.ts'))).toBeUndefined();
    });

    it('refuses a link the listing holds where the slot holds no link', () => {
      write(tree, { 'src/a.ts': 'a' });
      symlinkSync('a.ts', join(tree, 'src', 'alias.ts'));
      const confinement = new Confinement(tree, deps, NODE_FILE_SYSTEM);
      confinement.begin(listingOf(tree), null);
      rmSync(join(tree, 'src/alias.ts'));
      write(tree, { 'src/alias.ts': 'not a link' });
      expect(confinement.fileExists(join(tree, 'src/alias.ts'))).toBe(false);
    });

    it('serves a workspace package from the slot, files only the merge added included', () => {
      write(deps, { 'packages/lib/index.ts': 'user' });
      mkdirSync(join(deps, 'node_modules', '@fx'), { recursive: true });
      symlinkSync('../../packages/lib', join(deps, 'node_modules', '@fx', 'lib'));
      write(tree, {
        'packages/lib/index.ts': 'merged',
        'packages/lib/added.ts': 'added',
        'packages/lib/new/deep.ts': 'deep',
      });
      const confinement = confine();

      expect(confinement.readFile(join(tree, 'node_modules/@fx/lib/added.ts'))).toBe('added');
      expect(confinement.realpath(join(tree, 'node_modules/@fx/lib/added.ts'))).toBe(
        join(tree, 'packages/lib/added.ts'),
      );
      expect(confinement.readFile(join(tree, 'node_modules/@fx/lib/new/deep.ts'))).toBe('deep');
      expect(confinement.directoryExists(join(tree, 'node_modules/@fx/lib/new'))).toBe(true);
      // Past the link, the tree decides: a file only the user has is not there.
      write(deps, { 'packages/lib/only-user.ts': 'user' });
      expect(confine().fileExists(join(tree, 'node_modules/@fx/lib/only-user.ts'))).toBe(false);
      // And a path through nothing that leads anywhere is nothing.
      expect(confinement.fileExists(join(tree, 'node_modules/@fx/none/x.ts'))).toBe(false);
    });

    it('versions a file by its blob, a dependency by its install or else its disk, lib by none', () => {
      write(tree, { 'src/a.ts': 'a' });
      write(deps, { 'node_modules/dep/index.d.ts': 'dep' });
      const listing = listingOf(tree);
      const installed = new Confinement(tree, deps, NODE_FILE_SYSTEM);
      installed.begin(listing, 'one');
      expect(installed.versionOf(join(tree, 'src/a.ts'))).toBe(listing.entries[0]!.oid);
      expect(installed.versionOf(join(tree, 'node_modules/dep/index.d.ts'))).toBe('install:one');
      expect(installed.versionOf(join(tree, 'src/missing.ts'))).toBe('absent');
      expect(installed.versionOf(ts.getDefaultLibFilePath({}))).toBe('lib');

      const unrecorded = confine();
      const stat = statSync(join(deps, 'node_modules/dep/index.d.ts'));
      expect(unrecorded.versionOf(join(tree, 'node_modules/dep/index.d.ts'))).toBe(
        `stat:${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeMs)}:${String(stat.ctimeMs)}`,
      );
    });

    it('keeps what the dependency checkout answered for the life of the install', () => {
      write(deps, { 'node_modules/dep/index.d.ts': 'dep' });
      const listing = listingOf(tree);
      const { fileSystem, touched } = recording();
      const confinement = new Confinement(tree, deps, fileSystem);
      const asked = (): number => {
        touched.length = 0;
        confinement.fileExists(join(tree, 'node_modules/dep/index.d.ts'));
        return touched.length;
      };
      confinement.begin(listing, 'one');
      expect(asked()).toBeGreaterThan(0);
      confinement.begin(listing, 'one');
      expect(asked()).toBe(0);
      confinement.begin(listing, 'two');
      expect(asked()).toBeGreaterThan(0);
      // With no install recorded, the disk is asked on every check.
      confinement.begin(listing, null);
      expect(asked()).toBeGreaterThan(0);
      confinement.begin(listing, null);
      expect(asked()).toBeGreaterThan(0);
    });

    it('answers an unreadable directory as empty, and a path asked after twice once', () => {
      write(tree, { 'file.ts': '' });
      expect(NODE_FILE_SYSTEM.readdir(join(tree, 'file.ts'))).toEqual([]);
      expect(NODE_FILE_SYSTEM.readlink(join(tree, 'file.ts'))).toBeUndefined();
      expect(NODE_FILE_SYSTEM.readFile(tree)).toBeUndefined();
      const { fileSystem, touched } = recording();
      const confinement = new Confinement(tree, deps, fileSystem);
      confinement.begin(listingOf(tree), null);
      const missing = join(tree, 'node_modules/missing.ts');
      expect(confinement.realpath(missing)).toBe(missing);
      const asked = touched.length;
      expect(confinement.realpath(missing)).toBe(missing);
      // Remembered within a check, absent answers included.
      expect(touched).toHaveLength(asked);
    });

    it('decides containment on whole path segments', () => {
      write(base, { 'tree-other/x.ts': 'x' });
      write(tree, { '..tree/y.ts': 'y' });
      const confinement = confine();
      expect(confinement.readFile(join(base, 'tree-other/x.ts'))).toBeUndefined();
      // `..tree` is a directory in the tree, not a way out of it.
      expect(confinement.readFile(join(tree, '..tree/y.ts'))).toBe('y');
    });

    it('never asks the file system about a path outside its roots during a check', () => {
      const { fileSystem, touched } = recording();
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
      const result = check(open({ fileSystem }));

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
      // The link in the tree is read as a link, which names its target; nothing reads it.
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
      const result = check(open());
      expect(report(result).files.map((d) => [d.file, d.line, d.code])).toEqual([
        ['src/a.ts', 2, 2322],
        ['src/a.ts', 3, 2322],
      ]);
    });

    it('asks nothing of node_modules on a warm check of the same install', () => {
      write(deps, {
        'node_modules/dep/package.json': JSON.stringify({ name: 'dep', types: 'index.d.ts' }),
        'node_modules/dep/index.d.ts': 'export declare const dep: string;\n',
      });
      write(tree, {
        'tsconfig.json': tsconfig(),
        'src/a.ts': "import { dep } from 'dep';\nexport const a: number = dep;\n",
      });
      const { fileSystem, touched } = recording();
      const service = open({ fileSystem });
      const underNodeModules = (): string[] =>
        touched.filter((path) => path.startsWith(join(deps, 'node_modules')));

      expect(codes(check(service, { install: 'one' }))).toEqual([['src/a.ts', 2322]]);
      expect(underNodeModules().length).toBeGreaterThan(0);
      touched.length = 0;
      expect(codes(check(service, { install: 'one' }))).toEqual([['src/a.ts', 2322]]);
      expect(underNodeModules()).toEqual([]);
      // Unrecorded, each file's version comes from the disk on every check.
      expect(codes(check(service))).toEqual([['src/a.ts', 2322]]);
      expect(underNodeModules().length).toBeGreaterThan(0);
    });

    it('reads a dependency again when its install changes, and not before', () => {
      write(deps, {
        'node_modules/dep/package.json': JSON.stringify({ name: 'dep', types: 'index.d.ts' }),
        'node_modules/dep/index.d.ts': 'export declare const dep: string;\n',
      });
      write(tree, {
        'tsconfig.json': tsconfig(),
        'src/a.ts': "import { dep } from 'dep';\nexport const a: number = dep;\n",
      });
      const service = open();
      expect(codes(check(service, { install: 'one' }))).toEqual([['src/a.ts', 2322]]);
      write(deps, { 'node_modules/dep/index.d.ts': 'export declare const dep: number;\n' });
      // Rewritten without an install: the version holds, and so does the answer.
      expect(codes(check(service, { install: 'one' }))).toEqual([['src/a.ts', 2322]]);
      expect(codes(check(service, { install: 'two' }))).toEqual([]);
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
      const parsed = readProject(join(tree, 'tsconfig.json'), confine());
      expect(parsed.errors).toEqual([]);
      expect(parsed.options.strict).toBe(true);
      expect(parsed.options).not.toHaveProperty('plugins');
      expect(parsed.fileNames).toEqual([join(tree, 'src/a.ts')]);
    });

    it('reports an unreadable tsconfig and checks nothing', () => {
      const result = check(open());
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
      const first = report(check(service)).config;
      expect(first.map((d) => [d.code, d.file, d.category])).toEqual([
        [5025, 'tsconfig.json', 'error'],
      ]);
      expect(report(check(service)).config).toEqual(first);
    });

    it('refuses a TypeScript without the file matcher a tsconfig is read with', () => {
      expect(typeof matchFilesOf(ts)).toBe('function');
      expect(() => matchFilesOf({})).toThrow('does not provide matchFiles');
    });

    it('refuses a TypeScript without the cache a check is counted by', () => {
      const program = { getSourceFiles: () => [] } as unknown as ts.Program;
      expect(() => filesCheckedBy(program)).toThrow(
        'does not provide getCachedSemanticDiagnostics',
      );
    });

    it('checks the project it is given, relative to the tree', () => {
      write(tree, {
        'app/tsconfig.json': tsconfig(),
        'app/src/a.ts': 'export const a: number = "";\n',
        'src/ignored.ts': 'export const b: number = "";\n',
      });
      const result = check(open({ project: 'app/tsconfig.json' }));
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
      expect(codes(check(service))).toEqual([['one/src/index.ts', 2322]]);
      write(tree, {
        'tsconfig.json': JSON.stringify({ files: [], references: [{ path: 'two' }] }),
      });
      const after = check(service);
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
      expect(codes(check(open()))).toEqual([['app/src/main.ts', 7006]]);
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
      const result = check(open());
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
      const result = check(open());
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
      expect(codes(check(open()))).toEqual([['src/a.ts', 1109]]);
    });

    it('stops at a configuration error before the semantic check', () => {
      write(tree, {
        'tsconfig.json': tsconfig({ lib: ['es2099'] }),
        'src/a.ts': 'export const a: number = "";\n',
      });
      const result = report(check(open()));
      expect(result.files).toEqual([]);
      expect(result.config.map((d) => d.code)).toContain(6046);
    });

    it('reports an error in a lib file with the configuration, and its twin with the code', () => {
      // A global class named as a lib's own declaration is a duplicate in both.
      write(tree, {
        'tsconfig.json': tsconfig({ moduleDetection: 'legacy' }),
        'src/a.ts': 'declare class Symbol {}\n',
      });
      const result = report(check(open()));
      expect(result.files.map((d) => [d.file, d.code])).toContainEqual(['src/a.ts', 2300]);
      expect(result.config.find((d) => d.code === 2300)).toMatchObject({
        file: null,
        start: null,
        length: null,
      });
    });

    it('reports a file two unrelated projects list under each one’s options', () => {
      const project = (strict: boolean) =>
        JSON.stringify({
          compilerOptions: { composite: true, lib: ['es2022'], types: [], strict },
          include: ['../shared'],
        });
      write(tree, {
        'tsconfig.json': JSON.stringify({
          files: [],
          references: [{ path: 'lax' }, { path: 'strict' }],
        }),
        'lax/tsconfig.json': project(false),
        'strict/tsconfig.json': project(true),
        'shared/a.ts': 'export function f(x) {\n  return x;\n}\n',
      });
      // `tsc -b` builds the file in both, and the strict one says so.
      expect(codes(check(open()))).toEqual([['shared/a.ts', 7006]]);
    });

    it('notices a file that has gone', () => {
      write(tree, {
        'tsconfig.json': tsconfig(),
        'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
        'src/b.ts': 'export const b = 1;\n',
      });
      const service = open();
      expect(codes(check(service))).toEqual([]);
      rmSync(join(tree, 'src/b.ts'));
      expect(codes(check(service))).toEqual([['src/a.ts', 2307]]);
    });

    it('reads a file the listing holds and the slot lost as a file not found', () => {
      write(tree, { 'tsconfig.json': tsconfig(), 'src/a.ts': 'export const a = 1;\n' });
      const listing = listingOf(tree);
      rmSync(join(tree, 'src/a.ts'));
      const result = open().check({ tree: listing, install: null });
      expect(report(result).files).toEqual([]);
      expect(report(result).config.map((d) => d.code)).toContain(6053);
    });

    it('reports a tree that is not there as having no tsconfig', () => {
      const service = createTypecheckService({ root: join(base, 'gone'), dependencyRoot: deps });
      services.push(service);
      const result = service.check({ tree: { oid: 'empty', entries: [] }, install: null });
      expect(report(result).config.map((d) => d.code)).toEqual([5083]);
    });
  });

  describe('incremental state', () => {
    it('sees a file rewritten with the same size and modification time', () => {
      write(tree, { 'tsconfig.json': tsconfig(), 'src/a.ts': 'export const a: number = 1;\n' });
      const path = join(tree, 'src/a.ts');
      // Whole seconds, so setting the time back restores it exactly.
      utimesSync(path, 1_700_000_000, 1_700_000_000);
      const service = open();
      expect(codes(check(service))).toEqual([]);
      const before = statSync(path);
      writeFileSync(path, 'export const a: string = 1;\n');
      utimesSync(path, 1_700_000_000, 1_700_000_000);
      expect(statSync(path)).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs });
      expect(codes(check(service))).toEqual([['src/a.ts', 2322]]);
    });

    it('reads no file of the tree again while its blob is the same, however it was written', () => {
      write(tree, { 'tsconfig.json': tsconfig(), 'src/a.ts': 'export const a: number = 1;\n' });
      const { fileSystem, touched } = recording();
      const service = open({ fileSystem });
      expect(codes(check(service))).toEqual([]);
      // Written anew with the same content: a new inode and change time, the same blob.
      rmSync(join(tree, 'src/a.ts'));
      write(tree, { 'src/a.ts': 'export const a: number = 1;\n' });
      touched.length = 0;
      expect(codes(check(service))).toEqual([]);
      expect(touched.filter((path) => path.startsWith(join(tree, 'src')))).toEqual([]);
    });

    it('resolves an import again once the file it names appears', () => {
      write(tree, {
        'tsconfig.json': tsconfig(),
        'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
      });
      const service = open();
      expect(codes(check(service))).toEqual([['src/a.ts', 2307]]);
      write(tree, { 'src/b.ts': 'export const b = 1;\n' });
      expect(codes(check(service))).toEqual([]);
    });

    it('resolves an import outside include again once a merge adds its file', () => {
      write(tree, {
        'tsconfig.json': tsconfig(),
        'src/a.ts': "import { b } from '../extra/b';\nexport const a: string = b;\n",
      });
      const service = open();
      expect(codes(check(service))).toEqual([['src/a.ts', 2307]]);
      write(tree, { 'extra/b.ts': 'export const b = 1;\n' });
      expect(codes(check(service))).toEqual([['src/a.ts', 2322]]);
    });

    it('resolves every import again after a check that did not reach the semantic pass', () => {
      write(tree, {
        'tsconfig.json': tsconfig(),
        'src/a.ts': "import { b } from '../extra/b';\nexport const a: string = b;\n",
        'src/c.ts': 'const c = (;\n',
      });
      const service = open();
      expect(codes(check(service))).toEqual([['src/c.ts', 1109]]);
      // The importer is untouched: only the gate says its lookup is suspect.
      write(tree, { 'extra/b.ts': 'export const b = 1;\n', 'src/c.ts': 'export const c = 1;\n' });
      expect(codes(check(service))).toEqual([['src/a.ts', 2322]]);
    });

    it('resolves every import again after a check that was cancelled', () => {
      const files: Record<string, string> = {
        'tsconfig.json': tsconfig(),
        'src/a.ts': 'export const a = 1;\n',
      };
      // Enough files affected by a change to `a` for the checker to poll the
      // token after the program is built.
      for (let i = 0; i < 40; i++) {
        files[`src/f${String(i)}.ts`] =
          `import { a } from './a';\nexport const v${String(i)} = a;\n`;
      }
      write(tree, files);
      const service = open();
      expect(codes(check(service))).toEqual([]);
      // The cancelled check is the one that saw this import fail, after its
      // program was built and before it could write the failure down.
      write(tree, { 'src/a.ts': "import { b } from '../extra/b';\nexport const a: string = b;\n" });
      let polls = 0;
      expect(check(service, { isCancelled: () => (polls += 1) > 1 })).toMatchObject({
        kind: 'cancelled',
      });
      write(tree, { 'extra/b.ts': 'export const b = 1;\n' });
      expect(codes(check(service))).toEqual([['src/a.ts', 2322]]);
    });

    it('keeps its program over an unresolved import while neither the tree nor the install moves', () => {
      write(tree, {
        'tsconfig.json': tsconfig(),
        'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
        'src/c.ts': 'export const c = 1;\n',
      });
      const service = open();
      const built = (result: TypecheckResult): number =>
        result.kind === 'checked' ? result.programsBuilt : Number.NaN;
      const listing = listingOf(tree);
      const first = service.check({ tree: listing, install: 'one' });
      expect(codes(first)).toEqual([['src/a.ts', 2307]]);
      expect(built(first)).toBe(1);
      // Nothing a failed lookup tried can have appeared: the program stands.
      expect(built(service.check({ tree: listing, install: 'one' }))).toBe(0);
      // Without a record of the install, anything under `node_modules` may have.
      expect(built(service.check({ tree: listing, install: null }))).toBe(1);
      expect(built(service.check({ tree: listing, install: 'one' }))).toBe(1);
      expect(built(service.check({ tree: listing, install: 'one' }))).toBe(0);
      // A check cut short leaves the next one to look again.
      expect(service.check({ tree: listing, install: 'one', isCancelled: () => true }).kind).toBe(
        'cancelled',
      );
      expect(built(service.check({ tree: listing, install: 'one' }))).toBe(1);
      // A tree that moves is looked through again, and the file is there.
      write(tree, { 'src/b.ts': 'export const b = 1;\n' });
      expect(codes(service.check({ tree: listingOf(tree), install: 'one' }))).toEqual([]);
    });

    it('reports declaration errors only once nothing else is wrong, as tsc does', () => {
      write(tree, {
        'tsconfig.json': tsconfig({ declaration: true }),
        'src/a.ts': 'export const make = () => class {\n  private x = 1;\n};\n',
        'src/b.ts': 'export const b: number = "";\n',
      });
      expect(codes(check(open()))).toEqual([['src/b.ts', 2322]]);
    });

    it('reuses declaration diagnostics only for files no change affected', () => {
      write(tree, {
        'tsconfig.json': tsconfig({ declaration: true }),
        'src/a.ts': 'export const make = () => class {\n  private x = 1;\n};\n',
        'src/b.ts': 'export const b = 1;\n',
      });
      const service = open();
      expect(codes(check(service))).toEqual([['src/a.ts', 4094]]);
      expect(codes(check(service))).toEqual([['src/a.ts', 4094]]);
      write(tree, { 'src/a.ts': 'export const make = () => class {\n  x = 1;\n};\n' });
      expect(codes(check(service))).toEqual([]);
      write(tree, { 'src/b.ts': 'export const make = () => class {\n  protected y = 1;\n};\n' });
      expect(codes(check(service))).toEqual([['src/b.ts', 4094]]);
    });

    it('counts the files a check type-checks: all of them cold, and what an edit affects warm', () => {
      write(tree, {
        'tsconfig.json': tsconfig(),
        'src/a.ts': 'export function a(n: number): number {\n  return n;\n}\n',
        'src/b.ts': "import { a } from './a';\nexport const b = a(1);\n",
        'src/c.ts': 'export const c = 3;\n',
      });
      const service = open();
      const cold = check(service);
      // The three sources and the `lib` files their program holds.
      expect(cold.filesChecked).toBeGreaterThan(3);
      expect(check(service).filesChecked).toBe(0);
      // The first edit after a cold check finds no shape to compare with, so
      // the importer is checked too; `c` never is.
      write(tree, { 'src/a.ts': 'export function a(n: number): number {\n  return n + 1;\n}\n' });
      expect(check(service).filesChecked).toBe(2);
      // Its signature held, so the file that imports it is not affected.
      write(tree, { 'src/a.ts': 'export function a(n: number): number {\n  return n + 2;\n}\n' });
      expect(check(service).filesChecked).toBe(1);
    });

    it('counts the importers an edit re-checks where isolated modules leave them unaffected', () => {
      // Under `isolatedModules` an edit affects its own file alone: the builder
      // drops what it kept for each importer and checks them only when asked
      // for every file's diagnostics, after the affected files are done.
      write(tree, {
        'tsconfig.json': tsconfig({ isolatedModules: true }),
        'src/a.ts': 'export function a(n: number): number {\n  return n;\n}\n',
        'src/b.ts': "import { a } from './a';\nexport const b = a(1);\n",
        'src/c.ts': 'export const c = 3;\n',
      });
      const service = open();
      check(service);
      write(tree, {
        'src/a.ts': 'export function a(n: number, m: number): number {\n  return n + m;\n}\n',
      });
      const signature = check(service);
      expect(signature.filesChecked).toBe(2);
      expect(codes(signature)).toEqual([['src/b.ts', 2554]]);
      write(tree, {
        'src/a.ts': 'export function a(n: number, m: number): number {\n  return n - m;\n}\n',
      });
      expect(check(service).filesChecked).toBe(1);
    });

    it('stops part way through the importers an edit re-checks, and resumes there', () => {
      // Under `isolatedModules` the importers of an edit's new shape are
      // checked after the affected files, in one pass over every file: most of
      // what the edit costs, so the token has to reach it.
      const files: Record<string, string> = {
        'tsconfig.json': tsconfig({ isolatedModules: true }),
        'src/shape.ts': 'export interface Shape {\n  a: number;\n}\n',
      };
      // Functions, because the checker polls its token at each declaration of
      // one, and at little else: the polls are then where the checking is.
      for (let i = 0; i < 100; i++) {
        files[`src/f${String(i)}.ts`] = [
          "import type { Shape } from './shape';",
          `export const v${String(i)}: Shape = { a: ${String(i)} };`,
          ...Array.from(
            { length: 20 },
            (_, j) =>
              `export function w${String(j)}(x: number): number[] {\n  return [x, ${String(j)}];\n}`,
          ),
        ].join('\n');
      }
      write(tree, files);
      const service = open();
      const cold = check(service);
      const before = 'export interface Shape {\n  a: number;\n}\n';
      const after = 'export interface Shape {\n  a: number;\n  b?: string;\n}\n';

      // The edit's whole check, its polls counted.
      write(tree, { 'src/shape.ts': after });
      let polls = 0;
      const full = check(service, { isCancelled: () => ((polls += 1), false) });
      // The file edited, and every file importing it.
      expect(full.filesChecked).toBe(101);

      // Undoing it changes the shape back, and re-checks the same files.
      write(tree, { 'src/shape.ts': before });
      let seen = 0;
      const cancelled = check(service, { isCancelled: () => (seen += 1) > polls / 2 });
      expect(cancelled.kind).toBe('cancelled');
      expect(cancelled.filesChecked).toBeGreaterThan(1);
      expect(cancelled.filesChecked).toBeLessThan(full.filesChecked);

      const resumed = check(service);
      expect(resumed.filesChecked).toBe(full.filesChecked - cancelled.filesChecked);
      expect(report(resumed)).toEqual(report(cold));
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
      const cancelled = check(service, { isCancelled: () => (polls += 1) > 20 });
      expect(cancelled.kind).toBe('cancelled');
      expect(polls).toBeGreaterThan(20);
      expect(codes(check(service))).toHaveLength(40);
    });

    it('rethrows anything that is not a cancellation', () => {
      write(tree, { 'tsconfig.json': tsconfig(), 'src/a.ts': '' });
      // Asked of the compiler's own `lib` as the program is built.
      const failing: HostFileSystem = {
        ...NODE_FILE_SYSTEM,
        stat: () => {
          throw new Error('disk gone');
        },
      };
      expect(() => check(open({ fileSystem: failing }))).toThrow('disk gone');
    });
  });

  describe('the worker module', () => {
    it('defaults to the project the registry sends when a request names none', () => {
      expect(DEFAULT_PROJECT).toBe(REGISTRY_DEFAULT_PROJECT);
    });

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

    const request = (id: number, cancel = new SharedArrayBuffer(4)): WorkerRequest => ({
      type: 'check',
      id,
      tree: listingOf(tree),
      install: null,
      cancel,
    });

    it('answers each check with its result, its time and its heap', () => {
      write(tree, { 'tsconfig.json': tsconfig(), 'src/a.ts': 'export const a: number = "";\n' });
      const { fake, sent, send, closed } = port();
      serveTypecheck(fake, { root: tree, dependencyRoot: deps, project: 'tsconfig.json' });
      send(request(7));

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
      send(request(1, cancel));
      expect(sent[1]).toMatchObject({ type: 'result', id: 1, result: { kind: 'cancelled' } });
    });

    it('lets a check the compiler threw on take the thread down with it', () => {
      write(tree, { 'tsconfig.json': tsconfig(), 'src/a.ts': '' });
      const { fake, sent, send } = port();
      const failing: HostFileSystem = {
        ...NODE_FILE_SYSTEM,
        stat: () => {
          throw new Error('disk gone');
        },
      };
      serveTypecheck(fake, { root: tree, dependencyRoot: deps, project: 'tsconfig.json' }, failing);
      expect(() => {
        send(request(2));
      }).toThrow('disk gone');
      expect(sent).toEqual([{ type: 'started', id: 2 }]);
    });
  });
});
