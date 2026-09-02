import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createLogger } from '@interlock/shared';
import type { LogRecord } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktreeWatcher } from '../src/watcher/worktree-watcher.js';
import type {
  ChangeSignal,
  WatchFactory,
  WorktreeWatcher,
} from '../src/watcher/worktree-watcher.js';

/**
 * The watcher against a real repository, because everything it can get wrong is
 * a property of the platform's filesystem events rather than of the code above
 * them: a save arriving as three events, an editor renaming over a file, a
 * watched directory disappearing, and `/var` resolving to `/private/var`.
 */

/**
 * Above the platform's own coalescing gap, and no higher.
 *
 * Measured on macOS: a burst of 20–50 writes is delivered over ~55ms with gaps
 * of 43–50ms between events. A debounce below that splits one burst into
 * several signals — not a bug, but it makes "one edit, one signal" untestable,
 * because the window closes while the OS is still delivering.
 */
const DEBOUNCE_MS = 150;

/**
 * Long enough for a debounce plus the platform's own delivery latency.
 *
 * Asserting that nothing further arrives needs a wait; there is no event for
 * the absence of an event.
 */
const SETTLE_MS = 500;

const settle = (ms: number = SETTLE_MS): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('worktree watcher', () => {
  let base: string;
  let root: string;
  let watcher: WorktreeWatcher;
  let signals: ChangeSignal[];

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  /** Ignore whatever the platform replays at watch start, then observe. */
  const observe = async (): Promise<void> => {
    await settle();
    signals.length = 0;
  };

  beforeEach(() => {
    // git reports fully-resolved paths, and on macOS /var is a symlink to
    // /private/var — so the fixture works in canonical form throughout.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-watch-')));
    root = join(base, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
    git(root, 'config', 'user.name', 'Interlock Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.txt'), 'a\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'one');

    signals = [];
    watcher = createWorktreeWatcher({
      onSignal: (signal) => signals.push(signal),
      debounceMs: DEBOUNCE_MS,
    });
  });

  afterEach(() => {
    watcher.close();
    rmSync(base, { recursive: true, force: true });
  });

  /**
   * Watchers whose events this test drives directly.
   *
   * The paths below are platform-dependent — macOS goes quiet when a watched
   * root is deleted where Linux reports ENOENT, and no platform produces an
   * exhausted watch budget on demand — so the kernel boundary is stubbed.
   */
  const fakeWatchers = (): { factory: WatchFactory; emitters: EventEmitter[] } => {
    const emitters: EventEmitter[] = [];
    return {
      emitters,
      factory: () => {
        const emitter = new EventEmitter();
        emitters.push(emitter);
        return Object.assign(emitter, { close: () => undefined }) as unknown as FSWatcher;
      },
    };
  };

  const worktreeSignals = (): ChangeSignal[] => signals.filter((s) => s.kind === 'worktree');
  const refSignals = (): ChangeSignal[] => signals.filter((s) => s.kind === 'ref');

  it('reports one signal for one edit', async () => {
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    writeFileSync(join(root, 'src', 'a.txt'), 'edited\n');
    await settle();

    expect(worktreeSignals()).toHaveLength(1);
    expect(worktreeSignals()[0]?.paths).toContain('src/a.txt');
  });

  it('collapses the three events one atomic save produces', async () => {
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    // What an editor does: write a temp file, rename it over the target.
    writeFileSync(join(root, 'src', 'a.tmp'), 'edited\n');
    execFileSync('mv', [join(root, 'src', 'a.tmp'), join(root, 'src', 'a.txt')]);
    await settle();

    expect(worktreeSignals()).toHaveLength(1);
  });

  it('collapses a burst across several files', async () => {
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    for (let i = 0; i < 20; i++) writeFileSync(join(root, 'src', `f${String(i)}.txt`), 'x\n');
    await settle();

    expect(worktreeSignals()).toHaveLength(1);
    expect(worktreeSignals()[0]?.paths.length).toBeGreaterThan(1);
  });

  it('reports the canonical worktree path, whatever path it was given', async () => {
    const link = join(base, 'link-to-repo');
    symlinkSync(root, link);

    watcher.watch({ worktreePath: link, gitDir: join(root, '.git') });
    await observe();

    writeFileSync(join(root, 'src', 'a.txt'), 'edited\n');
    await settle();

    // git reports canonical paths, so a signal naming the symlink would never
    // match anything discovery produced.
    expect(worktreeSignals()[0]?.worktreePath).toBe(root);
    expect(watcher.watching).toEqual([root]);
  });

  it('says nothing about a path the repository asked to ignore', async () => {
    mkdirSync(join(root, 'dist'), { recursive: true });
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git'), ignore: ['dist/'] });
    await observe();

    writeFileSync(join(root, 'dist', 'out.js'), 'x\n');
    await settle();

    expect(worktreeSignals()).toEqual([]);
  });

  it('honours the repository .gitignore', async () => {
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x\n');
    await settle();

    // Watching node_modules is the difference between the CPU budget and a core.
    expect(worktreeSignals()).toEqual([]);
  });

  it('honours a .gitignore directory line', async () => {
    // The trailing slash is the commonest form there is, and `trimSlashes`
    // running before the any-depth check is what makes it work. Without it
    // every `dist/`-style line silently stops matching — the CPU-burn case.
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x\n');
    await settle();

    expect(worktreeSignals()).toEqual([]);
  });

  it('re-reads .gitignore when it changes', async () => {
    mkdirSync(join(root, 'generated'), { recursive: true });
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    writeFileSync(join(root, '.gitignore'), 'generated/\n');
    await settle();
    signals.length = 0;

    writeFileSync(join(root, 'generated', 'out.js'), 'x\n');
    await settle();

    // A repository that starts ignoring a directory mid-session is honoured
    // without a restart; the alternative is burning events until it is
    // re-watched, which may be never.
    expect(worktreeSignals()).toEqual([]);
  });

  it('says nothing about a vendored repository’s own git dir', async () => {
    mkdirSync(join(root, 'vendor', 'dep', '.git', 'refs'), { recursive: true });
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    writeFileSync(join(root, 'vendor', 'dep', '.git', 'index'), 'x\n');
    await settle();

    // A submodule or vendored checkout has a git dir too, and its churn is no
    // more interesting than the main one's.
    expect(worktreeSignals()).toEqual([]);
  });

  it('keeps delivering from a subdirectory that was deleted and re-created', async () => {
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    rmSync(join(root, 'src'), { recursive: true, force: true });
    await settle();
    mkdirSync(join(root, 'src'), { recursive: true });
    await settle();
    signals.length = 0;

    writeFileSync(join(root, 'src', 'reborn.txt'), 'x\n');
    await settle();

    // The classic recursive-watch hole: a re-created directory is a new inode,
    // and a watcher that registered the old one goes deaf to it.
    expect(worktreeSignals()).toHaveLength(1);
    expect(worktreeSignals()[0]?.paths).toContain('src/reborn.txt');
  });

  it('keeps watching everything when .gitignore uses negation', async () => {
    writeFileSync(join(root, '.gitignore'), 'build\n!build/keep.txt\n');
    mkdirSync(join(root, 'build'), { recursive: true });
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    writeFileSync(join(root, 'build', 'keep.txt'), 'x\n');
    await settle();

    // A negation rescues a path this matcher would exclude. Missing a change is
    // worse than a wasted signal, so the whole file is dropped rather than
    // half-applied.
    expect(worktreeSignals()).toHaveLength(1);
  });

  it('says nothing about git’s own churn in the worktree watch', async () => {
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    // `git add` writes the index unconditionally, where a `status` only does so
    // when its stat cache is stale — so this cannot pass by producing no event.
    writeFileSync(join(root, 'staged.txt'), 'x\n');
    git(root, 'add', 'staged.txt');
    await settle();

    expect(worktreeSignals()).toHaveLength(1);
    expect(worktreeSignals()[0]?.paths).toContain('staged.txt');
    // And no ref change. The git dir is watched for `HEAD` and `packed-refs`
    // only; the index and its lock file arrive on every command and say nothing
    // about a branch.
    expect(refSignals()).toEqual([]);
  });

  it('reports a ref signal for a commit', async () => {
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    writeFileSync(join(root, 'src', 'b.txt'), 'b\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'two');
    await settle();

    expect(refSignals().length).toBeGreaterThan(0);
    expect(refSignals()[0]?.worktreePath).toBe(root);
  });

  it('reports a ref signal for a branch checkout', async () => {
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    git(root, 'checkout', '-q', '-b', 'feature');
    await settle();

    // HEAD moved without any commit; a watcher that only followed refs/ would
    // miss every checkout.
    expect(refSignals().length).toBeGreaterThan(0);
  });

  it('follows a linked worktree’s own HEAD and the shared refs', async () => {
    const linked = join(base, 'wt-feature');
    git(root, 'worktree', 'add', '-q', '-b', 'feature', linked);
    const gitDir = git(linked, 'rev-parse', '--absolute-git-dir').trim();
    const commonDir = realpathSync(
      git(linked, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim(),
    );

    // Its git dir is <main>/.git/worktrees/<name>, which holds HEAD but no refs.
    expect(gitDir).toContain('worktrees');
    watcher.watch({ worktreePath: linked, gitDir, commonDir });
    await observe();

    writeFileSync(join(linked, 'c.txt'), 'c\n');
    git(linked, 'add', '-A');
    git(linked, 'commit', '-qm', 'three');
    await settle();

    expect(refSignals().length).toBeGreaterThan(0);
  });

  it('stops cleanly when the watched worktree is deleted', async () => {
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    rmSync(root, { recursive: true, force: true });
    await settle();

    // An agent removing a worktree is ordinary; it must not take the daemon
    // with it, and close() must still succeed afterwards.
    // Not an OS refusal: polling a directory that no longer exists would burn a
    // timer forever on a worktree that is never coming back. Checked before
    // close(), which drops the target and would make this pass either way.
    expect(watcher.isDegraded(root)).toBe(false);
    expect(() => {
      watcher.close();
    }).not.toThrow();
  });

  it('survives a watched subdirectory being removed', async () => {
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    rmSync(join(root, 'src'), { recursive: true, force: true });
    await settle();

    expect(worktreeSignals().length).toBeGreaterThan(0);
    writeFileSync(join(root, 'after.txt'), 'x\n');
    await settle();

    // Still delivering after the removal, rather than a dead watcher.
    expect(worktreeSignals().length).toBeGreaterThan(1);
  });

  it('falls back to polling when the OS refuses a watch', async () => {
    const records: LogRecord[] = [];
    const degraded = createWorktreeWatcher({
      onSignal: (signal) => signals.push(signal),
      debounceMs: DEBOUNCE_MS,
      pollIntervalMs: 60,
      logger: createLogger('test', { level: 'trace', sink: (r) => records.push(r) }),
      watchFactory: () => {
        // What an exhausted inotify budget looks like: a property of the
        // machine, not of the repository.
        const error: NodeJS.ErrnoException = new Error('ENOSPC: watch limit reached');
        error.code = 'ENOSPC';
        throw error;
      },
    });

    try {
      degraded.watch({ worktreePath: root, gitDir: join(root, '.git') });

      expect(degraded.isDegraded(root)).toBe(true);
      expect(records.map((r) => r.msg)).toContain('watch refused, falling back to polling');
      // Still watched, so the sweep keeps being told to look — with no paths,
      // because polling cannot name what changed.
      expect(degraded.watching).toEqual([root]);

      await settle(300);
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((signal) => signal.paths.length === 0)).toBe(true);
    } finally {
      degraded.close();
    }
  });

  it('reports a change the platform could not name', async () => {
    const { factory, emitters } = fakeWatchers();
    const unnamed = createWorktreeWatcher({
      onSignal: (signal) => signals.push(signal),
      debounceMs: DEBOUNCE_MS,
      watchFactory: factory,
    });

    try {
      unnamed.watch({ worktreePath: root, gitDir: join(root, '.git') });
      // Platforms do deliver a change with no filename. It is a real change
      // with an unknown path, never the absence of one.
      emitters[0]?.emit('change', 'rename', null);
      await settle();

      expect(worktreeSignals()).toHaveLength(1);
      // Not `['']` — the empty string is how the batch carries an unnamed event
      // and is not a path any consumer can act on.
      expect(worktreeSignals()[0]?.paths).toEqual([]);
    } finally {
      unnamed.close();
    }
  });

  it('closes a watch quietly when its path disappears', async () => {
    const { factory, emitters } = fakeWatchers();
    const vanishing = createWorktreeWatcher({
      onSignal: (signal) => signals.push(signal),
      debounceMs: DEBOUNCE_MS,
      pollIntervalMs: 30,
      watchFactory: factory,
    });

    try {
      vanishing.watch({ worktreePath: root, gitDir: join(root, '.git') });
      const gone: NodeJS.ErrnoException = new Error('ENOENT: no such file or directory');
      gone.code = 'ENOENT';
      emitters[0]?.emit('error', gone);
      await settle(150);

      // A directory that is gone is not an OS refusal. Polling it would burn a
      // timer forever on a worktree that is never coming back.
      expect(vanishing.isDegraded(root)).toBe(false);
      expect(signals).toEqual([]);
    } finally {
      vanishing.close();
    }
  });

  it('degrades on an error that is not a missing path', async () => {
    const { factory, emitters } = fakeWatchers();
    const failing = createWorktreeWatcher({
      onSignal: (signal) => signals.push(signal),
      debounceMs: DEBOUNCE_MS,
      pollIntervalMs: 30,
      watchFactory: factory,
    });

    try {
      failing.watch({ worktreePath: root, gitDir: join(root, '.git') });
      const budget: NodeJS.ErrnoException = new Error('ENOSPC: watch limit reached');
      budget.code = 'ENOSPC';
      emitters[0]?.emit('error', budget);
      await settle(150);

      expect(failing.isDegraded(root)).toBe(true);
    } finally {
      failing.close();
    }
  });

  it('does not invent a path when the worktree root itself changes', async () => {
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    // Measured on macOS: a metadata change on the watched directory is reported
    // as that directory's own name, which would otherwise reach the sweep as a
    // file inside the worktree that does not exist.
    utimesSync(root, new Date(), new Date());
    await settle();

    const rootName = basename(root);
    expect(signals.every((signal) => !signal.paths.includes(rootName))).toBe(true);
    for (const signal of worktreeSignals()) expect(signal.paths).toEqual([]);
  });

  it('treats the root’s own name as unnamed on every platform', async () => {
    const { factory, emitters } = fakeWatchers();
    const rooted = createWorktreeWatcher({
      onSignal: (signal) => signals.push(signal),
      debounceMs: DEBOUNCE_MS,
      watchFactory: factory,
    });

    try {
      rooted.watch({ worktreePath: root, gitDir: join(root, '.git') });
      emitters[0]?.emit('change', 'change', basename(root));
      await settle();

      // Not dropped: a file really called that would be lost. Unnamed, so the
      // sweep asks git instead of being told about a path that may not exist.
      expect(worktreeSignals()).toHaveLength(1);
      expect(worktreeSignals()[0]?.paths).toEqual([]);
    } finally {
      rooted.close();
    }
  });

  it('reports a batch as unnamed when any event in it was', async () => {
    const { factory, emitters } = fakeWatchers();
    const mixed = createWorktreeWatcher({
      onSignal: (signal) => signals.push(signal),
      debounceMs: DEBOUNCE_MS,
      watchFactory: factory,
    });

    try {
      mixed.watch({ worktreePath: root, gitDir: join(root, '.git') });
      emitters[0]?.emit('change', 'rename', 'src/a.txt');
      emitters[0]?.emit('change', 'rename', null);
      await settle();

      expect(worktreeSignals()).toHaveLength(1);
      // Reporting only `src/a.txt` would be narrower than the truth: a consumer
      // scoping a status to it would miss whatever the unnamed event was.
      expect(worktreeSignals()[0]?.paths).toEqual([]);
    } finally {
      mixed.close();
    }
  });

  it('is not degraded when the OS accepts the watch', () => {
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });

    expect(watcher.isDegraded(root)).toBe(false);
  });

  it('refuses a worktree that is not on disk', () => {
    expect(() => {
      watcher.watch({ worktreePath: join(base, 'no-such-tree'), gitDir: join(root, '.git') });
    }).toThrow(/does not exist/u);
    expect(watcher.watching).toEqual([]);
  });

  it('delivers nothing more once unwatched', async () => {
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    watcher.unwatch(root);
    writeFileSync(join(root, 'src', 'a.txt'), 'edited\n');
    await settle();

    expect(signals).toEqual([]);
    expect(watcher.watching).toEqual([]);
  });

  it('drops a batch that was pending when the target was unwatched', async () => {
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    writeFileSync(join(root, 'src', 'a.txt'), 'edited\n');
    // Long enough for the platform to deliver, short enough that the debounce
    // has not fired: unwatching before delivery would leave nothing to cancel
    // and the assertion would pass without exercising anything.
    await settle(Math.floor(DEBOUNCE_MS / 2));
    watcher.unwatch(root);
    await settle();

    // The consumer must not be handed a signal for a worktree it has already
    // stopped caring about.
    expect(signals).toEqual([]);
  });

  it('watches a worktree once however often it is asked', async () => {
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    await observe();

    writeFileSync(join(root, 'src', 'a.txt'), 'edited\n');
    await settle();

    expect(watcher.watching).toEqual([root]);
    expect(worktreeSignals()).toHaveLength(1);

    // The second call must not have left an untracked watcher behind: only the
    // tracked one is closed, so a duplicate would keep delivering after close.
    watcher.close();
    signals.length = 0;
    writeFileSync(join(root, 'src', 'a.txt'), 'again\n');
    await settle();
    expect(signals).toEqual([]);
  });

  it('keeps two worktrees independent', async () => {
    const other = join(base, 'other');
    execFileSync('git', ['init', '-q', '-b', 'main', other], { stdio: 'pipe' });

    watcher.watch({ worktreePath: root, gitDir: join(root, '.git') });
    watcher.watch({ worktreePath: other, gitDir: join(other, '.git') });
    await observe();

    writeFileSync(join(root, 'src', 'a.txt'), 'edited\n');
    await settle();

    expect(worktreeSignals()).toHaveLength(1);
    expect(worktreeSignals()[0]?.worktreePath).toBe(root);
  });
});
