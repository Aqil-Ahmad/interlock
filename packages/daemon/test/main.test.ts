import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, runtimePath } from '@interlock/shared';
import type { DaemonRuntime } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `interlockd` as a process, because the entry point is the one piece nothing
 * else exercises: the config it loads, the exit code it answers with, and what
 * reaches stderr are all things a caller sees only from outside.
 *
 * Driven through `tsx` against the source, with the typecheck tsconfig's path
 * map, so a test run needs no prior build. A subprocess is a process boundary
 * and is exactly what these tests are about.
 */

const ROOT = realpathSync(join(import.meta.dirname, '..', '..', '..'));
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const MAIN = join(ROOT, 'packages', 'daemon', 'src', 'main.ts');
const TSCONFIG = join(ROOT, 'tsconfig.check.json');

interface Run {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

describe('interlockd', () => {
  let base: string;
  let dataDir: string;
  /**
   * Daemon pids to kill if a test fails before stopping them.
   *
   * `spawn` returns the pid of `tsx`, and the daemon is its child. A signal
   * `tsx` can relay reaches the daemon; `SIGKILL` cannot, so killing the
   * wrapper outright orphans a daemon that keeps its data directory held.
   */
  const strays = new Set<number>();

  /** The daemon's own pid, from the file it publishes once it is up. */
  const publishedPid = (): number | null => {
    try {
      return (JSON.parse(readFileSync(runtimePath(dataDir), 'utf8')) as DaemonRuntime).pid;
    } catch {
      return null;
    }
  };

  /** The daemon, as a process, with the environment the test chooses. */
  const daemon = (): ReturnType<typeof spawn> =>
    spawn(TSX, ['--tsconfig', TSCONFIG, MAIN], {
      env: { ...process.env, INTERLOCK_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  const finished = (child: ReturnType<typeof spawn>): Promise<Run> =>
    new Promise((resolve) => {
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('close', (code, signal) => resolve({ code, signal, stderr }));
    });

  const until = async (probe: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (!probe()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-main-')));
    dataDir = join(base, 'data');
    mkdirSync(dataDir, { mode: 0o700 });
  });

  afterEach(() => {
    for (const pid of strays) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone, which is the ordinary case.
      }
    }
    strays.clear();
    rmSync(base, { recursive: true, force: true });
  });

  it('refuses to start on a bad config, exits non-zero and says what was wrong', async () => {
    writeFileSync(configPath(dataDir), JSON.stringify({ repo: ['/x'] }));
    const run = await finished(daemon());

    expect(run.code).toBe(1);
    const record = JSON.parse(run.stderr.trim().split('\n').at(-1) ?? '{}') as {
      code?: string;
      msg?: string;
      remedy?: string;
    };
    expect(record.code).toBe('CONFIG_INVALID');
    expect(record.msg).toContain('`repo`');
    // The part a person can act on, carried rather than flattened away.
    expect(record.remedy).toContain(configPath(dataDir));
    expect(existsSync(runtimePath(dataDir))).toBe(false);
  }, 30_000);

  it('refuses a relative INTERLOCK_DATA_DIR with a remedy naming the variable', async () => {
    const child = spawn(TSX, ['--tsconfig', TSCONFIG, MAIN], {
      env: { ...process.env, INTERLOCK_DATA_DIR: './relative-data' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const run = await finished(child);

    expect(run.code).toBe(1);
    const record = JSON.parse(run.stderr.trim().split('\n').at(-1) ?? '{}') as {
      code?: string;
      msg?: string;
      remedy?: string;
    };
    expect(record.code).toBe('CONFIG_INVALID');
    expect(record.msg).toContain('INTERLOCK_DATA_DIR');
    // Not the store's remedy about `:memory:`, which names nothing the user set.
    expect(record.remedy).toContain('INTERLOCK_DATA_DIR');
    expect(record.remedy).not.toContain('memory');
    expect(existsSync(join(ROOT, 'relative-data'))).toBe(false);
  }, 30_000);

  it('lets a new daemon take the directory from one that was killed outright', async () => {
    writeFileSync(configPath(dataDir), JSON.stringify({ repos: [], daemon: { port: 0 } }));
    const first = daemon();
    const firstDone = finished(first);
    await until(() => publishedPid() !== null, 'the first daemon to start');
    const killed = publishedPid()!;
    strays.add(killed);

    // Whatever claim it held has to die with it: a lock that outlived a
    // `kill -9` would leave the directory unusable until someone deleted a file.
    process.kill(killed, 'SIGKILL');
    await firstDone;

    const second = daemon();
    const secondDone = finished(second);
    // The first left its runtime file behind, so wait for a different pid
    // rather than for the file.
    await until(() => {
      const pid = publishedPid();
      return pid !== null && pid !== killed;
    }, 'the second daemon to take over');
    strays.add(publishedPid()!);

    second.kill('SIGTERM');
    expect((await secondDone).code).toBe(0);
  }, 30_000);

  it('turns away a second daemon on the same directory and leaves the first running', async () => {
    writeFileSync(configPath(dataDir), JSON.stringify({ repos: [], daemon: { port: 0 } }));
    const first = daemon();
    const firstDone = finished(first);
    await until(() => publishedPid() !== null, 'the first daemon to start');
    const holder = publishedPid()!;
    strays.add(holder);

    const run = await finished(daemon());

    expect(run.code).toBe(1);
    const record = JSON.parse(run.stderr.trim().split('\n').at(-1) ?? '{}') as {
      code?: string;
      remedy?: string;
    };
    expect(record.code).toBe('CONFIG_INVALID');
    expect(record.remedy).toContain('INTERLOCK_DATA_DIR');
    // Refused before it could publish anything over the first one's file.
    expect(publishedPid()).toBe(holder);

    first.kill('SIGTERM');
    expect((await firstDone).code).toBe(0);
  }, 30_000);

  it('watches the repositories the config names, and stops cleanly on SIGTERM', async () => {
    const root = join(base, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Interlock Test'], { stdio: 'pipe' });
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'], {
      stdio: 'pipe',
    });
    writeFileSync(join(root, 'a.txt'), 'a\n');
    execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', root, 'commit', '-qm', 'one'], { stdio: 'pipe' });
    writeFileSync(configPath(dataDir), JSON.stringify({ repos: [root], daemon: { port: 0 } }));

    const child = daemon();
    const done = finished(child);
    await until(() => existsSync(runtimePath(dataDir)), 'the daemon to publish its port');

    const runtime = JSON.parse(readFileSync(runtimePath(dataDir), 'utf8')) as DaemonRuntime;
    expect(runtime.port).toBeGreaterThan(0);

    // What the config named is what is being watched: the API answers with it.
    const token = readFileSync(join(dataDir, 'token'), 'utf8').trim();
    const response = await fetch(`http://127.0.0.1:${String(runtime.port)}/api/repos`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as { repos: { rootPath: string }[] };
    expect(body.repos.map((repo) => repo.rootPath)).toStrictEqual([root]);

    child.kill('SIGTERM');
    const run = await done;
    expect(run.code).toBe(0);
    expect(existsSync(runtimePath(dataDir))).toBe(false);
  }, 30_000);
});
