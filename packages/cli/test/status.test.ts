import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '@interlock/daemon';
import type { Daemon } from '@interlock/daemon';
import { createLogger, resolveConfig, runtimePath, tokenPath } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runStatus } from '../src/commands/status.js';
import type { StatusIo } from '../src/commands/status.js';

/**
 * The command against a real daemon, a real listener and real repositories,
 * because everything it is responsible for is a property of the pair: which
 * failure it reports, what it exits with, and whether what the watcher found
 * survives the wire to the screen.
 *
 * A fake HTTP server here would prove the fake answers the way the fake was
 * written.
 */

describe('interlock status', () => {
  let base: string;
  let dataDir: string;
  let root: string;
  let linked: string;
  let daemon: Daemon | null;
  let out: string[];
  let err: string[];
  let io: StatusIo;

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  const start = async (): Promise<void> => {
    daemon = createDaemon({
      config: resolveConfig({ dataDir, repos: [root], daemon: { port: 0 } }),
      logger: createLogger('test', { level: 'error', sink: () => undefined }),
      sweepIntervalMs: 200,
    });
    await daemon.start();
  };

  /** Poll: the first reconciliation is what puts the branches in the store. */
  const until = async (probe: () => Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (!(await probe())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const status = async (...args: string[]): Promise<number> => {
    out = [];
    err = [];
    return runStatus(args, { ...io, out: (t) => out.push(t), err: (t) => err.push(t) });
  };

  const stdout = (): string => out.join('');
  const stderr = (): string => err.join('');

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-status-')));
    dataDir = join(base, 'data');
    root = join(base, 'repo');
    linked = join(base, 'feature');
    daemon = null;
    out = [];
    err = [];
    // An empty environment, so a real INTERLOCK_DATA_DIR cannot reach the suite.
    io = { out: (t) => out.push(t), err: (t) => err.push(t), env: {} };

    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
    git(root, 'config', 'user.name', 'Interlock Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'a.txt'), 'a\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'one');
    git(root, 'worktree', 'add', '-q', '-b', 'feature', linked);
  });

  afterEach(async () => {
    await daemon?.stop();
    rmSync(base, { recursive: true, force: true });
  });

  describe('when it cannot reach a daemon', () => {
    it('says none has started here and names the command that starts one', async () => {
      const code = await status('--data-dir', dataDir);
      expect(code).toBe(69);
      expect(stderr()).toContain('No daemon is running');
      expect(stderr()).toContain('interlockd');
      expect(stdout()).toBe('');
    });

    it('tells a stale runtime file from a daemon that never started', async () => {
      // What a crash leaves behind: the file says where to look and nothing is
      // there. Reported as its own thing, because "no daemon has started here"
      // would be wrong about what happened.
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(runtimePath(dataDir), JSON.stringify({ port: 1, pid: 1 }), { mode: 0o600 });
      writeFileSync(tokenPath(dataDir), 'irrelevant\n', { mode: 0o600 });

      const code = await status('--data-dir', dataDir);
      expect(code).toBe(69);
      expect(stderr()).toContain('Nothing is listening');
      expect(stderr()).toContain('interlockd');
    });

    it('refuses a runtime file it cannot read a port out of', async () => {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(runtimePath(dataDir), 'not json at all\n', { mode: 0o600 });
      expect(await status('--data-dir', dataDir)).toBe(69);
      expect(stderr()).toContain('not valid JSON');

      writeFileSync(runtimePath(dataDir), JSON.stringify({ port: 'http' }), { mode: 0o600 });
      expect(await status('--data-dir', dataDir)).toBe(69);
      expect(stderr()).toContain('no valid port');
    });
  });

  describe('when the daemon is running', () => {
    beforeEach(async () => {
      await start();
      await until(async () => {
        await status('--data-dir', dataDir, '--json');
        const parsed = JSON.parse(stdout()) as { repos: { branches: unknown[] }[] };
        return (parsed.repos[0]?.branches.length ?? 0) >= 2;
      }, 'the daemon to reconcile both worktrees');
    });

    it('reports every branch, its state and the files it touched', async () => {
      writeFileSync(join(linked, 'a.txt'), 'edited\n');
      writeFileSync(join(linked, 'new.txt'), 'added\n');

      await until(async () => {
        await status('--data-dir', dataDir, '--json');
        const parsed = JSON.parse(stdout()) as {
          repos: { branches: { name: string; state: string }[] }[];
        };
        return parsed.repos[0]?.branches.some((b) => b.name === 'feature' && b.state === 'dirty')
          ? true
          : false;
      }, 'the edit to reach the report');

      expect(await status('--data-dir', dataDir)).toBe(0);
      const text = stdout();
      expect(text).toContain(root);
      expect(text).toContain('default main');
      expect(text).toContain('feature');
      expect(text).toContain('dirty');
      expect(text).toContain('a.txt');
      expect(text).toContain('untracked');
      expect(text).toContain('new.txt');
    });

    it('exits 0 with something to report, because it reports rather than gates', async () => {
      expect(await status('--data-dir', dataDir)).toBe(0);
    });

    it('emits the same facts as JSON', async () => {
      expect(await status('--data-dir', dataDir, '--json')).toBe(0);
      const parsed = JSON.parse(stdout()) as {
        repos: { rootPath: string; branches: { name: string; state: string }[] }[];
      };
      expect(parsed.repos).toHaveLength(1);
      expect(parsed.repos[0]?.rootPath).toBe(root);
      expect(parsed.repos[0]?.branches.map((b) => b.name).sort()).toStrictEqual([
        'feature',
        'main',
      ]);
    });

    it('shows an unreadable worktree as unknown rather than clean', async () => {
      // Reversible, unlike deleting it, and git reports the same `prunable` for
      // both — so the work is still there and nobody can look at it.
      chmodSync(linked, 0o000);
      try {
        await until(async () => {
          await status('--data-dir', dataDir, '--json');
          const parsed = JSON.parse(stdout()) as {
            repos: { branches: { name: string; state: string }[] }[];
          };
          return parsed.repos[0]?.branches.some((b) => b.state === 'unknown') ?? false;
        }, 'the unreadable worktree to be reported');

        await status('--data-dir', dataDir);
        const text = stdout();
        expect(text).toContain('unknown');
        expect(text).toContain('worktree could not be read');
      } finally {
        chmodSync(linked, 0o755);
      }
    });

    it('does not tell someone to start a daemon that is already running', async () => {
      // A token the daemon will refuse. The remedy has to be about the token,
      // because starting the daemon is something they have already done.
      writeFileSync(tokenPath(dataDir), 'not-the-token\n', { mode: 0o600 });

      const code = await status('--data-dir', dataDir);
      expect(code).toBe(70);
      expect(stderr()).toContain('refused this token');
      expect(stderr()).toContain('Stop the daemon and start it again');
      expect(stderr()).not.toContain('is not running');
    });

    it('diagnoses an empty token file here rather than as a refusal over there', async () => {
      // Both end in a 401 and the same exit code, and they have different
      // fixes: one is a file to replace, the other is a daemon to restart.
      writeFileSync(tokenPath(dataDir), '   \n', { mode: 0o600 });

      expect(await status('--data-dir', dataDir)).toBe(70);
      expect(stderr()).toContain('token file is empty');
      expect(stderr()).not.toContain('refused this token');
    });

    it('reads the data dir from the environment when no argument names one', async () => {
      const code = await runStatus([], {
        out: (t) => out.push(t),
        err: (t) => err.push(t),
        env: { INTERLOCK_DATA_DIR: dataDir },
      });
      expect(code).toBe(0);
      expect(stdout()).toContain(root);
    });

    it('lets the argument win over the environment', async () => {
      out = [];
      err = [];
      const code = await runStatus(['--data-dir', join(base, 'nowhere')], {
        out: (t) => out.push(t),
        err: (t) => err.push(t),
        env: { INTERLOCK_DATA_DIR: dataDir },
      });
      expect(code).toBe(69);
    });
  });

  describe('when the daemon is another build', () => {
    let stand: Server | null = null;

    /**
     * A listener standing in for a daemon this build did not produce.
     *
     * The one thing a real daemon cannot be here: it is compiled from the same
     * source, so it always agrees about the protocol and never answers a route
     * the way an older one would. A peer on a socket is a process boundary,
     * which is what may be stood in for.
     */
    const serve = async (
      routes: Record<string, { status: number; body: unknown }>,
    ): Promise<void> => {
      stand = createServer((request, response) => {
        const path = (request.url ?? '/').split('?')[0] ?? '/';
        const answer = routes[path] ?? { status: 404, body: {} };
        const payload = JSON.stringify(answer.body);
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(payload);
      });
      const listener = stand;
      await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
      const address = listener.address();
      if (address === null || typeof address === 'string') throw new Error('no address');

      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(runtimePath(dataDir), JSON.stringify({ port: address.port }), { mode: 0o600 });
      writeFileSync(tokenPath(dataDir), 'stand-in\n', { mode: 0o600 });
    };

    afterEach(async () => {
      const listener = stand;
      stand = null;
      if (listener !== null) await new Promise<void>((resolve) => listener.close(() => resolve()));
    });

    it('refuses a daemon speaking another protocol, and names both versions', async () => {
      // Half an upgrade. Reading on would mean parsing a payload whose shape the
      // other version decided.
      await serve({ '/api/health': { status: 200, body: { protocolVersion: 999 } } });

      const code = await status('--data-dir', dataDir);
      expect(code).toBe(70);
      expect(stderr()).toContain('different protocol');
      expect(stderr()).toContain('999');
      expect(stdout()).toBe('');
    });

    it('prints the remedy the daemon sent rather than a status code', async () => {
      // The daemon answers a failure with the shape `InterlockError.toJSON`
      // produces, and the remedy is the only part a user can act on.
      await serve({
        '/api/health': { status: 200, body: { protocolVersion: 1 } },
        '/api/repos': {
          status: 503,
          body: {
            error: {
              code: 'STORE_UNAVAILABLE',
              message: 'The store could not be read',
              remedy: 'Check that the data directory is writable by this user.',
            },
          },
        },
      });

      expect(await status('--data-dir', dataDir)).toBe(70);
      expect(stderr()).toContain('The store could not be read');
      expect(stderr()).toContain('Check that the data directory is writable');
    });
  });

  describe('its arguments', () => {
    it('refuses an option it does not have, and says where to look', async () => {
      expect(await status('--everything')).toBe(64);
      expect(stderr()).toContain('Unknown option');
      expect(stderr()).toContain('--help');
    });

    it('refuses --data-dir with nothing after it', async () => {
      expect(await status('--data-dir')).toBe(64);
      expect(await status('--data-dir', '--json')).toBe(64);
    });

    it('accepts --data-dir=<path> as well as two arguments', async () => {
      expect(await status(`--data-dir=${dataDir}`)).toBe(69);
      expect(stderr()).toContain('No daemon is running');
    });

    it('prints usage that names the exit codes it uses', async () => {
      expect(await status('--help')).toBe(0);
      expect(stdout()).toContain('69 daemon unreachable');
      expect(stdout()).toContain('interlock check');
    });
  });
});
