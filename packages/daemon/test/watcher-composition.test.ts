import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createGitRunner } from '@interlock/core';
import { createLogger, resolveConfig } from '@interlock/shared';
import type { InterlockEvent, LogRecord } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/bus/index.js';
import { openStore } from '../src/store/index.js';
import type { Store } from '../src/store/index.js';
import { createWatcher } from '../src/watcher/index.js';
import type { Watcher } from '../src/watcher/index.js';

/**
 * The three watcher parts joined together, which is where the mistakes that no
 * single part can make live: pointing a ref watch at the wrong git directory,
 * reconciling the wrong repository for a signal, and leaving a watch on a
 * worktree that is gone.
 *
 * The sweep interval is long on purpose. Anything that arrives here arrives
 * because a filesystem signal carried it, not because a timer came round.
 */

const NEVER_SWEEPS_MS = 600_000;

describe('watcher composition', () => {
  let base: string;
  let root: string;
  let linked: string;
  let store: Store;
  let bus: EventBus;
  let watcher: Watcher;
  let events: InterlockEvent[];
  let logs: LogRecord[];
  let watched: string[];
  let closed: string[];

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  const until = async (probe: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (!probe()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const build = async (sweepIntervalMs: number, using: Store = store): Promise<Watcher> => {
    const created = createWatcher({
      config: resolveConfig({ dataDir: join(base, 'data'), repos: [root] }),
      store: using,
      bus,
      runner: createGitRunner(),
      logger: createLogger('test', { level: 'trace', sink: (record) => logs.push(record) }),
      sweepIntervalMs,
      // The real watcher, recorded: what is asserted is which paths it was
      // pointed at, so replacing it with a fake would assert the fake.
      watchFactory: (path, options) => {
        watched.push(path);
        const handle = watch(path, { recursive: options.recursive, persistent: true });
        const close = handle.close.bind(handle);
        handle.close = (): void => {
          closed.push(path);
          close();
        };
        return handle;
      },
    });
    await created.start();
    return created;
  };

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-watch-')));
    root = join(base, 'repo');
    linked = join(base, 'feature');
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
    git(root, 'config', 'user.name', 'Interlock Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'a.txt'), 'a\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'one');
    git(root, 'worktree', 'add', '-q', '-b', 'feature', linked);

    events = [];
    logs = [];
    watched = [];
    closed = [];
    store = await openStore({ path: ':memory:' });
    bus = new EventBus({ logger: createLogger('bus', { level: 'error', sink: () => undefined }) });
    bus.onAny((event) => {
      events.push(event);
    });
  });

  afterEach(async () => {
    await watcher.stop();
    await store.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('watches a linked worktree through its own git dir and the shared one', async () => {
    watcher = await build(NEVER_SWEEPS_MS);

    // A linked worktree keeps `HEAD` in `<main>/.git/worktrees/<name>` and its
    // `refs/` in the main checkout's git dir. Deriving the git dir from the
    // repository root alone points both at the main checkout, and the branch in
    // the linked worktree then never reports a commit.
    const times = (path: string): number => watched.filter((seen) => seen === path).length;
    expect(watched).toContain(linked);
    expect(watched).toContain(join(root, '.git', 'worktrees', 'feature'));
    // Once for the main worktree, whose git dir this is, and once more as the
    // linked worktree's shared directory. A target that dropped `commonDir`
    // would register these once and the counts would not say so.
    expect(times(join(root, '.git'))).toBe(2);
    expect(times(`${join(root, '.git')}${sep}refs`)).toBe(2);
  });

  it('reconciles the repository a signal belongs to, without waiting for the timer', async () => {
    watcher = await build(NEVER_SWEEPS_MS);
    events.length = 0;

    // Rewritten on every poll, not once. The timer is switched off here, so a
    // filesystem event the platform drops under load has nothing behind it —
    // and macOS drops them. Repeating the write is what an agent does anyway,
    // and the property under test is unchanged: no timer ever fires.
    await until(() => {
      writeFileSync(join(linked, 'a.txt'), `edited ${String(Date.now())}\n`);
      return events.some((event) => event.type === 'branch.snapshot');
    }, 'a snapshot of the linked worktree');
    const snapshot = events.find((event) => event.type === 'branch.snapshot');
    expect(snapshot).toMatchObject({ fileCount: 1 });
  });

  it('drops the watch on a worktree that is gone', async () => {
    watcher = await build(NEVER_SWEEPS_MS);
    git(root, 'worktree', 'remove', '--force', linked);
    watched.length = 0;
    closed.length = 0;
    events.length = 0;

    await watcher.refresh();

    // The branch outlives its worktree — `worktree remove` does not delete it —
    // so what changes is where it is checked out, and the watch has to follow.
    expect(closed).toContain(linked);
    expect(events).toContainEqual(expect.objectContaining({ type: 'branch.updated' }));
    // Re-registering an unchanged target would drop and rebuild a recursive
    // watch over a whole repository on every pass.
    expect(watched).toStrictEqual([]);
  });

  it('re-watches a worktree when the repository changes what it wants ignored', async () => {
    watcher = await build(NEVER_SWEEPS_MS);
    watched.length = 0;
    closed.length = 0;

    // `watch` is a no-op for a worktree already watched, which is what stops a
    // recursive watch being rebuilt every pass — and would also leave the old
    // ignore list in place for ever.
    writeFileSync(join(root, '.interlock.json'), '{"ignore":["logs/**"]}\n');
    await watcher.refresh();

    expect(closed).toContain(root);
    expect(closed).toContain(linked);
    expect(watched).toContain(root);
    expect(watched).toContain(linked);
  });

  it('does not re-arm watches from a pass that was still running at stop', async () => {
    // A pass reads the store across several awaits, and `stop` can land in one
    // of them. Re-arming after `close` opens watches nothing will ever close.
    let held = false;
    let open: (() => void) | undefined;
    let reached: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });

    // A proxy rather than a spread, and every method bound back to the store:
    // read off the proxy they would be called with the proxy as `this`, which
    // silently answers nothing instead of failing.
    const gated = new Proxy(store, {
      get(target, property): unknown {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== 'function') return value;
        const bound = (value as (...rest: unknown[]) => unknown).bind(target);
        if (property !== 'listRepos') return bound;
        return async (...args: unknown[]): Promise<unknown> => {
          reached?.();
          if (held) await gate;
          return bound(...args);
        };
      },
    });

    watcher = await build(NEVER_SWEEPS_MS, gated);
    held = true;
    watched.length = 0;

    const pass = watcher.refresh();
    await atGate;
    await watcher.stop();
    open?.();
    await pass;

    expect(watched).toStrictEqual([]);
  });

  it('stops without leaving a timer or a watch behind, twice over', async () => {
    // Short enough that several passes are due inside the wait below, so a timer
    // that was not cleared shows up as events rather than as a leaked handle.
    watcher = await build(50);
    closed.length = 0;
    await watcher.stop();
    // A second stop is what a failed start followed by a shutdown does.
    await expect(watcher.stop()).resolves.toBeUndefined();

    // Asserted on the handles rather than on the silence that follows: a flag
    // that suppressed signals would produce the same silence and leave every
    // watch open.
    expect(closed).toContain(linked);
    expect(closed).toContain(root);

    const before = events.length;
    writeFileSync(join(linked, 'a.txt'), 'after the stop\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(events.length).toBe(before);
  });
});
