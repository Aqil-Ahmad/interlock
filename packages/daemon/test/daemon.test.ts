import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, resolveConfig, runtimePath, tokenPath } from '@interlock/shared';
import type { BranchRef, EventRecord, InterlockConfig, LogRecord, Repo } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitRunner } from '@interlock/core';
import type { GitRunner } from '@interlock/core';
import { createDaemon } from '../src/daemon.js';
import type { Daemon } from '../src/daemon.js';
import { openStore } from '../src/store/index.js';
import { rejection } from './support/rejection.js';

/**
 * The composition root end to end: a real repository on disk, a real listener,
 * a real database file.
 *
 * Everything this task is responsible for is a property of the whole — the port
 * the CLI will read, the events that survive a restart, what is left behind by a
 * shutdown — and none of it is visible from any one component.
 */

describe('daemon', () => {
  let base: string;
  let dataDir: string;
  let root: string;
  let config: InterlockConfig;
  let daemon: Daemon;
  let logs: LogRecord[];

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  const call = <T>(path: string, token: string): Promise<{ status: number; body: T }> =>
    new Promise((resolve, reject) => {
      const port = daemon.runtime?.port ?? 0;
      const outgoing = request(
        { host: '127.0.0.1', port, path, headers: { Authorization: `Bearer ${token}` } },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            text += chunk;
          });
          response.on('end', () => {
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as T });
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });

  const token = (): string => readFileSync(tokenPath(dataDir), 'utf8').trim();

  /** Poll rather than sleep: the pipeline is timer- and debounce-driven. */
  const until = async <T>(probe: () => Promise<T | null>, what: string): Promise<T> => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const value = await probe();
      if (value !== null) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const readLog = async (): Promise<EventRecord[]> => {
    const store = await openStore({ path: join(dataDir, 'interlock.db') });
    try {
      const records: EventRecord[] = [];
      for await (const record of store.readEvents()) records.push(record);
      return records;
    } finally {
      await store.close();
    }
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-daemon-')));
    dataDir = join(base, 'data');
    root = join(base, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
    git(root, 'config', 'user.name', 'Interlock Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'a.txt'), 'a\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'one');

    logs = [];
    config = resolveConfig({ dataDir, repos: [root], daemon: { port: 0 } });
    daemon = createDaemon({
      config,
      logger: createLogger('test', { level: 'trace', sink: (record) => logs.push(record) }),
      sweepIntervalMs: 200,
    });
  });

  afterEach(async () => {
    await daemon.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('prunes its store once it is up, and logs what went', async () => {
    // Rows from a month ago, written before this daemon started: a store left
    // unpruned by an earlier run.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    const seeded = await openStore({ path: join(dataDir, 'interlock.db') });
    await seeded.appendEvent({
      id: '01AAAAAAAAAAAAAAAAAAAAAAAA' as EventRecord['id'],
      repoId: null,
      type: 'daemon.started',
      payload: { type: 'daemon.started', repoId: null, at: old, version: '0', pid: 1 },
      at: old,
      causedBy: null,
    });
    await seeded.close();

    await daemon.start();
    const pass = await until(
      () => Promise.resolve(logs.find((record) => record.msg === 'pruned the store') ?? null),
      'the first retention pass',
    );

    expect(pass).toMatchObject({ level: 'info', events: 1, complete: true });
    expect(pass.windowMs).toBe(config.retention.windowMs);
    expect((await readLog()).map((record) => record.at)).not.toContain(old);
  });

  it('prunes again on its timer, and a pass in flight holds up a stop', async () => {
    daemon = createDaemon({
      config,
      logger: createLogger('test', { level: 'trace', sink: (record) => logs.push(record) }),
      sweepIntervalMs: 200,
      retentionIntervalMs: 50,
    });
    await daemon.start();

    await until(
      () =>
        Promise.resolve(
          logs.filter((record) => record.msg === 'pruned the store').length >= 3 ? true : null,
        ),
      'three retention passes',
    );
    await daemon.stop();
    const passes = logs.filter((record) => record.msg === 'pruned the store').length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(logs.filter((record) => record.msg === 'pruned the store')).toHaveLength(passes);
  });

  it('publishes the port it actually bound, owner-readable only', async () => {
    await daemon.start();

    const runtime = daemon.runtime;
    expect(runtime).not.toBeNull();
    // `daemon.port` is 0 here, so anything that echoed the config would be 0.
    expect(runtime?.port).toBeGreaterThan(0);
    expect(runtime?.pid).toBe(process.pid);

    const path = runtimePath(dataDir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toStrictEqual(runtime);
  });

  it('replaces a runtime file left loose by an earlier run rather than writing into it', async () => {
    // `writeFileSync`'s mode applies only when it creates the file, so writing
    // in place over one left at 0644 keeps it there. Renaming a fresh file onto
    // the name is what makes the mode the new file's.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(runtimePath(dataDir), '{"stale":true}\n', { mode: 0o644 });

    await daemon.start();
    expect(statSync(runtimePath(dataDir)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(runtimePath(dataDir), 'utf8'))).toStrictEqual(daemon.runtime);
  });

  it('serves the repositories it watches once it is up', async () => {
    await daemon.start();

    const repos = await call<{ repos: Repo[] }>('/api/repos', token());
    expect(repos.status).toBe(200);
    expect(repos.body.repos).toHaveLength(1);
    expect(repos.body.repos[0]?.rootPath).toBe(root);

    const id = repos.body.repos[0]!.id;
    const branches = await call<{ branches: BranchRef[] }>(`/api/repos/${id}/branches`, token());
    expect(branches.body.branches.map((branch) => branch.name)).toStrictEqual(['main']);
  });

  it('notices an edit and snapshots it, rather than waiting out the recapture ceiling', async () => {
    await daemon.start();
    const repos = await call<{ repos: Repo[] }>('/api/repos', token());
    const id = repos.body.repos[0]!.id;

    const mainBranch = async (): Promise<BranchRef | undefined> => {
      const branches = await call<{ branches: BranchRef[] }>(`/api/repos/${id}/branches`, token());
      return branches.body.branches.find((branch) => branch.name === 'main');
    };

    // The startup pass already snapshotted the clean worktree and stamped the
    // branch with it, so "has a snapshot id" is true before anything is edited.
    // What proves the edit was seen is that the id moved. Waited for rather than
    // read once: reconciliation re-lists every branch with a null id and stamps
    // it a moment later, so a read can land in the gap.
    const before = await until(
      async () => (await mainBranch())?.dirty?.snapshotId ?? null,
      'the startup pass to stamp the branch with a snapshot',
    );

    // Only a filesystem signal can move it inside this test: the sweep runs
    // every 200ms but leaves an unmarked worktree unhashed for a minute.
    // Rewritten on every poll because macOS drops events under load, and one
    // dropped event here is a test that hangs rather than one that fails.
    await until(async () => {
      writeFileSync(join(root, 'a.txt'), `edited ${String(Date.now())}\n`);
      const main = await mainBranch();
      const stamped = main?.dirty?.snapshotId ?? null;
      return main?.dirty?.isDirty === true && stamped !== null && stamped !== before ? main : null;
    }, 'the branch to be stamped with a snapshot of its uncommitted work');

    await daemon.stop();
    const snapshots = (await readLog())
      .filter((record) => record.type === 'branch.snapshot')
      .map((record) => record.payload as { treeOid: string | null; fileCount: number });
    // The startup one carries the clean tree and no changed files; the edit's
    // carries one. Asserted over the set rather than the last, because the poll
    // keeps writing and the tail of the log is a race by construction.
    expect(snapshots.some((payload) => payload.treeOid !== null && payload.fileCount === 1)).toBe(
      true,
    );
  });

  it('persists the event log, so a restart can replay what the last run saw', async () => {
    await daemon.start();
    await daemon.stop();

    const records = await readLog();
    expect(records.map((record) => record.type)).toContain('repo.discovered');
    expect(records.map((record) => record.type)).toContain('branch.appeared');
    // Nothing has ever passed the bus its persistence hook before this, so the
    // ordering guarantee `readEvents` promises has never been exercised either.
    const ids = records.map((record) => record.id);
    expect([...ids].sort((a, b) => a.localeCompare(b))).toStrictEqual(ids);
  });

  it('keeps the token across a restart while the port is free to change', async () => {
    await daemon.start();
    const first = token();
    await daemon.stop();

    await daemon.start();
    expect(token()).toBe(first);
    expect(daemon.runtime?.port).toBeGreaterThan(0);
  });

  it('leaves no runtime file, no temporary file and a database that reopens', async () => {
    await daemon.start();
    await daemon.stop();

    expect(existsSync(runtimePath(dataDir))).toBe(false);
    expect(readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toStrictEqual([]);
    await expect(readLog()).resolves.not.toHaveLength(0);
  });

  it('shuts down cleanly while reconciliation is in flight', async () => {
    // Stopped without waiting for the first pass to settle, which is what a
    // SIGTERM moments after `interlock daemon start` does.
    const started = daemon.start();
    writeFileSync(join(root, 'a.txt'), 'edited\n');
    await started;
    await daemon.stop();

    expect(existsSync(runtimePath(dataDir))).toBe(false);
    expect(readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toStrictEqual([]);
    await expect(readLog()).resolves.not.toHaveLength(0);
    expect(logs.filter((record) => record.level === 'error')).toStrictEqual([]);
  });

  it('is safe to stop twice, because a second signal usually arrives', async () => {
    await daemon.start();
    await Promise.all([daemon.stop(), daemon.stop()]);
    expect(existsSync(runtimePath(dataDir))).toBe(false);
  });

  it('refuses to start twice rather than holding two of everything', async () => {
    await daemon.start();
    await expect(daemon.start()).rejects.toThrow(/already started/u);
  });

  it('rolls back a half-started daemon when the listener cannot bind', async () => {
    await daemon.start();
    const taken = createDaemon({
      config: resolveConfig({
        dataDir: join(base, 'other'),
        repos: [root],
        daemon: { port: daemon.runtime?.port ?? 0 },
      }),
      logger: createLogger('test', { level: 'error', sink: () => undefined }),
    });

    const error = await rejection(taken.start());
    expect(error.code).toBe('CONFIG_INVALID');
    // Nothing was published, so nothing tells a client to try that port.
    expect(existsSync(runtimePath(join(base, 'other')))).toBe(false);
    expect(taken.runtime).toBeNull();

    // And nothing was left half-held: a daemon that kept its store handle
    // refuses the next attempt as already started, which hides the real reason
    // the first one failed.
    const again = await rejection(taken.start());
    expect(again.code).toBe('CONFIG_INVALID');
    expect(again.message).toMatch(/already in use/u);
  });

  it('turns away a second daemon on the same data directory, whatever port it asks for', async () => {
    await daemon.start();
    const first = daemon.runtime;
    // Port 0 again, so the port cannot be what stops it: two daemons on two
    // ports would otherwise both run, each building shadows the other deletes.
    const second = createDaemon({
      config: resolveConfig({ dataDir, repos: [root], daemon: { port: 0 } }),
      logger: createLogger('test', { level: 'error', sink: () => undefined }),
    });

    const error = await rejection(second.start());

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toMatch(/another daemon/iu);
    expect(error.remedy).toContain('INTERLOCK_DATA_DIR');
    expect(second.runtime).toBeNull();
    // The first is untouched: still serving, and still the one advertised.
    expect(JSON.parse(readFileSync(runtimePath(dataDir), 'utf8'))).toStrictEqual(first);
    expect((await call<{ repos: Repo[] }>('/api/repos', token())).status).toBe(200);
  });

  it('turns a second daemon away before it opens the store the first is using', async () => {
    await daemon.start();
    // A store the second daemon cannot open tells the two orders apart: turned
    // away first, it never tries; opened first, it fails on the file instead.
    // Only the first order keeps a newer build from migrating a database that
    // an older daemon is still running on.
    const database = join(dataDir, 'interlock.db');
    chmodSync(database, 0o000);
    try {
      const second = createDaemon({
        config: resolveConfig({ dataDir, repos: [root], daemon: { port: 0 } }),
        logger: createLogger('test', { level: 'error', sink: () => undefined }),
      });

      const error = await rejection(second.start());

      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.message).toMatch(/another daemon/iu);
    } finally {
      chmodSync(database, 0o600);
    }
  });

  it('refuses a lock file it cannot open with a remedy, and leaves the file alone', async () => {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const lock = join(dataDir, 'daemon.lock');
    writeFileSync(lock, 'not a database, and long enough to be read as a header\n'.repeat(20));

    const error = await rejection(daemon.start());

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.remedy).toContain(lock);
    // Whether another daemon is running cannot be known when the lock will not
    // open, so the file is not the start's to delete.
    expect(existsSync(lock)).toBe(true);
    expect(daemon.runtime).toBeNull();
  });

  describe('a data directory inside a watched repository', () => {
    /** Refused before the lock: no data dir, no listener, the checkout as git sees it. */
    const expectRefused = async (at: string, repos: string[], checkout: string): Promise<void> => {
      const status = git(checkout, 'status', '--porcelain', '--ignored');
      const refused = createDaemon({
        config: resolveConfig({ dataDir: at, repos, daemon: { port: 0 } }),
        logger: createLogger('test', { level: 'error', sink: () => undefined }),
      });

      const error = await rejection(refused.start());

      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.infra).toBe(false);
      expect(error.remedy).toContain('INTERLOCK_DATA_DIR');
      expect(existsSync(at)).toBe(false);
      expect(refused.runtime).toBeNull();
      expect(git(checkout, 'status', '--porcelain', '--ignored')).toBe(status);
    };

    it('is refused before anything is written', async () => {
      await expectRefused(join(root, '.interlock'), [root], root);
    });

    it('is refused inside any watched repository, not only the first', async () => {
      const other = join(base, 'other');
      execFileSync('git', ['init', '-q', '-b', 'main', other], { stdio: 'pipe' });

      await expectRefused(join(other, '.interlock'), [root, other], other);
    });

    it('is refused inside the main checkout when a linked worktree is what is watched', async () => {
      git(root, 'branch', 'feature');
      const linked = join(base, 'linked');
      git(root, 'worktree', 'add', '-q', linked, 'feature');

      await expectRefused(join(root, '.interlock'), [linked], root);
    });

    it('is refused inside the main checkout of a git dir kept apart, watched through a linked worktree', async () => {
      // Nothing in the shared git dir names this checkout; its `.git` file
      // names the git dir, which is what git answers with from inside it.
      const separate = join(base, 'separate');
      const apart = join(base, 'apart.git');
      execFileSync('git', ['init', '-q', '-b', 'main', `--separate-git-dir=${apart}`, separate], {
        stdio: 'pipe',
      });
      git(
        separate,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'one',
      );
      const linked = join(base, 'linked');
      git(separate, 'worktree', 'add', '-q', '-b', 'feature', linked);

      await expectRefused(join(separate, '.interlock'), [linked], separate);
    });

    it('refuses to start when git cannot fully answer for a watched repository', async () => {
      // The worktree list is read and the common dir is not: half an answer is
      // not a check, and the data dir it would have allowed stays unwritten.
      const real = createGitRunner();
      const failing: GitRunner = {
        run: (target, args, runOptions) =>
          args.includes('--git-common-dir') && target.rootPath === root
            ? Promise.resolve({ exitCode: 128, stdout: '', stderr: 'fatal: injected' })
            : real.run(target, args, runOptions),
      };
      const refused = createDaemon({
        config: resolveConfig({ dataDir, repos: [root], daemon: { port: 0 } }),
        logger: createLogger('test', { level: 'error', sink: () => undefined }),
        runner: failing,
      });

      await rejection(refused.start());

      expect(existsSync(dataDir)).toBe(false);
      expect(refused.runtime).toBeNull();
    });

    it('is refused inside a watched path that is not a repository yet', async () => {
      const later = join(base, 'later');
      mkdirSync(later);
      const refused = createDaemon({
        config: resolveConfig({
          dataDir: join(later, 'data'),
          repos: [later],
          daemon: { port: 0 },
        }),
        logger: createLogger('test', { level: 'error', sink: () => undefined }),
      });

      expect((await rejection(refused.start())).code).toBe('CONFIG_INVALID');
      expect(readdirSync(later)).toStrictEqual([]);
    });
  });

  it('stops a daemon whose start was still in flight, rather than letting it finish afterwards', async () => {
    const started = daemon.start();
    const stopped = daemon.stop();

    await Promise.allSettled([started]);
    await stopped;

    expect(daemon.runtime).toBeNull();
    expect(existsSync(runtimePath(dataDir))).toBe(false);
    // The lock was released, so the directory is free for the next daemon.
    const next = createDaemon({
      config: resolveConfig({ dataDir, repos: [root], daemon: { port: 0 } }),
      logger: createLogger('test', { level: 'error', sink: () => undefined }),
    });
    await next.start();
    await next.stop();
  });

  it('hands the directory to the next daemon once the first has stopped', async () => {
    await daemon.start();
    await daemon.stop();
    const next = createDaemon({
      config: resolveConfig({ dataDir, repos: [root], daemon: { port: 0 } }),
      logger: createLogger('test', { level: 'error', sink: () => undefined }),
    });

    try {
      await next.start();
      expect(next.runtime?.port).toBeGreaterThan(0);
    } finally {
      await next.stop();
    }
  });

  it('reports purge as unimplemented rather than deleting nothing quietly', async () => {
    const error = await rejection(daemon.purge());
    expect(error.code).toBe('NOT_IMPLEMENTED');
  });
});
