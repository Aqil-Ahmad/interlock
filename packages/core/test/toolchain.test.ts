import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '@interlock/shared';
import type { RepoConfigOverride, RepoId } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitRunner, subcommandOf } from '../src/git/repo-handle.js';
import type { GitRunner, ShadowRepo, UserRepo } from '../src/git/repo-handle.js';
import { ensureShadow } from '../src/git/shadow.js';
import {
  detectToolchain,
  MAX_TOOLCHAIN_FILE_BYTES,
  ToolchainCache,
  toolchainUnsupported,
} from '../src/sandbox/toolchain.js';
import type { Toolchain } from '../src/sandbox/toolchain.js';
import { rejection } from './support/rejection.js';

/**
 * Toolchain detection against real trees in a real shadow.
 *
 * Every fixture is committed in a temporary repository and read back through
 * the shadow `ensureShadow` makes of it, which is the only way detection ever
 * sees a tree. What is asserted is the whole answer for each capability, so a
 * case that should leave the others alone is shown to.
 */
describe('detectToolchain', () => {
  let base: string;
  let dir: string;
  let dataDir: string;
  const repoId = ulid<RepoId>();
  const runner = createGitRunner();

  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-toolchain-')));
    dir = join(base, 'repo');
    dataDir = join(base, 'data');
    mkdirSync(dir);
    git('-c', 'init.defaultBranch=main', 'init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'maintenance.auto', 'false');
    git('config', 'gc.auto', '0');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** A file's content, a symlink's target, or a submodule's commit. */
  type Files = Readonly<
    Record<string, string | { readonly link: string } | { readonly gitlink: string }>
  >;

  /** Replace the whole worktree with `files`, commit it, and return the commit. */
  const commit = (files: Files): string => {
    for (const name of readdirSync(dir)) {
      if (name !== '.git') rmSync(join(dir, name), { recursive: true, force: true });
    }
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      if (typeof content === 'string') writeFileSync(join(dir, path), content);
      else if ('link' in content) symlinkSync(content.link, join(dir, path));
    }
    git('add', '-A');
    for (const [path, content] of Object.entries(files)) {
      if (typeof content !== 'string' && 'gitlink' in content) {
        git('update-index', '--add', '--cacheinfo', `160000,${content.gitlink},${path}`);
      }
    }
    git('commit', '-q', '--allow-empty', '-m', 'fixture');
    return git('rev-parse', 'HEAD').trim();
  };

  const shadowOf = (): Promise<ShadowRepo> => {
    const repo: UserRepo = { kind: 'user', rootPath: dir, gitDir: join(dir, '.git') };
    return ensureShadow(repo, { runner, dataDir, repoId });
  };

  const detect = async (
    files: Files,
    extra: {
      override?: RepoConfigOverride['toolchain'];
      cache?: ToolchainCache;
      runner?: GitRunner;
    } = {},
  ): Promise<Toolchain> => {
    const tree = commit(files);
    return detectToolchain({
      runner: extra.runner ?? runner,
      shadow: await shadowOf(),
      tree,
      ...extra,
    });
  };

  const json = (value: unknown): string => JSON.stringify(value, null, 2);
  const typescriptDev = { devDependencies: { typescript: '^5.0.0' } };
  const tsconfig = json({ compilerOptions: { strict: true } });

  const unsupported = (reason: string | RegExp): unknown => ({
    status: 'unsupported',
    code: 'TOOLCHAIN_UNSUPPORTED',
    reason: typeof reason === 'string' ? reason : (expect.stringMatching(reason) as unknown),
  });

  const allUnsupported = (toolchain: Toolchain, reason: RegExp): void => {
    for (const capability of ['packageManager', 'install', 'typecheck', 'build'] as const) {
      expect(toolchain[capability], capability).toEqual(unsupported(reason));
    }
  };

  describe('each supported package manager', () => {
    it('detects pnpm from its lockfile', async () => {
      const toolchain = await detect({
        'package.json': json({ scripts: { build: 'tsc -b' }, ...typescriptDev }),
        'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
        'tsconfig.json': tsconfig,
      });
      expect(toolchain).toEqual({
        packageManager: { status: 'supported', name: 'pnpm', version: null, from: 'lockfile' },
        install: {
          status: 'supported',
          origin: 'detected',
          argv: ['pnpm', 'install', '--frozen-lockfile'],
        },
        typecheck: {
          status: 'supported',
          origin: 'detected',
          runner: 'language-service',
          projects: ['tsconfig.json'],
        },
        build: { status: 'supported', origin: 'detected', argv: ['pnpm', 'run', 'build'] },
      });
    });

    it('detects npm from either of its lockfiles', async () => {
      for (const lockfile of ['package-lock.json', 'npm-shrinkwrap.json']) {
        const toolchain = await detect({
          'package.json': json({ scripts: { build: 'tsc' }, ...typescriptDev }),
          [lockfile]: json({ lockfileVersion: 3 }),
          'tsconfig.json': tsconfig,
        });
        expect(toolchain.packageManager, lockfile).toEqual({
          status: 'supported',
          name: 'npm',
          version: null,
          from: 'lockfile',
        });
        expect(toolchain.install).toEqual({
          status: 'supported',
          origin: 'detected',
          argv: ['npm', 'ci'],
        });
        expect(toolchain.build).toEqual({
          status: 'supported',
          origin: 'detected',
          argv: ['npm', 'run', 'build'],
        });
      }
    });

    it('detects Yarn classic from a lockfile without a Berry header', async () => {
      const toolchain = await detect({
        'package.json': json({ scripts: { build: 'tsc' }, ...typescriptDev }),
        'yarn.lock':
          '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n',
        'tsconfig.json': tsconfig,
      });
      expect(toolchain.packageManager).toEqual({
        status: 'supported',
        name: 'yarn-classic',
        version: null,
        from: 'lockfile',
      });
      expect(toolchain.install).toEqual({
        status: 'supported',
        origin: 'detected',
        argv: ['yarn', 'install', '--frozen-lockfile'],
      });
      expect(toolchain.build).toEqual({
        status: 'supported',
        origin: 'detected',
        argv: ['yarn', 'run', 'build'],
      });
    });

    it('detects Yarn Berry linking into node_modules', async () => {
      const toolchain = await detect({
        'package.json': json({ packageManager: 'yarn@4.5.0', ...typescriptDev }),
        'yarn.lock': '__metadata:\n  version: 8\n',
        '.yarnrc.yml': 'nodeLinker: node-modules # no PnP\n',
        'tsconfig.json': tsconfig,
      });
      expect(toolchain.packageManager).toEqual({
        status: 'supported',
        name: 'yarn-berry',
        version: '4.5.0',
        from: 'packageManager',
      });
      expect(toolchain.install).toEqual({
        status: 'supported',
        origin: 'detected',
        argv: ['yarn', 'install', '--immutable'],
      });
    });

    it('tells Berry from the lockfile header alone, and refuses it without node_modules linking', async () => {
      const toolchain = await detect({
        'package.json': json(typescriptDev),
        'yarn.lock':
          '# This file is generated by running "yarn install".\n\n__metadata:\n  version: 8\n',
        'tsconfig.json': tsconfig,
      });
      allUnsupported(toolchain, /^Yarn Berry links with Plug'n'Play unless/u);
    });

    it('tells Berry from .yarnrc.yml, and accepts a quoted linker', async () => {
      const toolchain = await detect({
        'package.json': json(typescriptDev),
        'yarn.lock': 'not a berry header\n',
        '.yarnrc.yml': 'yarnPath: .yarn/releases/yarn.cjs\nnodeLinker: "node-modules"\n',
        'tsconfig.json': tsconfig,
      });
      expect(toolchain.packageManager).toMatchObject({ status: 'supported', name: 'yarn-berry' });
    });

    it('refuses Berry with another linker, without naming it', async () => {
      const toolchain = await detect({
        'package.json': json({ packageManager: 'yarn@3.6.4', ...typescriptDev }),
        'yarn.lock': '__metadata:\n',
        '.yarnrc.yml': 'nodeLinker: pnpm\n',
        'tsconfig.json': tsconfig,
      });
      allUnsupported(toolchain, /^Yarn Berry links with something other than node-modules$/u);
    });

    it('reads the version packageManager names, without its hash', async () => {
      const toolchain = await detect({
        'package.json': json({
          packageManager:
            'pnpm@9.12.3+sha512.cce0f9de9c5a7c95bef944169cc5dfe8741abfb145078c0d508b868056848a87c81e626246cb60967cbd7fd29a6c062ef73ff840d96b3c86c40ac92cf4a813ee',
          ...typescriptDev,
        }),
        'pnpm-lock.yaml': '',
        'tsconfig.json': tsconfig,
      });
      expect(toolchain.packageManager).toEqual({
        status: 'supported',
        name: 'pnpm',
        version: '9.12.3',
        from: 'packageManager',
      });
    });

    it('takes Yarn classic from packageManager naming version 1', async () => {
      const toolchain = await detect({
        'package.json': json({ packageManager: 'yarn@1.22.22', ...typescriptDev }),
        'tsconfig.json': tsconfig,
      });
      expect(toolchain.packageManager).toEqual({
        status: 'supported',
        name: 'yarn-classic',
        version: '1.22.22',
        from: 'packageManager',
      });
    });
  });

  describe('what is refused, and why', () => {
    it('refuses a tree with no package.json', async () => {
      allUnsupported(await detect({ 'README.md': 'hi\n' }), /^no package.json at the root/u);
    });

    it('names Deno when its markers stand in for a package.json', async () => {
      allUnsupported(
        await detect({ 'deno.json': '{}' }),
        /^no package.json at the root of the tree; deno.json marks a Deno project$/u,
      );
      allUnsupported(
        await detect({ 'package.json': '{}', 'deno.lock': '{}' }),
        /^deno.lock marks a Deno project$/u,
      );
    });

    it('refuses Bun by lockfile, by either name, and by packageManager', async () => {
      for (const lockfile of ['bun.lockb', 'bun.lock']) {
        allUnsupported(
          await detect({
            'package.json': json(typescriptDev),
            [lockfile]: 'x',
            'tsconfig.json': tsconfig,
          }),
          new RegExp(`^${lockfile.replace('.', '\\.')} marks a Bun project$`, 'u'),
        );
      }
      allUnsupported(
        await detect({ 'package.json': json({ packageManager: 'bun@1.1.0' }) }),
        /^packageManager names Bun$/u,
      );
    });

    it("refuses Plug'n'Play, whatever the linker setting says", async () => {
      allUnsupported(
        await detect({
          'package.json': json(typescriptDev),
          'yarn.lock': '__metadata:\n',
          '.yarnrc.yml': 'nodeLinker: node-modules\n',
          '.pnp.cjs': 'module.exports = {};\n',
          'tsconfig.json': tsconfig,
        }),
        /^\.pnp\.cjs marks Yarn Plug'n'Play/u,
      );
    });

    it('refuses lockfiles from two managers that nothing settles', async () => {
      allUnsupported(
        await detect({
          'package.json': json(typescriptDev),
          'pnpm-lock.yaml': '',
          'package-lock.json': '{}',
          'tsconfig.json': tsconfig,
        }),
        /^lockfiles from more than one package manager \(pnpm-lock.yaml, package-lock.json\)/u,
      );
    });

    it('lets packageManager settle two lockfiles', async () => {
      const toolchain = await detect({
        'package.json': json({ packageManager: 'npm@10.8.2', ...typescriptDev }),
        'pnpm-lock.yaml': '',
        'package-lock.json': '{}',
        'tsconfig.json': tsconfig,
      });
      expect(toolchain.packageManager).toEqual({
        status: 'supported',
        name: 'npm',
        version: '10.8.2',
        from: 'packageManager',
      });
    });

    it('says so when packageManager disagrees with the lockfile, rather than picking one', async () => {
      allUnsupported(
        await detect({
          'package.json': json({ packageManager: 'pnpm@9.0.0', ...typescriptDev }),
          'package-lock.json': '{}',
          'tsconfig.json': tsconfig,
        }),
        /^packageManager names pnpm, but the only lockfile is package-lock.json$/u,
      );
    });

    it('refuses a tree with neither a lockfile nor packageManager, rather than guessing npm', async () => {
      allUnsupported(
        await detect({ 'package.json': json(typescriptDev), 'tsconfig.json': tsconfig }),
        /^no lockfile and no packageManager field/u,
      );
    });

    it('refuses a malformed or unknown packageManager without echoing it', async () => {
      for (const field of ['pnpm', 'pnpm@latest', '@9.0.0', 42, 'pnpm@9']) {
        const toolchain = await detect({ 'package.json': json({ packageManager: field }) });
        allUnsupported(toolchain, /^packageManager is not of the form <name>@<version>$/u);
      }
      const unknown = await detect({ 'package.json': json({ packageManager: 'evil@1.0.0' }) });
      allUnsupported(unknown, /^packageManager names a manager other than pnpm, npm or Yarn$/u);
      expect(JSON.stringify(unknown)).not.toContain('evil');
    });

    it('refuses typecheck alone for JavaScript with no tsconfig, and still detects the build', async () => {
      const toolchain = await detect({
        'package.json': json({ scripts: { build: 'node build.js' } }),
        'package-lock.json': '{}',
        'build.js': 'console.log(1);\n',
      });
      expect(toolchain.typecheck).toEqual(
        unsupported('no tsconfig.json at the root or in any workspace package'),
      );
      expect(toolchain.build).toEqual({
        status: 'supported',
        origin: 'detected',
        argv: ['npm', 'run', 'build'],
      });
      expect(toolchain.install).toMatchObject({ status: 'supported' });
    });

    it('refuses typecheck when nothing depends on typescript', async () => {
      const toolchain = await detect({
        'package.json': json({ dependencies: { lodash: '^4.0.0' } }),
        'package-lock.json': '{}',
        'tsconfig.json': tsconfig,
      });
      expect(toolchain.typecheck).toEqual(
        unsupported('typescript is not a dependency of the root or of any workspace package'),
      );
    });

    it('answers no build, rather than a failure, for a project without a build script', async () => {
      const toolchain = await detect({
        'package.json': json({ scripts: { test: 'vitest' }, ...typescriptDev }),
        'package-lock.json': '{}',
        'tsconfig.json': tsconfig,
      });
      expect(toolchain.build).toEqual({ status: 'none' });
      expect(
        (await detect({ 'package.json': json(typescriptDev), 'package-lock.json': '{}' })).build,
      ).toEqual({ status: 'none' });
    });

    it('refuses a build script that is not a command', async () => {
      for (const scripts of [{ build: 7 }, { build: '  ' }, ['build']]) {
        const toolchain = await detect({
          'package.json': json({ scripts }),
          'package-lock.json': '{}',
        });
        expect(toolchain.build, JSON.stringify(scripts)).toMatchObject({ status: 'unsupported' });
      }
    });

    it('turns an unsupported capability into an infra TOOLCHAIN_UNSUPPORTED error', async () => {
      const toolchain = await detect({ 'package.json': json({ packageManager: 'bun@1.1.0' }) });
      if (toolchain.typecheck.status !== 'unsupported') throw new Error('expected unsupported');
      const error = toolchainUnsupported('typecheck', toolchain.typecheck);
      expect(error.code).toBe('TOOLCHAIN_UNSUPPORTED');
      expect(error.infra).toBe(true);
      expect(error.details).toEqual({
        capability: 'typecheck',
        reason: 'packageManager names Bun',
      });
      expect(error.message).toBe('Cannot typecheck: packageManager names Bun');
      expect(toolchainUnsupported('packageManager', toolchain.typecheck).message).toBe(
        'Cannot identify the package manager: packageManager names Bun',
      );
    });
  });

  describe('typecheck projects', () => {
    it('expands a solution-style root into the projects it references', async () => {
      const toolchain = await detect({
        'package.json': json(typescriptDev),
        'pnpm-lock.yaml': '',
        'tsconfig.json': [
          '{',
          '  // A solution file: builds every package.',
          '  "files": [],',
          '  "references": [',
          '    { "path": "packages/b" },',
          '    { "path": "./packages/a/tsconfig.json" }, /* a file, not a directory */',
          '  ],',
          '}',
        ].join('\n'),
        'packages/a/tsconfig.json': tsconfig,
        'packages/b/tsconfig.json': tsconfig,
      });
      expect(toolchain.typecheck).toEqual({
        status: 'supported',
        origin: 'detected',
        runner: 'language-service',
        projects: ['packages/a/tsconfig.json', 'packages/b/tsconfig.json'],
      });
    });

    it('expands a nested solution, follows a reference cycle once, and keeps a non-solution root whole', async () => {
      const nested = await detect({
        'package.json': json(typescriptDev),
        'pnpm-lock.yaml': '',
        'tsconfig.json': json({ files: [], references: [{ path: 'apps' }] }),
        'apps/tsconfig.json': json({ files: [], references: [{ path: 'web' }, { path: '..' }] }),
        'apps/web/tsconfig.json': tsconfig,
      });
      expect(nested.typecheck).toMatchObject({ projects: ['apps/web/tsconfig.json'] });

      const whole = await detect({
        'package.json': json(typescriptDev),
        'pnpm-lock.yaml': '',
        'tsconfig.json': json({ include: ['src'], references: [{ path: 'lib' }] }),
        'lib/tsconfig.json': tsconfig,
      });
      expect(whole.typecheck).toMatchObject({ projects: ['tsconfig.json'] });

      const ownFiles = await detect({
        'package.json': json(typescriptDev),
        'pnpm-lock.yaml': '',
        'tsconfig.json': json({ files: ['index.ts'], references: [{ path: 'lib' }] }),
        'lib/tsconfig.json': tsconfig,
      });
      expect(ownFiles.typecheck).toMatchObject({ projects: ['tsconfig.json'] });
    });

    it('refuses a reference that leaves the tree or names nothing in it', async () => {
      // `../packages/a` and `/packages/a` name a real project once clamped
      // into the tree, so only refusing the climb itself keeps them out.
      for (const path of [
        '../outside',
        '../packages/a',
        '/etc',
        '/packages/a',
        'missing',
        'packages/a/tsconfig.base.json',
      ]) {
        const toolchain = await detect({
          'package.json': json(typescriptDev),
          'pnpm-lock.yaml': '',
          'tsconfig.json': json({ files: [], references: [{ path }] }),
          'packages/a/tsconfig.json': tsconfig,
        });
        expect(toolchain.typecheck, path).toEqual(
          unsupported('tsconfig.json references a project outside the tree or not in it'),
        );
      }
      const pathless = await detect({
        'package.json': json(typescriptDev),
        'pnpm-lock.yaml': '',
        'tsconfig.json': json({ files: [], references: [{ prepend: true }] }),
      });
      expect(pathless.typecheck).toEqual(
        unsupported('tsconfig.json has a reference without a path'),
      );
    });

    it('stops a reference chain past its depth', async () => {
      const files: Record<string, string> = {
        'package.json': json(typescriptDev),
        'pnpm-lock.yaml': '',
        'tsconfig.json': json({ files: [], references: [{ path: 'd1' }] }),
      };
      let at = '';
      for (let depth = 1; depth <= 9; depth += 1) {
        at = at === '' ? `d${String(depth)}` : `${at}/d${String(depth)}`;
        files[`${at}/tsconfig.json`] = json({
          files: [],
          references: [{ path: `d${String(depth + 1)}` }],
        });
      }
      files[`${at}/d10/tsconfig.json`] = tsconfig;
      expect((await detect(files)).typecheck).toEqual(
        unsupported('project references nest deeper than 8'),
      );
    });

    it('takes the workspace packages’ tsconfigs when there is no root tsconfig — pnpm', async () => {
      const toolchain = await detect({
        'package.json': json({ private: true }),
        'pnpm-lock.yaml': '',
        'pnpm-workspace.yaml': [
          'packages:',
          "  - 'packages/*'",
          '  - apps/**  # nested apps',
          '  - "!packages/skipped"',
          'catalog:',
          '  - not/a/workspace',
        ].join('\n'),
        'packages/a/package.json': json({ name: 'a' }),
        'packages/a/tsconfig.json': tsconfig,
        'packages/b/package.json': json({ name: 'b', ...typescriptDev }),
        'packages/b/tsconfig.json': tsconfig,
        'packages/no-ts/package.json': json({ name: 'no-ts' }),
        'packages/skipped/package.json': json({ name: 'skipped' }),
        'packages/skipped/tsconfig.json': tsconfig,
        'apps/web/site/package.json': json({ name: 'site' }),
        'apps/web/site/tsconfig.json': tsconfig,
        'apps/web/site/node_modules/dep/package.json': json({ name: 'dep' }),
        'apps/web/site/node_modules/dep/tsconfig.json': tsconfig,
        'not/a/workspace/package.json': json({ name: 'nope' }),
        'not/a/workspace/tsconfig.json': tsconfig,
      });
      expect(toolchain.typecheck).toEqual({
        status: 'supported',
        origin: 'detected',
        runner: 'language-service',
        projects: [
          'apps/web/site/tsconfig.json',
          'packages/a/tsconfig.json',
          'packages/b/tsconfig.json',
        ],
      });
    });

    it('takes the workspace packages’ tsconfigs from the workspaces field — npm and Yarn', async () => {
      const npm = await detect({
        'package.json': json({ workspaces: ['libs/*'], ...typescriptDev }),
        'package-lock.json': '{}',
        'libs/x/package.json': '{}',
        'libs/x/tsconfig.json': tsconfig,
        // pnpm's file is not npm's: a package only it names is not a project here.
        'pnpm-workspace.yaml': 'packages:\n  - other/*\n',
        'other/y/package.json': '{}',
        'other/y/tsconfig.json': tsconfig,
      });
      expect(npm.typecheck).toMatchObject({ projects: ['libs/x/tsconfig.json'] });

      const yarn = await detect({
        'package.json': json({ workspaces: { packages: ['libs/*'] }, ...typescriptDev }),
        'yarn.lock': '# yarn lockfile v1\n',
        'libs/x/package.json': '{}',
        'libs/x/tsconfig.json': tsconfig,
      });
      expect(yarn.typecheck).toMatchObject({ projects: ['libs/x/tsconfig.json'] });
    });

    it('refuses a workspace tsconfig that is a symlink, since the service would follow it', async () => {
      const toolchain = await detect({
        'package.json': json({ workspaces: ['libs/*'], ...typescriptDev }),
        'package-lock.json': '{}',
        'libs/x/package.json': '{}',
        'libs/x/tsconfig.json': { link: '/etc/passwd' },
      });
      expect(toolchain.typecheck).toEqual(unsupported('a workspace tsconfig.json is a symlink'));
    });

    it('refuses a workspaces field or a pnpm list it cannot read in full', async () => {
      const field = await detect({
        'package.json': json({ workspaces: [1] }),
        'package-lock.json': '{}',
      });
      expect(field.typecheck).toEqual(
        unsupported('package.json workspaces is not a list of patterns'),
      );
      const yaml = await detect({
        'package.json': '{}',
        'pnpm-lock.yaml': '',
        'pnpm-workspace.yaml': 'packages: &anchor\n  - a/*\n',
      });
      expect(yaml.typecheck).toEqual(
        unsupported('pnpm-workspace.yaml has a packages list in a form this reader does not parse'),
      );
    });

    it('detects this repository’s own projects', async () => {
      const root = realpathSync(join(import.meta.dirname, '..', '..', '..'));
      // Read off disk and committed into the fixture: the checkout itself is
      // never asked anything by git, so its state cannot leak into the test.
      const files: Record<string, string> = {};
      for (const name of [
        'package.json',
        'pnpm-workspace.yaml',
        'pnpm-lock.yaml',
        'tsconfig.json',
        'tsconfig.base.json',
      ]) {
        files[name] = readFileSync(join(root, name), 'utf8');
      }
      for (const pkg of readdirSync(join(root, 'packages'))) {
        for (const name of ['package.json', 'tsconfig.json']) {
          const path = join(root, 'packages', pkg, name);
          if (existsSync(path)) files[`packages/${pkg}/${name}`] = readFileSync(path, 'utf8');
        }
      }
      const pinned = (JSON.parse(files['package.json']!) as { packageManager: string })
        .packageManager;

      const toolchain = await detect(files);
      expect(toolchain).toEqual({
        packageManager: {
          status: 'supported',
          name: 'pnpm',
          version: pinned.slice('pnpm@'.length),
          from: 'packageManager',
        },
        install: {
          status: 'supported',
          origin: 'detected',
          argv: ['pnpm', 'install', '--frozen-lockfile'],
        },
        typecheck: {
          status: 'supported',
          origin: 'detected',
          runner: 'language-service',
          projects: [
            'packages/cli/tsconfig.json',
            'packages/core/tsconfig.json',
            'packages/daemon/tsconfig.json',
            'packages/mcp-server/tsconfig.json',
            'packages/shared/tsconfig.json',
          ],
        },
        build: { status: 'supported', origin: 'detected', argv: ['pnpm', 'run', 'build'] },
      });
    });
  });

  describe('the override', () => {
    it('replaces only the commands it sets, and says where each answer came from', async () => {
      const toolchain = await detect(
        {
          'package.json': json({ scripts: { build: 'tsc' }, ...typescriptDev }),
          'pnpm-lock.yaml': '',
          'tsconfig.json': tsconfig,
        },
        { override: { build: 'make dist && echo "$HOME"; rm -rf /' } },
      );
      expect(toolchain.build).toEqual({
        status: 'supported',
        origin: 'override',
        command: 'make dist && echo "$HOME"; rm -rf /',
      });
      expect(toolchain.install).toMatchObject({ origin: 'detected' });
      expect(toolchain.typecheck).toMatchObject({ origin: 'detected', runner: 'language-service' });
    });

    it('carries a typecheck override as a command, apart from the in-process service', async () => {
      const toolchain = await detect(
        { 'package.json': json({ packageManager: 'bun@1.1.0' }) },
        { override: { typecheck: 'bunx tsc --noEmit', install: 'bun install' } },
      );
      expect(toolchain.typecheck).toEqual({
        status: 'supported',
        origin: 'override',
        runner: 'command',
        command: 'bunx tsc --noEmit',
      });
      expect(toolchain.install).toEqual({
        status: 'supported',
        origin: 'override',
        command: 'bun install',
      });
      // What it does not set stays as detection left it, refused included.
      expect(toolchain.build).toEqual(unsupported('packageManager names Bun'));
      expect(toolchain.packageManager).toEqual(unsupported('packageManager names Bun'));
    });
  });

  describe('untrusted input', () => {
    it('refuses an oversized package.json without reading it', async () => {
      const reads: string[] = [];
      const spying: GitRunner = {
        run: (repo, args, options) => {
          reads.push(subcommandOf(args) ?? '');
          return runner.run(repo, args, options);
        },
      };
      const padding = ' '.repeat(MAX_TOOLCHAIN_FILE_BYTES);
      const toolchain = await detect(
        { 'package.json': `{${padding}}`, 'pnpm-lock.yaml': '' },
        { runner: spying },
      );
      allUnsupported(toolchain, /^package.json is larger than 262144 bytes$/u);
      expect(reads).not.toContain('cat-file');
    });

    it('reads a package.json at exactly the ceiling', async () => {
      const body = json({ packageManager: 'npm@10.0.0' });
      const padded = body + ' '.repeat(MAX_TOOLCHAIN_FILE_BYTES - body.length);
      const toolchain = await detect({ 'package.json': padded });
      expect(toolchain.packageManager).toMatchObject({ status: 'supported', name: 'npm' });
    });

    it('refuses malformed JSON and a non-object, and accepts a byte-order mark', async () => {
      allUnsupported(
        await detect({ 'package.json': '{"name": "x",}' }),
        /^package.json is not valid JSON$/u,
      );
      allUnsupported(
        await detect({ 'package.json': '[]' }),
        /^package.json is not a JSON object$/u,
      );
      const bom = await detect({
        'package.json': `\uFEFF${json({ packageManager: 'npm@10.0.0' })}`,
      });
      expect(bom.packageManager).toMatchObject({ status: 'supported', name: 'npm' });
    });

    it('reads only own keys, so __proto__ cannot smuggle one in', async () => {
      const toolchain = await detect({
        'package.json': [
          '{',
          '  "__proto__": { "packageManager": "npm@10.0.0", "devDependencies": { "typescript": "5" } },',
          '  "scripts": { "__proto__": { "build": "x" } },',
          '  "devDependencies": { "__proto__": { "typescript": "5" } }',
          '}',
        ].join('\n'),
        'pnpm-lock.yaml': '',
        'tsconfig.json': '{ "__proto__": { "files": [], "references": [{ "path": "x" }] } }',
      });
      expect(toolchain.packageManager).toMatchObject({ name: 'pnpm', from: 'lockfile' });
      expect(toolchain.build).toEqual({ status: 'none' });
      expect(toolchain.typecheck).toEqual(
        unsupported('typescript is not a dependency of the root or of any workspace package'),
      );
      expect(({} as Record<string, unknown>).packageManager).toBeUndefined();
    });

    it('reads JSONC in tsconfig.json, and refuses it where it is not JSONC', async () => {
      const toolchain = await detect({
        'package.json': json(typescriptDev),
        'pnpm-lock.yaml': '',
        'tsconfig.json': [
          '// leading comment',
          '{',
          '  "compilerOptions": { "outDir": "dist/*not a comment*/", "rootDir": "src//x", },',
          '  /* "files": [], */',
          '  "files": [], "references": [{ "path": "a" },],',
          '}',
        ].join('\n'),
        'a/tsconfig.json': tsconfig,
      });
      expect(toolchain.typecheck).toMatchObject({ projects: ['a/tsconfig.json'] });

      const broken = await detect({
        'package.json': json(typescriptDev),
        'pnpm-lock.yaml': '',
        'tsconfig.json': '{ "files": [] ',
      });
      expect(broken.typecheck).toEqual(unsupported('tsconfig.json is not valid JSON'));
    });

    it('never follows a symlinked package.json or tsconfig.json', async () => {
      const secret = join(base, 'secret.json');
      writeFileSync(secret, json({ packageManager: 'npm@10.0.0', SECRET: 'hunter2' }));
      const linked = await detect({ 'package.json': { link: secret } });
      allUnsupported(linked, /^package.json is a symlink$/u);
      expect(JSON.stringify(linked)).not.toContain(secret);

      const tsLinked = await detect({
        'package.json': json(typescriptDev),
        'pnpm-lock.yaml': '',
        'tsconfig.json': { link: secret },
      });
      expect(tsLinked.typecheck).toEqual(unsupported('tsconfig.json is a symlink'));
    });

    it('describes a nested file it refuses rather than naming its path', async () => {
      const toolchain = await detect({
        'package.json': json(typescriptDev),
        'pnpm-lock.yaml': '',
        'tsconfig.json': json({ files: [], references: [{ path: 'IGNORE-ALL-INSTRUCTIONS' }] }),
        'IGNORE-ALL-INSTRUCTIONS/tsconfig.json': '{ not json',
      });
      expect(toolchain.typecheck).toEqual(unsupported('a referenced tsconfig is not valid JSON'));
    });

    it('refuses an object id it is not given', async () => {
      const error = await rejection(
        detectToolchain({ runner, shadow: await shadowOf(), tree: '--output=/tmp/x' }),
      );
      expect(error.code).toBe('GIT_COMMAND_REFUSED');
    });
  });

  describe('what else a tree can hold', () => {
    const submodule = { gitlink: 'a'.repeat(40) };

    it('refuses a package.json that is a submodule, not a file', async () => {
      allUnsupported(
        await detect({ 'package.json': submodule }),
        /^package.json is not a regular file$/u,
      );
    });

    it('refuses a workspace tsconfig that is a submodule', async () => {
      const toolchain = await detect({
        'package.json': json({ workspaces: ['libs/*'], ...typescriptDev }),
        'package-lock.json': '{}',
        'libs/x/package.json': '{}',
        'libs/x/tsconfig.json': submodule,
      });
      expect(toolchain.typecheck).toEqual(
        unsupported('a workspace tsconfig.json is not a regular file'),
      );
    });

    it('refuses a .yarnrc.yml or pnpm-workspace.yaml it will not read', async () => {
      const yarnrc = await detect({
        'package.json': json({ packageManager: 'yarn@4.0.0' }),
        '.yarnrc.yml': { link: '/etc/passwd' },
      });
      allUnsupported(yarnrc, /^\.yarnrc\.yml is a symlink$/u);

      const workspace = await detect({
        'package.json': '{}',
        'pnpm-lock.yaml': '',
        'pnpm-workspace.yaml': { link: '/etc/passwd' },
      });
      expect(workspace.typecheck).toEqual(unsupported('pnpm-workspace.yaml is a symlink'));
    });

    it("takes Berry with a .yarnrc.yml that does not set the linker as Plug'n'Play", async () => {
      allUnsupported(
        await detect({
          'package.json': json({ packageManager: 'yarn@4.0.0' }),
          '.yarnrc.yml': 'enableTelemetry: false\n  nodeLinker: node-modules\n',
        }),
        /^Yarn Berry links with Plug'n'Play unless/u,
      );
    });

    it('reads workspace manifests for typescript, and refuses one it cannot parse', async () => {
      const files: Files = {
        'package.json': json({ workspaces: ['libs/*', 'tools/*'] }),
        'package-lock.json': '{}',
        'tsconfig.json': tsconfig,
        'libs/a/package.json': json({ name: 'a' }),
        'tools/b/package.json': json({ name: 'b', dependencies: { typescript: '5' } }),
      };
      expect((await detect(files)).typecheck).toMatchObject({ projects: ['tsconfig.json'] });
      const broken = await detect({ ...files, 'libs/a/package.json': '{' });
      expect(broken.typecheck).toEqual(unsupported('a workspace package.json is not valid JSON'));
    });

    it('refuses workspace patterns past their ceilings, only when they are needed', async () => {
      const many = Array.from({ length: 257 }, (_, index) => `p${String(index)}/*`);
      const needed = await detect({
        'package.json': json({ workspaces: many }),
        'package-lock.json': '{}',
        'tsconfig.json': tsconfig,
      });
      expect(needed.typecheck).toEqual(unsupported('more than 256 workspace patterns'));

      const long = await detect({
        'package.json': json({ workspaces: ['x'.repeat(201)], ...typescriptDev }),
        'package-lock.json': '{}',
      });
      expect(long.typecheck).toEqual(
        unsupported('a workspace pattern is longer than 200 characters'),
      );

      const unneeded = await detect({
        'package.json': json({ workspaces: many, ...typescriptDev }),
        'package-lock.json': '{}',
        'tsconfig.json': tsconfig,
      });
      expect(unneeded.typecheck).toMatchObject({ status: 'supported' });
    });

    it('reads Yarn’s workspaces object without a packages list as no patterns', async () => {
      const toolchain = await detect({
        'package.json': json({ workspaces: { nohoist: ['**'] }, ...typescriptDev }),
        'yarn.lock': '',
      });
      expect(toolchain.typecheck).toEqual(
        unsupported('no tsconfig.json at the root or in any workspace package'),
      );
    });

    it('refuses a reference that is not an object', async () => {
      const toolchain = await detect({
        'package.json': json(typescriptDev),
        'pnpm-lock.yaml': '',
        'tsconfig.json': json({ files: [], references: ['packages/a'] }),
      });
      expect(toolchain.typecheck).toEqual(
        unsupported('tsconfig.json has a reference without a path'),
      );
    });

    it('raises rather than answering when git cannot search the lockfile', async () => {
      // The subprocess is the boundary: a grep that dies is not one that found nothing.
      const failing: GitRunner = {
        run: async (repo, args, options) => {
          const result = await runner.run(repo, args, options);
          return subcommandOf(args) === 'grep' ? { ...result, exitCode: 128 } : result;
        },
      };
      const error = await rejection(
        detect({ 'package.json': '{}', 'yarn.lock': '' }, { runner: failing }),
      );
      expect(error.code).toBe('GIT_COMMAND_FAILED');
      expect(error.infra).toBe(true);
    });
  });

  describe('the cache', () => {
    const counting = (): { runner: GitRunner; calls: string[] } => {
      const calls: string[] = [];
      return {
        calls,
        runner: {
          run: (repo, args, options) => {
            calls.push(subcommandOf(args) ?? '');
            return runner.run(repo, args, options);
          },
        },
      };
    };

    const project: Files = {
      'package.json': json({ scripts: { build: 'tsc' }, ...typescriptDev }),
      'yarn.lock': '# yarn lockfile v1\n',
      'tsconfig.json': json({ files: [], references: [{ path: 'lib/tsconfig.lib.json' }] }),
      'lib/tsconfig.lib.json': tsconfig,
      'src/index.ts': 'export const a = 1;\n',
    };

    it('answers an unchanged tree with one ls-tree and no reads', async () => {
      const cache = new ToolchainCache();
      const first = counting();
      const before = await detect(project, { cache, runner: first.runner });
      expect(first.calls.filter((verb) => verb === 'cat-file').length).toBeGreaterThan(0);

      const second = counting();
      const after = await detect(
        { ...project, 'src/index.ts': 'export const a = 2;\n' },
        { cache, runner: second.runner },
      );
      expect(second.calls).toEqual(['ls-tree']);
      expect(after).toBe(before);
    });

    it('detects again when a file it read changes, under any name', async () => {
      const cache = new ToolchainCache();
      await detect(project, { cache });
      const changed = counting();
      await detect(
        { ...project, 'lib/tsconfig.lib.json': '{ broken' },
        { cache, runner: changed.runner },
      );
      expect(changed.calls).toContain('cat-file');

      // A file named by a reference under a name outside the keyed set.
      const odd: Files = {
        ...project,
        'tsconfig.json': json({ files: [], references: [{ path: 'lib/base.json' }] }),
        'lib/base.json': tsconfig,
      };
      const seeded = await detect(odd, { cache });
      expect(seeded.typecheck).toMatchObject({ projects: ['lib/base.json'] });
      const edited = await detect({ ...odd, 'lib/base.json': '{ broken' }, { cache });
      expect(edited.typecheck).toEqual(unsupported('a referenced tsconfig is not valid JSON'));
    });

    it('detects again when a lockfile appears, or the override changes', async () => {
      const cache = new ToolchainCache();
      await detect(project, { cache });
      const twoLockfiles = await detect({ ...project, 'package-lock.json': '{}' }, { cache });
      expect(twoLockfiles.packageManager).toMatchObject({ status: 'unsupported' });
      const overridden = await detect(project, { cache, override: { build: 'make' } });
      expect(overridden.build).toEqual({
        status: 'supported',
        origin: 'override',
        command: 'make',
      });
    });

    it('keeps only as many answers as it was given room for', async () => {
      const cache = new ToolchainCache(1);
      await detect(project, { cache });
      await detect({ ...project, 'package-lock.json': '{}' }, { cache });
      expect(cache.size).toBe(1);
      const again = counting();
      await detect(project, { cache, runner: again.runner });
      expect(again.calls).toContain('cat-file');
    });
  });
});
