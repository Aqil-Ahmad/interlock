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

    it('renders a real branch name carrying a bidi control without letting it through', async () => {
      // Git refuses ASCII controls in a ref name and accepts this one, so it is
      // a name an agent can actually create — and it reorders what a terminal
      // displays, so the name shown is not the name on disk.
      const rlo = String.fromCodePoint(0x202e);
      git(root, 'branch', `wip/${rlo}payload`);

      await until(async () => {
        await status('--data-dir', dataDir, '--json');
        const parsed = JSON.parse(stdout()) as { repos: { branches: { name: string }[] }[] };
        return parsed.repos[0]?.branches.some((b) => b.name.includes(rlo)) ?? false;
      }, 'the branch to reach the report');

      // The machine path carries it as it is on disk, escaped in transport.
      await status('--data-dir', dataDir, '--json');
      const json = stdout();
      expect(json).not.toContain(rlo);
      expect(json).toContain('\\u202e');
      const parsed = JSON.parse(json) as { repos: { branches: { name: string }[] }[] };
      expect(parsed.repos[0]?.branches.some((b) => b.name === `wip/${rlo}payload`)).toBe(true);

      // The human path never carries it at all.
      await status('--data-dir', dataDir);
      expect(stdout()).not.toContain(rlo);
      expect(stdout()).toContain('\\u{202e}');
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
    /** How many requests were being answered at once, at the busiest moment. */
    let peak = 0;
    let inFlight = 0;

    /**
     * A listener standing in for a daemon this build did not produce.
     *
     * The one thing a real daemon cannot be here: it is compiled from the same
     * source, so it always agrees about the protocol and never answers a route
     * the way an older one would. A peer on a socket is a process boundary,
     * which is what may be stood in for.
     */
    const serve = async (
      routes: Record<string, { status: number; body: unknown; raw?: string; delayMs?: number }>,
    ): Promise<void> => {
      stand = createServer((request, response) => {
        const path = (request.url ?? '/').split('?')[0] ?? '/';
        const answer = routes[path] ?? { status: 404, body: {} };
        const payload = answer.raw ?? JSON.stringify(answer.body);

        const finish = (): void => {
          response.writeHead(answer.status, { 'content-type': 'application/json' });
          response.end(payload);
          inFlight -= 1;
        };
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        if (answer.delayMs === undefined) finish();
        else setTimeout(finish, answer.delayMs);
      });
      const listener = stand;
      await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
      const address = listener.address();
      if (address === null || typeof address === 'string') throw new Error('no address');

      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(runtimePath(dataDir), JSON.stringify({ port: address.port }), { mode: 0o600 });
      writeFileSync(tokenPath(dataDir), 'stand-in\n', { mode: 0o600 });
    };

    beforeEach(() => {
      peak = 0;
      inFlight = 0;
    });

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

    it('keeps the code the daemon chose rather than re-minting every failure', async () => {
      // A repository that vanished between listing it and asking about it is
      // `REPO_NOT_FOUND` at the daemon, and a script matching on codes must not
      // be told the request was malformed instead.
      await serve({
        '/api/health': { status: 200, body: { protocolVersion: 1 } },
        '/api/repos': {
          status: 200,
          body: {
            repos: [
              {
                id: 'gone',
                rootPath: '/x',
                defaultBranch: 'main',
                shadowPath: '/s',
                config: {},
                discoveredAt: 'now',
                lastSeenAt: 'now',
              },
            ],
          },
        },
        '/api/repos/gone/branches': {
          status: 404,
          body: { error: { code: 'REPO_NOT_FOUND', message: 'No such repository' } },
        },
      });

      expect(await status('--data-dir', dataDir)).toBe(70);
      // The code, not just the prose: a script is meant to react to it without
      // matching on a message that is free to change.
      expect(stderr()).toContain('REPO_NOT_FOUND');
      expect(stderr()).toContain('No such repository');
      expect(stderr()).not.toContain('API_REQUEST_INVALID');
    });

    it('refuses to pass on a code this build has never heard of', async () => {
      // The code arrives from another process, and one that is not a code is
      // not something to hand to a caller matching on them.
      await serve({
        '/api/health': { status: 200, body: { protocolVersion: 1 } },
        '/api/repos': {
          status: 500,
          body: { error: { code: 'SOMETHING_NEW', message: 'from a later build' } },
        },
      });

      expect(await status('--data-dir', dataDir)).toBe(70);
      expect(stderr()).toContain('API_REQUEST_INVALID');
      expect(stderr()).not.toContain('SOMETHING_NEW');
      expect(stderr()).toContain('from a later build');
    });

    it('survives an error body that is not JSON at all', async () => {
      await serve({
        '/api/health': { status: 200, body: { protocolVersion: 1 } },
        '/api/repos': { status: 502, body: null, raw: '<html>gateway</html>' },
      });

      expect(await status('--data-dir', dataDir)).toBe(70);
      expect(stderr()).not.toBe('');
    });

    it('asks about every repository at once rather than one after another', async () => {
      // Each request carries its own timeout, so a serial pass multiplies the
      // worst case by the number of repositories. Asserted on overlap rather
      // than on elapsed time, which passes under load whatever the code does.
      const repos = ['one', 'two', 'three'].map((id) => ({
        id,
        rootPath: `/work/${id}`,
        defaultBranch: 'main',
        shadowPath: `/s/${id}`,
        config: {},
        discoveredAt: 'now',
        lastSeenAt: 'now',
      }));
      await serve({
        '/api/health': { status: 200, body: { protocolVersion: 1 } },
        '/api/repos': { status: 200, body: { repos } },
        ...Object.fromEntries(
          repos.map((repo) => [
            `/api/repos/${repo.id}/branches`,
            { status: 200, body: { branches: [] }, delayMs: 100 },
          ]),
        ),
      });

      expect(await status('--data-dir', dataDir)).toBe(0);
      expect(peak).toBeGreaterThan(1);
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

    it('explains itself even when another argument is wrong', async () => {
      // Whoever mistyped an option is the person most likely to have wanted the
      // help, so refusing to print it because of that mistake is the least
      // useful moment to stop.
      expect(await status('--everything', '--help')).toBe(0);
      expect(stdout()).toContain('Usage: interlock status');
      expect(stderr()).toBe('');
    });

    it('says a data dir that is a file is not a directory', async () => {
      const notADir = join(base, 'a-file');
      writeFileSync(notADir, 'not a directory\n');

      // Reported as the path being wrong, not as a daemon nobody started —
      // starting one would show the same message again.
      expect(await status('--data-dir', notADir)).toBe(70);
      expect(stderr()).toContain('not a directory');
      expect(stderr()).not.toContain('Start it with');
    });

    it('prints usage that names the exit codes it uses', async () => {
      expect(await status('--help')).toBe(0);
      expect(stdout()).toContain('69 daemon unreachable');
      expect(stdout()).toContain('interlock check');
    });
  });
});
