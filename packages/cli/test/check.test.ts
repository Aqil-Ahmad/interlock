import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '@interlock/daemon';
import type { Daemon } from '@interlock/daemon';
import { createLogger, resolveConfig } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../src/commands/check.js';
import type { CheckIo } from '../src/commands/check.js';

/**
 * `interlock check` against a real daemon on a temp data dir, real worktrees
 * and the real merge: a planted conflict, its twin, and every way the command
 * can be wrong about which pair it was asked for.
 *
 * The daemon is started with a watch that never reports and a sweep that
 * never comes round, and every edit is made after it started. Nothing but the
 * check's own pass can have seen them, which is the property under test: a
 * check judges what is on disk when it is asked, not what was last noticed.
 */
describe('interlock check', () => {
  let base: string;
  let dataDir: string;
  let root: string;
  let daemon: Daemon | null;
  let out: string[];
  let err: string[];
  let io: CheckIo;

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  const config = (lines: Record<number, string> = {}): string =>
    [
      'export const retries = 3;',
      'export const backoffMs = 100;',
      'export const jitter = true;',
      'export const logLevel = "info";',
      'export const timeoutMs = 5000;',
    ]
      .map((line, index) => lines[index + 1] ?? line)
      .join('\n') + '\n';

  /** A watch accepted by the kernel that never reports. */
  const silent = (): FSWatcher =>
    Object.assign(new EventEmitter(), {
      close: (): void => undefined,
      ref() {
        return this;
      },
      unref() {
        return this;
      },
    }) as unknown as FSWatcher;

  const start = async (): Promise<void> => {
    daemon = createDaemon({
      config: resolveConfig({ dataDir, repos: [root], daemon: { port: 0 } }),
      logger: createLogger('test', { level: 'error', sink: () => undefined }),
      sweepIntervalMs: 60 * 60_000,
      watchFactory: silent,
    });
    await daemon.start();
  };

  const check = async (...args: string[]): Promise<number> => {
    out = [];
    err = [];
    return runCheck(['--data-dir', dataDir, ...args], {
      ...io,
      out: (t) => out.push(t),
      err: (t) => err.push(t),
    });
  };
  const stdout = (): string => out.join('');
  const stderr = (): string => err.join('');

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-check-')));
    dataDir = join(base, 'data');
    root = join(base, 'repo');
    daemon = null;
    out = [];
    err = [];
    // An empty environment, so a real INTERLOCK_DATA_DIR cannot reach the suite.
    io = { out: () => undefined, err: () => undefined, env: {}, cwd: () => root };

    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
    git(root, 'config', 'user.name', 'Interlock Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'maintenance.auto', 'false');
    git(root, 'config', 'gc.auto', '0');
    writeFileSync(join(root, 'config.ts'), config());
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    for (const name of ['one', 'two', 'three']) {
      git(root, 'worktree', 'add', '-q', '-b', name, join(base, name));
    }
  });

  afterEach(async () => {
    await daemon?.stop();
    rmSync(base, { recursive: true, force: true });
  });

  describe('with the daemon running', () => {
    beforeEach(async () => {
      await start();
      // After the start, uncommitted on one side and committed on the other.
      writeFileSync(join(base, 'one', 'config.ts'), config({ 1: 'export const retries = 4;' }));
      writeFileSync(join(base, 'two', 'config.ts'), config({ 1: 'export const retries = 5;' }));
      git(join(base, 'two'), 'commit', '-qam', 'five retries');
      writeFileSync(
        join(base, 'three', 'config.ts'),
        config({ 5: 'export const timeoutMs = 9000;' }),
      );
    });

    it('prints a planted conflict with each side, and exits 1', async () => {
      const started = Date.now();

      expect(await check('one', 'two')).toBe(1);

      expect(Date.now() - started).toBeLessThan(15_000);
      const text = stdout();
      expect(text).toContain('one and two: 1 conflict');
      expect(text).toContain('overlapping-edit');
      expect(text).toMatch(/ {2}one {2}config\.ts:1\n\s+│ export const retries = 4;/u);
      expect(text).toMatch(/ {2}two {2}config\.ts:1\n\s+│ export const retries = 5;/u);
      expect(stderr()).toBe('');
    });

    it('says so for the twin, and exits 0', async () => {
      expect(await check('one', 'three')).toBe(0);
      expect(stdout()).toMatch(/^one and three merge cleanly {2}\(merge base [0-9a-f]{12}\)\n$/u);
    });

    it('emits the same facts as JSON', async () => {
      expect(await check('two', 'one', '--json')).toBe(1);
      const parsed = JSON.parse(stdout()) as {
        clean: boolean;
        a: { name: string };
        findings: {
          rule: string;
          severity: string;
          sides: {
            branch: string;
            path: string;
            spans: { startLine: number; excerpt: string }[];
          }[];
        }[];
      };
      expect(parsed.clean).toBe(false);
      expect(parsed.a.name).toBe('two');
      expect(parsed.findings).toHaveLength(1);
      expect(parsed.findings[0]!.rule).toBe('overlapping-edit');
      expect(parsed.findings[0]!.sides.map((side) => side.branch)).toEqual(['two', 'one']);
      expect(parsed.findings[0]!.sides[1]!.spans[0]).toMatchObject({
        startLine: 1,
        excerpt: 'export const retries = 4;',
      });
    });

    it('checks one branch against the default branch', async () => {
      expect(await check('three')).toBe(0);
      expect(stdout()).toContain('three and main merge cleanly');
    });

    it('answers from the pair as it stands when nothing has changed since', async () => {
      expect(await check('one', 'two')).toBe(1);
      // The same content again is a duplicate, which merges nothing; the pair
      // still has its conflict, and the answer has to say so.
      expect(await check('one', 'two')).toBe(1);
      expect(stdout()).toContain('1 conflict');
    });

    it('sees an edit that resolves the conflict, made just before it asks', async () => {
      expect(await check('one', 'two')).toBe(1);
      writeFileSync(join(base, 'one', 'config.ts'), config({ 1: 'export const retries = 5;' }));

      expect(await check('one', 'two')).toBe(0);
    });

    it('finds the repository from inside a linked worktree', async () => {
      io = { ...io, cwd: () => join(base, 'one') };
      expect(await check('one', 'three')).toBe(0);
    });

    it('sees a branch created a moment ago', async () => {
      git(root, 'branch', 'fresh', 'main');
      expect(await check('fresh', 'three')).toBe(0);
    });

    it('lists the branches there are for a name that is not one, and exits 64', async () => {
      expect(await check('nope', 'two')).toBe(64);
      expect(stderr()).toContain('BRANCH_NOT_FOUND');
      expect(stderr()).toContain('No branch named nope');
      expect(stderr()).toContain('Branches: main, one, three, two.');
    });

    it('escapes a branch name it echoes', async () => {
      expect(await check('evil\u001b[2J', 'two')).toBe(64);
      expect(stderr()).not.toContain('\u001b');
      expect(stderr()).toContain('evil\\x1b[2J');
    });

    it('refuses two branches with no history in common, and exits 64', async () => {
      git(root, 'checkout', '-q', '--orphan', 'lonely');
      git(root, 'commit', '-q', '--allow-empty', '-m', 'alone');
      git(root, 'checkout', '-q', 'main');

      expect(await check('lonely', 'two')).toBe(64);
      expect(stderr()).toContain('BRANCHES_UNRELATED');
    });

    it('refuses a branch against itself, and exits 64', async () => {
      expect(await check('main')).toBe(64);
      expect(stderr()).toContain('cannot be checked against itself');
    });

    it('refuses a directory in no watched repository, and exits 64', async () => {
      io = { ...io, cwd: () => base };
      expect(await check('one', 'two')).toBe(64);
      expect(stderr()).toContain('in no watched repository');
    });
  });

  describe('with one watched repository inside another', () => {
    it('checks the innermost repository the directory is in', async () => {
      // Its own repository, ignored by the outer one, the way a vendored
      // checkout sits inside a project.
      const inner = join(root, 'vendor');
      execFileSync('git', ['init', '-q', '-b', 'trunk', inner], { stdio: 'pipe' });
      git(inner, 'config', 'user.name', 'Interlock Test');
      git(inner, 'config', 'user.email', 'test@example.invalid');
      writeFileSync(join(inner, 'lib.ts'), 'export const lib = 1;\n');
      git(inner, 'add', '-A');
      git(inner, 'commit', '-qm', 'lib');
      git(inner, 'branch', 'patch');
      writeFileSync(join(root, '.gitignore'), 'vendor/\n');
      daemon = createDaemon({
        config: resolveConfig({ dataDir, repos: [root, inner], daemon: { port: 0 } }),
        logger: createLogger('test', { level: 'error', sink: () => undefined }),
        sweepIntervalMs: 60 * 60_000,
        watchFactory: silent,
      });
      await daemon.start();
      io = { ...io, cwd: () => inner };

      // `patch` and `trunk` exist only in the inner repository.
      expect(await check('patch')).toBe(0);
      expect(stdout()).toContain('patch and trunk merge cleanly');
    });
  });

  describe('without a daemon', () => {
    it('says none is running, and exits 69', async () => {
      expect(await check('one', 'two')).toBe(69);
      expect(stderr()).toContain('No daemon is running');
    });
  });

  describe('its arguments', () => {
    it.each([
      [[], 'Name the branch to check'],
      [['a', 'b', 'c'], 'at most two'],
      [['a', '--timeout', '0'], '--timeout must be'],
      [['a', '--timeout', 'soon'], '--timeout must be'],
      [['a', '--bogus'], 'Unknown option'],
    ])('refuses %j, and exits 64', async (args, message) => {
      expect(await check(...args)).toBe(64);
      expect(stderr()).toContain(message);
    });

    it('prints its usage, and exits 0', async () => {
      expect(await check('--help')).toBe(0);
      expect(stdout()).toContain('Exit codes: 0 clean, 1 conflicts found');
    });
  });
});
