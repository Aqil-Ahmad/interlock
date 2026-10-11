import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '@interlock/daemon';
import type { Daemon } from '@interlock/daemon';
import { createLogger, resolveConfig, ulid } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../src/commands/check.js';
import { runDismiss } from '../src/commands/dismiss.js';
import { runStatus } from '../src/commands/status.js';

/**
 * `interlock dismiss` against a real daemon on a temp data dir: a planted
 * conflict found by `check`, dismissed by the id `check` printed, held to its
 * content, counted in `status`, and every way the command can be refused.
 *
 * The daemon's watch never reports and its sweep never comes round, as in
 * `check`'s tests, so only a check's own pass sees an edit.
 */
describe('interlock dismiss', () => {
  let base: string;
  let dataDir: string;
  let root: string;
  let daemon: Daemon | null;
  let out: string[];
  let err: string[];

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  const config = (first: string, last = 'export const timeoutMs = 5000;'): string =>
    [first, 'export const backoffMs = 100;', 'export const jitter = true;', last].join('\n') + '\n';

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

  const io = () => ({
    out: (text: string) => out.push(text),
    err: (text: string) => err.push(text),
    // Empty, so a real INTERLOCK_DATA_DIR cannot reach the suite.
    env: {},
    cwd: () => root,
  });
  const reset = (): void => {
    out = [];
    err = [];
  };
  const check = (...args: string[]): Promise<number> => {
    reset();
    return runCheck(['--data-dir', dataDir, ...args], io());
  };
  const dismiss = (...args: string[]): Promise<number> => {
    reset();
    return runDismiss(['--data-dir', dataDir, ...args], io());
  };
  const status = (...args: string[]): Promise<number> => {
    reset();
    return runStatus(['--data-dir', dataDir, ...args], io());
  };
  const stdout = (): string => out.join('');
  const stderr = (): string => err.join('');

  /** The ids `check` printed for the pair's open conflicts. */
  const printedIds = (): string[] =>
    [...stdout().matchAll(/^ {2}finding ([0-9A-HJKMNP-TV-Z]{26})$/gmu)].map((match) => match[1]!);

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-dismiss-')));
    dataDir = join(base, 'data');
    root = join(base, 'repo');
    daemon = null;
    reset();

    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
    git(root, 'config', 'user.name', 'Interlock Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'maintenance.auto', 'false');
    git(root, 'config', 'gc.auto', '0');
    writeFileSync(join(root, 'config.ts'), config('export const retries = 3;'));
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    for (const name of ['one', 'two']) {
      git(root, 'worktree', 'add', '-q', '-b', name, join(base, name));
    }
  });

  afterEach(async () => {
    await daemon?.stop();
    rmSync(base, { recursive: true, force: true });
  });

  describe('with the daemon running', () => {
    let id: string;

    beforeEach(async () => {
      await start();
      writeFileSync(join(base, 'one', 'config.ts'), config('export const retries = 4;'));
      writeFileSync(join(base, 'two', 'config.ts'), config('export const retries = 5;'));
      expect(await check('one', 'two')).toBe(1);
      [id] = printedIds() as [string];
      expect(id).toBeDefined();
    });

    it('dismisses by the id check printed, and the conflict stays dismissed', async () => {
      expect(await dismiss(id, '--reason', 'wrong')).toBe(0);
      expect(stdout()).toBe(
        [
          `Dismissed ${id} as wrong: overlapping-edit at config.ts`,
          'It stays dismissed while both sides of config.ts are unchanged.',
          '',
        ].join('\n'),
      );

      // Merged again at the same content: clean as a gate, never "merges cleanly".
      expect(await check('one', 'two')).toBe(0);
      expect(stdout()).toContain('one and two: no open conflicts, 1 dismissed');
      expect(stdout()).toContain(`  overlapping-edit  config.ts  as wrong  finding ${id}`);
      expect(printedIds()).toEqual([]);
    });

    it('raises the conflict again, under a new id, once a side changes', async () => {
      expect(await dismiss(id, '--reason', 'known')).toBe(0);
      writeFileSync(
        join(base, 'two', 'config.ts'),
        config('export const retries = 5;', 'export const timeoutMs = 6000;'),
      );

      expect(await check('one', 'two')).toBe(1);
      const [raised] = printedIds();
      expect(raised).toBeDefined();
      expect(raised).not.toBe(id);
      expect(stdout()).not.toContain('dismissed');
    });

    it('counts the raise and the dismissal in status, with each window stated', async () => {
      expect(await status()).toBe(0);
      expect(stdout()).toMatch(
        /last 24 hours {2}since \d{4}-\d\d-\d\d \d\d:00 UTC {2}1 raised, 0 dismissed as wrong \(0%\), 0 as known\n/u,
      );

      expect(await dismiss(id, '--reason', 'wrong')).toBe(0);
      expect(await status()).toBe(0);
      expect(stdout()).toContain('1 raised, 1 dismissed as wrong (100%), 0 as known');
      expect(stdout()).toMatch(/last 7 days {4}since /u);
      expect(stdout()).toContain('  delivered      not measured\n');
      expect(stdout()).toContain(
        'Most dismissed as wrong, last 7 days:\n    overlapping-edit  1 of 1 (100%)',
      );

      expect(await status('--json')).toBe(0);
      const parsed = JSON.parse(stdout()) as {
        budget: { windows: { hours: number; raised: number; rate: number; delivered: null }[] };
      };
      expect(parsed.budget.windows).toMatchObject([
        { hours: 24, raised: 1, dismissedWrong: 1, rate: 1, delivered: null },
        { hours: 168, raised: 1, dismissedWrong: 1, rate: 1, delivered: null },
      ]);
    });

    it('does not count a dismissal as known as wrong', async () => {
      expect(await dismiss(id, '--reason', 'known')).toBe(0);
      expect(await status()).toBe(0);
      expect(stdout()).toContain('1 raised, 0 dismissed as wrong (0%), 1 as known');
    });

    it('keeps a note, escaped for the terminal and as it is in JSON', async () => {
      expect(await dismiss(id, '--reason', 'wrong', '--note', 'rerere\u001b[2J', '--json')).toBe(0);
      expect(stdout()).not.toContain('\u001b');
      expect(JSON.parse(stdout())).toMatchObject({
        id,
        reason: 'wrong',
        note: 'rerere\u001b[2J',
        path: 'config.ts',
      });
    });

    it('refuses a Finding dismissed already, and exits 64', async () => {
      expect(await dismiss(id, '--reason', 'wrong')).toBe(0);
      expect(await dismiss(id, '--reason', 'known')).toBe(64);
      expect(stderr()).toContain('FINDING_NOT_DISMISSABLE');
      expect(stderr()).toContain('already dismissed');
    });

    it('refuses a Finding already resolved, and exits 64', async () => {
      writeFileSync(join(base, 'one', 'config.ts'), config('export const retries = 5;'));
      expect(await check('one', 'two')).toBe(0);

      expect(await dismiss(id, '--reason', 'wrong')).toBe(64);
      expect(stderr()).toContain('already resolved');
    });

    it('refuses a Finding it has never heard of, and exits 64', async () => {
      expect(await dismiss(ulid(), '--reason', 'wrong')).toBe(64);
      expect(stderr()).toContain('FINDING_NOT_FOUND');
    });

    it('refuses something that is not a Finding id, escaped, and exits 64', async () => {
      expect(await dismiss(id.slice(0, 10), '--reason', 'wrong')).toBe(64);
      expect(stderr()).toContain('not a Finding id');
      expect(await dismiss(`x\u001b[2J`, '--reason', 'wrong')).toBe(64);
      expect(stderr()).not.toContain('\u001b');
    });

    it('refuses a note past its bound, and exits 64', async () => {
      expect(await dismiss(id, '--reason', 'wrong', '--note', 'x'.repeat(501))).toBe(64);
      expect(stderr()).toContain('note is longer than 500 characters');
      expect(await check('one', 'two')).toBe(1);
    });
  });

  describe('without a daemon', () => {
    it('says none is running, and exits 69', async () => {
      expect(await dismiss(ulid(), '--reason', 'wrong')).toBe(69);
      expect(stderr()).toContain('No daemon is running');
    });
  });

  describe('its arguments', () => {
    it.each([
      [[], 'Name the Finding to dismiss'],
      [['a', 'b', '--reason', 'wrong'], 'one Finding at a time'],
      [['a'], 'Say why with --reason: wrong or known'],
      [['a', '--reason', 'meh'], '--reason must be wrong or known, not meh'],
      [['a', '--reason=meh\u001b'], 'not meh\\x1b'],
      [['a', '--reason'], '--reason needs a value'],
      [['a', '--reason', 'wrong', '--note'], '--note needs a value'],
      [['a', '--reason', 'wrong', '--bogus'], 'Unknown option'],
    ])('refuses %j, and exits 64', async (args, message) => {
      expect(await dismiss(...args)).toBe(64);
      expect(stderr()).toContain(message);
      expect(stderr()).not.toContain('\u001b');
    });

    it('takes a note that begins with a dash', async () => {
      // Parsed before the daemon is asked, so no daemon is an exit 69, not 64.
      expect(await dismiss('a', '--reason', 'wrong', '--note', '-1 is fine')).toBe(69);
    });

    it('prints its usage, and exits 0', async () => {
      expect(await dismiss('--help')).toBe(0);
      expect(stdout()).toContain('Usage: interlock dismiss <finding id> --reason <wrong|known>');
      expect(stdout()).toContain('Exit codes: 0 dismissed, 64 bad arguments');
    });
  });
});
