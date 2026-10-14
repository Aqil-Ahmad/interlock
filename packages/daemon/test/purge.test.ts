import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGitRunner,
  createWorktreePool,
  ensureShadow,
  speculativeMerge,
} from '@interlock/core';
import type { UserRepo } from '@interlock/core';
import { configPath, createLogger, makePairKey, resolveConfig, ulid } from '@interlock/shared';
import type { BranchRefId, RepoId } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureState, describeDiff, diffState } from '../../core/test/support/repo-state.js';
import { createDaemon } from '../src/daemon.js';
import type { Daemon } from '../src/daemon.js';
import { DATA_DIR_LOCK_FILENAME, holdDataDir } from '../src/data-dir.js';
import { inspectPurge, purgeDataDir } from '../src/purge.js';
import type { PurgeOptions } from '../src/purge.js';
import { rejection } from './support/rejection.js';

/**
 * The kill switch, against real directories, a real daemon's leavings, a real
 * shadow and a real pool slot.
 *
 * Every refusal is tested before any deletion is, and every refusal test
 * plants the one thing the purge is told to look for — the lock file — in a
 * directory under the suite's own temp dir, so a refusal that failed would
 * delete something the suite made and nothing else. The home directory the
 * purge is given is the suite's too.
 */

const silent = createLogger('test', { level: 'error', sink: () => undefined });

describe('purge', () => {
  let base: string;
  let home: string;
  let dataDir: string;
  let root: string;
  let daemons: Daemon[];

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  const options = (overrides: Partial<PurgeOptions> = {}): PurgeOptions => ({
    repos: () => [root],
    home,
    logger: silent,
    ...overrides,
  });

  /** A directory with what a daemon writes at its first start, and nothing else. */
  const plant = (dir: string): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, DATA_DIR_LOCK_FILENAME), '');
  };

  const daemonFor = (dir: string): Daemon => {
    const daemon = createDaemon({
      config: resolveConfig({ dataDir: dir, repos: [root], daemon: { port: 0 } }),
      logger: silent,
      sweepIntervalMs: 200,
    });
    daemons.push(daemon);
    return daemon;
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-purge-')));
    home = join(base, 'home');
    mkdirSync(home);
    dataDir = join(base, 'data');
    root = join(base, 'repo');
    daemons = [];
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', root], { stdio: 'pipe' });
    git(root, 'config', 'user.name', 'Interlock Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'maintenance.auto', 'false');
    git(root, 'config', 'gc.auto', '0');
    writeFileSync(join(root, 'a.txt'), 'a\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'one');
  });

  afterEach(async () => {
    for (const daemon of daemons) await daemon.stop();
    rmSync(base, { recursive: true, force: true });
  });

  describe('refuses before it deletes anything', () => {
    it('refuses a relative path', async () => {
      const error = await rejection(inspectPurge('data', options()));
      expect(error.code).toBe('PURGE_REFUSED');
    });

    it('refuses the root, under any name', async () => {
      // Inspected, never purged: the refusal is the property, and the suite
      // does not bet a machine on it.
      for (const path of ['/', join(base, '..', '..', '..', '..', '..', '..', '..', '..')]) {
        // The suite's own home, so only the root check stands between.
        const error = await rejection(inspectPurge(path, options()));
        expect(error.code).toBe('PURGE_REFUSED');
        expect(error.message).toContain('root');
      }
    });

    it('refuses the home directory and anything above it, though it looks like a data dir', async () => {
      plant(home);
      for (const path of [home, base]) {
        plant(path);
        const error = await rejection(purgeDataDir(path, options()));
        expect(error.code).toBe('PURGE_REFUSED');
        expect(error.message).toContain('home');
      }
      expect(existsSync(join(home, DATA_DIR_LOCK_FILENAME))).toBe(true);
    });

    it('refuses the home directory reached through a symlinked parent', async () => {
      plant(home);
      const alias = join(base, 'alias');
      symlinkSync(base, alias);
      const error = await rejection(purgeDataDir(join(alias, 'home'), options()));
      expect(error.code).toBe('PURGE_REFUSED');
      expect(existsSync(join(home, DATA_DIR_LOCK_FILENAME))).toBe(true);
    });

    it('refuses a directory no daemon has started in', async () => {
      mkdirSync(dataDir);
      writeFileSync(join(dataDir, 'token'), 'x\n');
      const error = await rejection(purgeDataDir(dataDir, options()));
      expect(error.code).toBe('PURGE_REFUSED');
      expect(error.remedy).toContain(DATA_DIR_LOCK_FILENAME);
      expect(existsSync(join(dataDir, 'token'))).toBe(true);
    });

    it('refuses a lock that is not a file', async () => {
      mkdirSync(join(dataDir, DATA_DIR_LOCK_FILENAME), { recursive: true });
      expect((await rejection(purgeDataDir(dataDir, options()))).code).toBe('PURGE_REFUSED');
      expect(existsSync(join(dataDir, DATA_DIR_LOCK_FILENAME))).toBe(true);
    });

    it('refuses a directory holding anything Interlock did not write, and names it', async () => {
      plant(dataDir);
      writeFileSync(join(dataDir, 'thesis.tex'), 'years of work\n');
      const error = await rejection(purgeDataDir(dataDir, options()));
      expect(error.code).toBe('PURGE_REFUSED');
      expect(error.remedy).toContain('thesis.tex');
      expect(readFileSync(join(dataDir, 'thesis.tex'), 'utf8')).toBe('years of work\n');
      expect(existsSync(join(dataDir, DATA_DIR_LOCK_FILENAME))).toBe(true);
    });

    it('refuses a known directory name that is a file or a link', async () => {
      plant(dataDir);
      writeFileSync(join(dataDir, 'shadows'), '');
      expect((await rejection(purgeDataDir(dataDir, options()))).code).toBe('PURGE_REFUSED');
      rmSync(join(dataDir, 'shadows'));
      symlinkSync(root, join(dataDir, 'worktrees'));
      expect((await rejection(purgeDataDir(dataDir, options()))).code).toBe('PURGE_REFUSED');
      expect(existsSync(join(root, 'a.txt'))).toBe(true);
    });

    it('refuses a data dir that is itself a symlink, and leaves both ends', async () => {
      plant(dataDir);
      const link = join(base, 'link');
      symlinkSync(dataDir, link);
      const error = await rejection(purgeDataDir(link, options()));
      expect(error.code).toBe('PURGE_REFUSED');
      // Refused as a link, not merely as something that is not a directory.
      expect(error.message).toContain('symbolic link');
      expect(existsSync(join(dataDir, DATA_DIR_LOCK_FILENAME))).toBe(true);
    });

    it('refuses a path that is a file', async () => {
      writeFileSync(dataDir, 'not a directory\n');
      expect((await rejection(purgeDataDir(dataDir, options()))).code).toBe('PURGE_REFUSED');
      expect(existsSync(dataDir)).toBe(true);
    });

    it('refuses a data dir inside a watched repository, and leaves the repository as it was', async () => {
      const inside = join(root, '.interlock');
      plant(inside);
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'a data dir someone committed');
      const before = captureState(root);
      const error = await rejection(purgeDataDir(inside, options()));
      expect(error.code).toBe('PURGE_REFUSED');
      expect(error.message).toContain('inside a watched repository');
      const diff = diffState(before, captureState(root));
      expect(diff, describeDiff(diff, before, captureState(root))).toStrictEqual({
        changed: [],
        removed: [],
        added: [],
      });
    });

    it('refuses when the watched repositories cannot be read', async () => {
      plant(dataDir);
      const error = await rejection(
        purgeDataDir(
          dataDir,
          options({
            repos: () => {
              throw new Error('config unreadable');
            },
          }),
        ),
      );
      expect(error.code).toBe('PURGE_REFUSED');
      expect(error.remedy).toContain('config.json');
      expect(existsSync(join(dataDir, DATA_DIR_LOCK_FILENAME))).toBe(true);
    });

    // Mounting needs root on Linux, which CI does not run as; elsewhere the
    // test says why it did not run rather than passing for nothing.
    const canMount = process.platform === 'linux' && process.getuid?.() === 0;
    (canMount ? it : it.skip)(
      canMount
        ? 'refuses a file system mounted inside the data dir, deleting nothing on it'
        : 'refuses a file system mounted inside the data dir (skipped: mounting needs root on Linux)',
      async () => {
        plant(dataDir);
        const mounted = join(dataDir, 'shadows');
        mkdirSync(mounted);
        execFileSync('mount', ['-t', 'tmpfs', 'tmpfs', mounted]);
        try {
          writeFileSync(join(mounted, 'theirs'), 'on another device\n');
          const error = await rejection(purgeDataDir(dataDir, options()));
          expect(error.code).toBe('PURGE_REFUSED');
          expect(error.message).toContain('mounted');
          expect(readFileSync(join(mounted, 'theirs'), 'utf8')).toBe('on another device\n');
          expect(existsSync(join(dataDir, DATA_DIR_LOCK_FILENAME))).toBe(true);
        } finally {
          execFileSync('umount', [mounted]);
        }
      },
    );

    it('refuses while a daemon holds the directory', async () => {
      plant(dataDir);
      const hold = holdDataDir(dataDir, silent);
      try {
        const error = await rejection(purgeDataDir(dataDir, options()));
        expect(error.code).toBe('CONFIG_INVALID');
        expect(error.message).toContain('Another daemon');
        expect(existsSync(join(dataDir, DATA_DIR_LOCK_FILENAME))).toBe(true);
      } finally {
        hold.release();
      }
    });
  });

  describe('deletes', () => {
    it('answers a directory that is not there as nothing to do', async () => {
      expect(await purgeDataDir(dataDir, options())).toStrictEqual({
        dataDir,
        existed: false,
        bytes: 0,
      });
    });

    it('everything a daemon, a shadow and a pool slot left, and nothing of the repository they read', async () => {
      git(root, 'checkout', '-q', '-b', 'feature');
      writeFileSync(join(root, 'b.txt'), 'b\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'two');
      git(root, 'checkout', '-q', 'main');

      const daemon = daemonFor(dataDir);
      await daemon.start();
      await daemon.stop();

      // A pool slot: a linked worktree of the shadow, whose `.git` names the
      // shadow's git dir and whose shadow borrows the repository's objects.
      const runner = createGitRunner();
      const repoId = ulid<RepoId>();
      const repo: UserRepo = { kind: 'user', rootPath: root, gitDir: join(root, '.git') };
      const shadow = await ensureShadow(repo, { runner, dataDir, repoId });
      const commitA = git(root, 'rev-parse', 'main').trim();
      const commitB = git(root, 'rev-parse', 'feature').trim();
      const merged = await speculativeMerge(
        { shadow, commitA, commitB, mergeBaseSha: commitA },
        { runner },
      );
      const pool = createWorktreePool(shadow, { runner, dataDir, repoId });
      const slot = await pool.withSlot(
        {
          key: makePairKey(ulid<BranchRefId>(), ulid<BranchRefId>()),
          commitA,
          commitB,
          merged,
          dependencyTreeOid: git(root, 'rev-parse', 'main^{tree}').trim(),
        },
        (held) => Promise.resolve(held.path),
      );
      expect(slot.kind).toBe('ran');
      // And links planted where a careless walk would follow them out.
      symlinkSync(root, join(dataDir, 'shadows', 'into-the-repository'));
      symlinkSync(join(root, 'a.txt'), join(dataDir, 'worktrees', 'a-file-of-theirs'));
      writeFileSync(configPath(dataDir), JSON.stringify({ repos: [root] }));

      const before = captureState(root);
      const inspected = await inspectPurge(dataDir, options());
      const report = await purgeDataDir(dataDir, options());

      expect(existsSync(dataDir)).toBe(false);
      expect(report.dataDir).toBe(dataDir);
      expect(report.existed).toBe(true);
      expect(report.bytes).toBeGreaterThan(0);
      // The measurement the question showed is the deletion's own account.
      expect(report.bytes).toBe(inspected.bytes);
      const after = captureState(root);
      const diff = diffState(before, after);
      expect(diff, describeDiff(diff, before, after)).toStrictEqual({
        changed: [],
        removed: [],
        added: [],
      });
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a\n');
      expect(git(root, 'status', '--porcelain')).toBe('');
    });

    it('through Daemon.purge, after which a daemon starts from nothing', async () => {
      const daemon = daemonFor(dataDir);
      await daemon.start();
      const report = await daemon.purge();
      expect(report.existed).toBe(true);
      expect(daemon.runtime).toBeNull();
      expect(existsSync(dataDir)).toBe(false);

      const next = daemonFor(dataDir);
      await next.start();
      expect(next.runtime?.port).toBeGreaterThan(0);
      expect(existsSync(join(dataDir, DATA_DIR_LOCK_FILENAME))).toBe(true);
    });

    it('the staging files a crash leaves', async () => {
      plant(dataDir);
      writeFileSync(join(dataDir, 'daemon.json.123.tmp'), '{}');
      writeFileSync(join(dataDir, 'token.0a1b2c.tmp'), 'x');
      writeFileSync(join(dataDir, 'daemon.log.1'), '');
      await purgeDataDir(dataDir, options());
      expect(existsSync(dataDir)).toBe(false);
    });
  });
});
