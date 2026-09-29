import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRunner } from '@interlock/core';
import { createLogger } from '@interlock/shared';
import type { LogRecord } from '@interlock/shared';
import type { InterlockEvent } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/bus/index.js';
import { openStore } from '../src/store/index.js';
import type { Store } from '../src/store/index.js';
import { createSweep } from '../src/watcher/sweep.js';
import type { Sweep } from '../src/watcher/sweep.js';

/**
 * The snapshot pipeline through the sweep that drives it, against real
 * repositories: whether two worktrees hash to the same tree is a property of
 * git, and a fixture that stubbed it would be asserting its own arithmetic.
 */

describe('snapshot pipeline', () => {
  let base: string;
  let root: string;
  let store: Store;
  let bus: EventBus;
  let sweep: Sweep;
  let events: InterlockEvent[];

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  const snapshots = (): Extract<InterlockEvent, { type: 'branch.snapshot' }>[] =>
    events.filter(
      (event): event is Extract<InterlockEvent, { type: 'branch.snapshot' }> =>
        event.type === 'branch.snapshot',
    );

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-snap-')));
    root = join(base, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
    git(root, 'config', 'user.name', 'Interlock Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'a.txt'), 'a\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'one');

    events = [];
    bus = new EventBus({ logger: createLogger('test', { level: 'error', sink: () => undefined }) });
    bus.onAny((event) => {
      events.push(event);
    });
    store = await openStore({ path: ':memory:' });
    sweep = createSweep({ store, bus, runner: createGitRunner(), dataDir: join(base, 'data') });
  });

  afterEach(async () => {
    await store.close();
    rmSync(base, { recursive: true, force: true });
  });

  /**
   * A sweep that counts how often a worktree was hashed.
   *
   * One hash is one `write-tree`, and nothing else in a pass runs it — so the
   * count says whether the walk happened, which no event can: a hash that finds
   * the same tree publishes nothing at all.
   */
  const countingSweep = (
    options: { recaptureAfterMs?: number; now?: () => number } = {},
  ): { sweep: Sweep; hashes: () => number; walks: () => number } => {
    let hashes = 0;
    let walks = 0;
    const real = createGitRunner();
    return {
      hashes: () => hashes,
      // `add -A` is where a capture reads every file, and where one it cannot
      // read makes it fail, before any `write-tree`.
      walks: () => walks,
      sweep: createSweep({
        store,
        bus,
        dataDir: join(base, 'data'),
        ...options,
        runner: {
          run: (repo, args, runOptions) => {
            if (args[0] === 'write-tree') hashes += 1;
            if (args[0] === 'add') walks += 1;
            return real.run(repo, args, runOptions);
          },
        },
      }),
    };
  };

  it('publishes a snapshot carrying a tree and a change set', async () => {
    await sweep.reconcile(root);

    expect(snapshots()).toHaveLength(1);
    const [snapshot] = snapshots();
    expect(snapshot?.treeOid).toMatch(/^[0-9a-f]{40,64}$/u);
    expect(snapshot?.changeSetId).not.toBeNull();

    const stored = await store.getChangeSet(snapshot!.changeSetId!);
    expect(stored).not.toBeNull();
    // The change set records which snapshot it was computed from, so a result
    // can be traced back to the exact content that produced it.
    expect(stored?.snapshotId).not.toBeNull();
  });

  it('says nothing when a rewrite leaves the content identical', async () => {
    await sweep.reconcile(root);
    events.length = 0;

    // What an editor does on save, and what an agent does when it rewrites a
    // file it did not really change: same bytes, new mtime. The signal arrives
    // and is believed — the hash is what disagrees with it.
    writeFileSync(join(root, 'a.txt'), 'a\n');
    sweep.markChanged(root);
    await sweep.reconcile(root);

    expect(snapshots()).toEqual([]);
  });

  it('does not hash a worktree whose probe says nothing moved', async () => {
    const { sweep: counting, hashes } = countingSweep();
    await counting.reconcile(root);
    const afterFirst = hashes();

    // Nothing written and nothing reported. Hashing every worktree on every
    // timed pass is the whole of the daemon's idle cost — about half a second
    // per ten thousand files — and the probe is what spares it.
    await counting.reconcile(root);
    await counting.reconcile(root);

    expect(hashes()).toBe(afterFirst);
  });

  it('finds an edit nothing reported, on the next pass', async () => {
    await sweep.reconcile(root);
    events.length = 0;

    // The filesystem event never came. The probe reads what the pass's status
    // already listed, so the edit is found here rather than at the backstop.
    writeFileSync(join(root, 'a.txt'), 'edited\n');
    await sweep.reconcile(root);

    expect(snapshots()).toHaveLength(1);
  });

  it('consumes the mark, so one signal does not hash for ever', async () => {
    const { sweep: counting, hashes } = countingSweep();
    await counting.reconcile(root);
    counting.markChanged(root);
    await counting.reconcile(root);
    const afterMarked = hashes();

    // A mark that is never consumed makes every later pass hash again, which is
    // the whole idle cost coming back for one signal.
    await counting.reconcile(root);

    expect(hashes()).toBe(afterMarked);
  });

  describe('the probe', () => {
    /** One pass with nothing reported, as the timer runs it, and what it published. */
    const timedPass = async (using: Sweep = sweep): Promise<number> => {
      events.length = 0;
      await using.reconcile(root);
      return snapshots().length;
    };

    beforeEach(async () => {
      await sweep.reconcile(root);
    });

    it('moves for a second edit to a file that is already modified', async () => {
      writeFileSync(join(root, 'a.txt'), 'edited\n');
      expect(await timedPass()).toBe(1);

      // `status` prints exactly what it printed before: a.txt, modified. Only
      // the file's own timestamps and size say it was written again.
      writeFileSync(join(root, 'a.txt'), 'edited once more\n');
      expect(await timedPass()).toBe(1);
    });

    it('moves for a file written and staged between two passes', async () => {
      // An agent's `git add` straight after writing: by the next pass nothing
      // is unstaged or untracked, and the change is visible only as staged.
      writeFileSync(join(root, 'staged.txt'), 'new, and staged at once\n');
      git(root, 'add', 'staged.txt');
      expect(await timedPass()).toBe(1);

      // And a tracked file edited and re-staged, which stays `M ` throughout.
      writeFileSync(join(root, 'a.txt'), 'edited and staged\n');
      git(root, 'add', 'a.txt');
      expect(await timedPass()).toBe(1);
      writeFileSync(join(root, 'a.txt'), 'edited and staged again\n');
      git(root, 'add', 'a.txt');
      expect(await timedPass()).toBe(1);
    });

    it('moves for a new untracked file', async () => {
      writeFileSync(join(root, 'new.txt'), 'new\n');
      expect(await timedPass()).toBe(1);
    });

    it('moves for an edit inside a directory nothing tracks', async () => {
      mkdirSync(join(root, 'fresh'));
      writeFileSync(join(root, 'fresh', 'one.txt'), 'one\n');
      expect(await timedPass()).toBe(1);

      // A collapsed listing prints `fresh/` both times, and the directory's
      // own timestamps do not move when a file inside it is rewritten.
      writeFileSync(join(root, 'fresh', 'one.txt'), 'one, then more\n');
      expect(await timedPass()).toBe(1);
    });

    it('moves for a rewrite that puts the modification time back', async () => {
      // Pinned to a whole second on both sides: `utimes` keeps milliseconds and
      // the filesystem more, so a time read back and restored would differ in
      // the part it dropped, and the test would pass for the wrong reason.
      const pinned = new Date(1_700_000_000_000);
      writeFileSync(join(root, 'a.txt'), 'edited\n');
      utimesSync(join(root, 'a.txt'), pinned, pinned);
      expect(await timedPass()).toBe(1);
      const before = statSync(join(root, 'a.txt'));

      // Same size, same mtime, same inode: a tool restoring timestamps after
      // writing. ctime is the one field a write cannot set back.
      writeFileSync(join(root, 'a.txt'), 'EDITED\n');
      utimesSync(join(root, 'a.txt'), pinned, pinned);
      const after = statSync(join(root, 'a.txt'));
      expect([after.mtimeMs, after.size, after.ino]).toEqual([
        before.mtimeMs,
        before.size,
        before.ino,
      ]);
      expect(await timedPass()).toBe(1);
    });

    it('still finds, at the backstop, an edit status cannot see', async () => {
      // The one hole left: a clean tracked file rewritten at the same size
      // with its mtime put back, in a repository that told git not to trust
      // ctime. The index is refreshed first with an old mtime, so git's own
      // racy-timestamp check does not rescue it.
      git(root, 'config', 'core.trustctime', 'false');
      const old = new Date(1_600_000_000_000);
      utimesSync(join(root, 'a.txt'), old, old);
      git(root, 'update-index', '--refresh');
      let clock = 1_000_000;
      const late = createSweep({
        store,
        bus,
        runner: createGitRunner(),
        dataDir: join(base, 'data'),
        recaptureAfterMs: 10_000,
        now: () => clock,
      });
      await late.reconcile(root);

      writeFileSync(join(root, 'a.txt'), 'b\n');
      utimesSync(join(root, 'a.txt'), old, old);
      expect(git(root, 'status', '--porcelain')).toBe('');
      clock += 5_000;
      expect(await timedPass(late)).toBe(0);

      clock += 5_000;
      expect(await timedPass(late)).toBe(1);
    });

    it('does not walk a worktree again at a failure it has already met', async () => {
      const { sweep: counting, walks } = countingSweep();
      await counting.reconcile(root);
      writeFileSync(join(root, 'locked.txt'), 'secret\n');
      chmodSync(join(root, 'locked.txt'), 0o000);
      try {
        await expect(counting.reconcile(root)).rejects.toThrow();
        const afterFailure = walks();

        // Still failing — the pass says so — but without reading every file
        // to find out again what one unreadable file already said.
        await expect(counting.reconcile(root)).rejects.toThrow();
        await expect(counting.reconcile(root)).rejects.toThrow();
        expect(walks()).toBe(afterFailure);
      } finally {
        chmodSync(join(root, 'locked.txt'), 0o644);
      }

      // Fixing the permission moves the file's ctime, which is the retry.
      events.length = 0;
      await counting.reconcile(root);
      expect(snapshots()).toHaveLength(1);
    });

    it('holds still for a file that is gone, rather than moving every pass', async () => {
      const { sweep: counting, hashes } = countingSweep();
      await counting.reconcile(root);
      // A tracked file deleted: `status` lists it, and there is nothing to stat.
      rmSync(join(root, 'a.txt'));
      events.length = 0;
      await counting.reconcile(root);
      expect(snapshots()).toHaveLength(1);
      const afterDelete = hashes();

      await counting.reconcile(root);
      await counting.reconcile(root);

      expect(hashes()).toBe(afterDelete);
    });

    it('walks again at a failure once the head under it moves', async () => {
      const { sweep: counting, walks } = countingSweep();
      await counting.reconcile(root);
      writeFileSync(join(root, 'locked.txt'), 'secret\n');
      chmodSync(join(root, 'locked.txt'), 0o000);
      try {
        await expect(counting.reconcile(root)).rejects.toThrow();
        const afterFailure = walks();

        // Nothing in the worktree moved, so the probe reads the same; the
        // content it would hash sits on another commit now.
        git(root, 'commit', '-qm', 'moves the head only', '--allow-empty');
        await expect(counting.reconcile(root)).rejects.toThrow();

        expect(walks()).toBe(afterFailure + 1);
      } finally {
        chmodSync(join(root, 'locked.txt'), 0o644);
      }
    });

    it('walks again at a failure for another branch on the same commit', async () => {
      const { sweep: counting, walks } = countingSweep();
      await counting.reconcile(root);
      writeFileSync(join(root, 'locked.txt'), 'secret\n');
      chmodSync(join(root, 'locked.txt'), 0o000);
      try {
        await expect(counting.reconcile(root)).rejects.toThrow();
        const afterFailure = walks();

        // Same worktree, same files, same head: only the branch is new, and it
        // has never been captured, so the old branch's failure is not its own.
        git(root, 'checkout', '-q', '-b', 'switched');
        await expect(counting.reconcile(root)).rejects.toThrow();

        expect(walks()).toBe(afterFailure + 1);
      } finally {
        chmodSync(join(root, 'locked.txt'), 0o644);
      }
    });

    it('walks again at a failure that went away on its own, at the next pass', async () => {
      // git timing out under load: nothing on disk moves, and the next walk
      // would succeed. Holding it to the backstop would miss the budget.
      let clock = 1_000_000;
      let failing = false;
      const real = createGitRunner();
      const flaky = createSweep({
        store,
        bus,
        dataDir: join(base, 'data'),
        now: () => clock,
        runner: {
          run: (repo, args, runOptions) =>
            failing && args[0] === 'add'
              ? Promise.resolve({ stdout: '', stderr: '', exitCode: 128 })
              : real.run(repo, args, runOptions),
        },
      });
      await flaky.reconcile(root);
      writeFileSync(join(root, 'a.txt'), 'edited while git was struggling\n');
      failing = true;
      await expect(flaky.reconcile(root)).rejects.toThrow();

      failing = false;
      clock += 10_000;
      events.length = 0;
      await flaky.reconcile(root);

      expect(snapshots()).toHaveLength(1);
    });

    it('retries a marked capture that failed, though nothing moved the probe', async () => {
      // A signal asked for the walk and the walk failed: the mark is spent, the
      // probe reads as it did, and reusing the old tree on the next pass would
      // drop what the signal reported until the backstop.
      let clock = 1_000_000;
      let failing = false;
      let walks = 0;
      const real = createGitRunner();
      const flaky = createSweep({
        store,
        bus,
        dataDir: join(base, 'data'),
        now: () => clock,
        runner: {
          run: (repo, args, runOptions) => {
            if (args[0] === 'add') walks += 1;
            return failing && args[0] === 'add'
              ? Promise.resolve({ stdout: '', stderr: '', exitCode: 128 })
              : real.run(repo, args, runOptions);
          },
        },
      });
      await flaky.reconcile(root);
      flaky.markChanged(root);
      failing = true;
      await expect(flaky.reconcile(root)).rejects.toThrow();
      const afterFailure = walks;

      failing = false;
      clock += 10_000;
      await flaky.reconcile(root);

      expect(walks).toBe(afterFailure + 1);
    });

    it('backs off a failure that lasts, doubling towards the backstop', async () => {
      let clock = 1_000_000;
      const { sweep: counting, walks } = countingSweep({ now: () => clock });
      await counting.reconcile(root);
      writeFileSync(join(root, 'locked.txt'), 'secret\n');
      chmodSync(join(root, 'locked.txt'), 0o000);
      const walkedAt = async (seconds: number): Promise<boolean> => {
        clock = 1_000_000 + seconds * 1_000;
        const before = walks();
        await expect(counting.reconcile(root)).rejects.toThrow();
        return walks() > before;
      };
      try {
        expect(await walkedAt(0)).toBe(true);
        // Retried after 10 s, then 20 s, then 40 s: each wait twice the last.
        expect(await walkedAt(5)).toBe(false);
        expect(await walkedAt(10)).toBe(true);
        expect(await walkedAt(25)).toBe(false);
        expect(await walkedAt(30)).toBe(true);
        expect(await walkedAt(65)).toBe(false);
        expect(await walkedAt(70)).toBe(true);
      } finally {
        chmodSync(join(root, 'locked.txt'), 0o644);
      }
    });

    it('starts the backoff over for a failure somewhere new', async () => {
      let clock = 1_000_000;
      const { sweep: counting, walks } = countingSweep({ now: () => clock });
      await counting.reconcile(root);
      writeFileSync(join(root, 'locked.txt'), 'secret\n');
      chmodSync(join(root, 'locked.txt'), 0o000);
      const walkedAt = async (seconds: number): Promise<boolean> => {
        clock = 1_000_000 + seconds * 1_000;
        const before = walks();
        await expect(counting.reconcile(root)).rejects.toThrow();
        return walks() > before;
      };
      try {
        expect(await walkedAt(0)).toBe(true);
        expect(await walkedAt(10)).toBe(true);
        // Something else was written: the probe moved, so this is walked at
        // once, fails at the same file, and is a new failure — retried after
        // the first wait again, not after the doubled one.
        writeFileSync(join(root, 'other.txt'), 'other\n');
        expect(await walkedAt(11)).toBe(true);
        expect(await walkedAt(21)).toBe(true);
      } finally {
        chmodSync(join(root, 'locked.txt'), 0o644);
      }
    });

    it('never waits longer than the backstop between walks', async () => {
      let clock = 1_000_000;
      const { sweep: counting, walks } = countingSweep({
        recaptureAfterMs: 15_000,
        now: () => clock,
      });
      await counting.reconcile(root);
      writeFileSync(join(root, 'locked.txt'), 'secret\n');
      chmodSync(join(root, 'locked.txt'), 0o000);
      const walkedAt = async (seconds: number): Promise<boolean> => {
        clock = 1_000_000 + seconds * 1_000;
        const before = walks();
        await expect(counting.reconcile(root)).rejects.toThrow();
        return walks() > before;
      };
      try {
        expect(await walkedAt(0)).toBe(true);
        expect(await walkedAt(10)).toBe(true);
        // Doubled, the next wait would be 20 s; the backstop caps it at 15.
        expect(await walkedAt(25)).toBe(true);
      } finally {
        chmodSync(join(root, 'locked.txt'), 0o644);
      }
    });

    it('walks again at a failure once the backstop is due', async () => {
      let clock = 1_000_000;
      const { sweep: counting, walks } = countingSweep({
        recaptureAfterMs: 10_000,
        now: () => clock,
      });
      await counting.reconcile(root);
      writeFileSync(join(root, 'locked.txt'), 'secret\n');
      chmodSync(join(root, 'locked.txt'), 0o000);
      try {
        await expect(counting.reconcile(root)).rejects.toThrow();
        const afterFailure = walks();
        clock += 5_000;
        await expect(counting.reconcile(root)).rejects.toThrow();
        expect(walks()).toBe(afterFailure);

        clock += 5_000;
        await expect(counting.reconcile(root)).rejects.toThrow();
        expect(walks()).toBe(afterFailure + 1);
      } finally {
        chmodSync(join(root, 'locked.txt'), 0o644);
      }
    });

    it('walks again at a failure once something is reported there', async () => {
      const { sweep: counting, walks } = countingSweep();
      await counting.reconcile(root);
      writeFileSync(join(root, 'locked.txt'), 'secret\n');
      chmodSync(join(root, 'locked.txt'), 0o000);
      try {
        await expect(counting.reconcile(root)).rejects.toThrow();
        const afterFailure = walks();

        counting.markChanged(root);
        await expect(counting.reconcile(root)).rejects.toThrow();

        expect(walks()).toBe(afterFailure + 1);
      } finally {
        chmodSync(join(root, 'locked.txt'), 0o644);
      }
    });

    it('keeps a worktree nobody can read unknown, without flapping or walking', async () => {
      const linked = join(base, 'wt-closed');
      git(root, 'worktree', 'add', '-q', '-b', 'closed', linked);
      const { sweep: counting, walks } = countingSweep();
      await counting.reconcile(root);
      const afterFirst = walks();
      chmodSync(linked, 0o000);
      try {
        events.length = 0;
        for (let pass = 0; pass < 4; pass++) await counting.reconcile(root);

        const unknown = snapshots().filter((snapshot) => snapshot.treeOid === null);
        expect(unknown).toHaveLength(1);
        expect(snapshots()).toHaveLength(1);
        expect(walks()).toBe(afterFirst);
      } finally {
        chmodSync(linked, 0o755);
      }

      // Readable again, it is announced as it is now, on the next pass.
      events.length = 0;
      await counting.reconcile(root);
      expect(snapshots().map((snapshot) => snapshot.treeOid === null)).toEqual([false]);
    });
  });

  it('restarts the ceiling when a hash finds nothing new', async () => {
    // Driven rather than waited on: the window that discriminates here is
    // narrower than a pass takes, so a real clock decides the outcome by how
    // long git happened to run.
    let clock = 1_000;
    const { sweep: counting, hashes } = countingSweep({
      recaptureAfterMs: 100,
      now: () => clock,
    });
    await counting.reconcile(root);

    clock = 1_200;
    counting.markChanged(root);
    await counting.reconcile(root);
    const afterCeiling = hashes();

    // Inside the ceiling measured from the hash that just happened, and outside
    // it measured from the one before — so a clock left where it was expires
    // immediately and every pass from here hashes for ever.
    clock = 1_250;
    await counting.reconcile(root);

    expect(hashes()).toBe(afterCeiling);
  });

  it('hashes anyway once the ceiling has passed', async () => {
    const impatient = createSweep({
      store,
      bus,
      runner: createGitRunner(),
      dataDir: join(base, 'data'),
      recaptureAfterMs: 0,
    });
    await impatient.reconcile(root);
    events.length = 0;

    // A filesystem event the platform dropped leaves nothing to mark, so the
    // ceiling is the only thing that ever notices.
    writeFileSync(join(root, 'a.txt'), 'edited\n');
    await impatient.reconcile(root);

    expect(snapshots()).toHaveLength(1);
  });

  it('publishes exactly one snapshot for a real edit', async () => {
    await sweep.reconcile(root);
    const first = snapshots()[0]?.treeOid;
    events.length = 0;

    writeFileSync(join(root, 'a.txt'), 'edited\n');
    sweep.markChanged(root);
    await sweep.reconcile(root);

    expect(snapshots()).toHaveLength(1);
    expect(snapshots()[0]?.treeOid).not.toBe(first);
    expect(snapshots()[0]?.fileCount).toBeGreaterThan(0);
  });

  it('announces the same tree again when the head it sits on moves', async () => {
    writeFileSync(join(root, 'a.txt'), 'edited\n');
    await sweep.reconcile(root);
    const before = snapshots().at(-1)!;
    events.length = 0;

    // Committing exactly what was on disk moves the head and not the tree.
    git(root, 'commit', '-qam', 'the same work, committed');
    const head = git(root, 'rev-parse', 'HEAD').trim();
    await sweep.reconcile(root);

    expect(snapshots()).toHaveLength(1);
    expect(snapshots()[0]).toMatchObject({ treeOid: before.treeOid, headSha: head });
    expect(before.headSha).not.toBe(head);
  });

  it('hashes a worktree whose head moved, even inside the recapture ceiling', async () => {
    const { sweep: counted, hashes } = countingSweep({ recaptureAfterMs: 60_000 });
    await counted.reconcile(root);
    const after = hashes();

    git(root, 'commit', '-qm', 'empty', '--allow-empty');
    await counted.reconcile(root);

    expect(hashes()).toBe(after + 1);
  });

  it('sees uncommitted work, not just commits', async () => {
    await sweep.reconcile(root);
    events.length = 0;

    // Never added, never committed — the whole point of hashing the worktree
    // rather than reading the branch head.
    writeFileSync(join(root, 'untracked.txt'), 'new\n');
    sweep.markChanged(root);
    await sweep.reconcile(root);

    expect(snapshots()).toHaveLength(1);
    const stored = await store.getChangeSet(snapshots()[0]!.changeSetId!);
    expect(stored?.files.map((file) => file.path)).toContain('untracked.txt');
  });

  it('publishes a null tree for a worktree it cannot read', async () => {
    const linked = join(base, 'wt-gone');
    git(root, 'worktree', 'add', '-q', '-b', 'gone', linked);
    git(root, 'worktree', 'lock', linked);
    rmSync(linked, { recursive: true, force: true });
    events.length = 0;

    await sweep.reconcile(root);

    const unreadable = snapshots().filter((snapshot) => snapshot.treeOid === null);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.changeSetId).toBeNull();
  });

  it('says a worktree is unreadable once, not once per pass', async () => {
    const linked = join(base, 'wt-flaky');
    git(root, 'worktree', 'add', '-q', '-b', 'flaky', linked);
    await sweep.reconcile(root);

    git(root, 'worktree', 'lock', linked);
    rmSync(linked, { recursive: true, force: true });
    events.length = 0;

    for (let pass = 0; pass < 4; pass++) await sweep.reconcile(root);

    // The transition is the news. A worktree on a volume that is gone would
    // otherwise write hundreds of identical rows an hour into a log retention
    // only trims by age — and `moved` in the sweep already reads null to null
    // as no change, so publishing here every pass had the two disagreeing.
    expect(snapshots().filter((snapshot) => snapshot.treeOid === null)).toHaveLength(1);
  });

  it('announces the content again once an unreadable worktree comes back', async () => {
    const linked = join(base, 'wt-flaky');
    git(root, 'worktree', 'add', '-q', '-b', 'flaky', linked);
    await sweep.reconcile(root);
    const before = snapshots().find((snapshot) => snapshot.treeOid !== null)?.treeOid;

    // Unreadable, reversibly: `git status` cannot enter the directory, so the
    // branch is listed with an unknown dirty state rather than dropped.
    chmodSync(linked, 0o000);
    await sweep.reconcile(root);
    chmodSync(linked, 0o755);
    events.length = 0;

    // Byte for byte what it was before the outage. Deduplicating against the
    // tree from before would be silence, and downstream was last told
    // "unknown" — so its view would stay unknown for good.
    await sweep.reconcile(root);

    const recovered = snapshots().filter((snapshot) => snapshot.treeOid !== null);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.treeOid).toBe(before);
  });

  it('carries on when the default branch is not a ref this repository has', async () => {
    // `origin/HEAD` naming a branch nobody fetched, which is ordinary in a
    // worktree-heavy checkout.
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    const records: LogRecord[] = [];
    const tolerant = createSweep({
      store,
      bus,
      runner: createGitRunner(),
      dataDir: join(base, 'data'),
      logger: createLogger('test', { level: 'trace', sink: (record) => records.push(record) }),
    });

    const outcome = await tolerant.all([root]);

    // `mergeBase` raises for a revision it cannot resolve so a pair is never
    // dropped in silence — but failing the whole repository on every pass, for
    // ever, is the worse answer.
    expect(outcome.failed).toEqual([]);
    expect(snapshots()).toHaveLength(1);
    expect(snapshots()[0]?.treeOid).not.toBeNull();
    expect(snapshots()[0]?.changeSetId).toBeNull();
    expect(records.map((record) => record.msg)).toContain(
      'the default branch does not resolve; publishing without a diff',
    );
  });

  it('still fails on a merge-base error that is not a missing ref', async () => {
    const real = createGitRunner();
    const broken = createSweep({
      store,
      bus,
      dataDir: join(base, 'data'),
      runner: {
        run: (repo, args, runOptions) => {
          if (args[0] === 'merge-base') throw new Error('the runner itself broke');
          return real.run(repo, args, runOptions);
        },
      },
    });

    const outcome = await broken.all([root]);

    // Only a revision git cannot resolve is turned into "no diff". Swallowing
    // everything would hide a broken runner behind a snapshot that merely
    // reports having nothing to say.
    expect(outcome.failed).toEqual([root]);
  });

  it('announces a worktree that switched branches with the same content', async () => {
    writeFileSync(join(root, 'a.txt'), 'work in progress\n');
    sweep.markChanged(root);
    await sweep.reconcile(root);
    events.length = 0;

    // The content is byte for byte what it was, so the tree is the same — but
    // it belongs to another branch now, and nothing downstream has ever been
    // told anything about that branch.
    // No `markChanged`: `checkout -b` writes `HEAD` inside the git directory,
    // which the ref watcher sees and the worktree watcher does not — so the
    // gate would skip the hash and the switch would go unnoticed until the
    // ceiling, which is minutes of a branch nobody has heard of.
    git(root, 'checkout', '-q', '-b', 'feature');
    await sweep.reconcile(root);

    expect(snapshots()).toHaveLength(1);
    const [repo] = await store.listRepos();
    const feature = (await store.listBranchRefs(repo!.id)).find(
      (branch) => branch.name === 'feature',
    );
    expect(snapshots()[0]?.branchRefId).toBe(feature?.id);
  });

  it('snapshots every other branch when one of them throws', async () => {
    const linked = join(base, 'wt-feature');
    git(root, 'worktree', 'add', '-q', '-b', 'feature', linked);
    const real = createGitRunner();
    let broken = false;
    const flaky = createSweep({
      store,
      bus,
      dataDir: join(base, 'data'),
      runner: {
        run: (repo, args, runOptions) => {
          // Only the first hash of the pass fails, so the branch after it has
          // something to prove: a throw that escapes the loop leaves it with no
          // snapshot at all.
          if (broken && args[0] === 'write-tree') {
            broken = false;
            throw new Error('one branch is unhappy');
          }
          return real.run(repo, args, runOptions);
        },
      },
    });
    await flaky.all([root]);
    events.length = 0;
    broken = true;

    // Both worktrees have moved and both are marked, so both would be hashed
    // and both have something to announce: without the guard the first throw
    // ends the loop and the second branch is never reached.
    writeFileSync(join(root, 'a.txt'), 'main moved\n');
    writeFileSync(join(linked, 'a.txt'), 'feature moved\n');
    flaky.markChanged(root);
    flaky.markChanged(linked);
    const outcome = await flaky.all([root]);

    // Reported, because a pass that could not snapshot something did not
    // succeed — and a broken runner behind a quiet log line is how that goes
    // unnoticed for a week.
    expect(outcome.failed).toEqual([root]);
    // And the loop ran to the end: the branch after the one that threw was
    // snapshotted, rather than starved on this pass and every pass after it.
    expect(snapshots().filter((snapshot) => snapshot.treeOid !== null)).toHaveLength(1);
  });

  it('announces everything again after a restart', async () => {
    writeFileSync(join(root, 'a.txt'), 'work\n');
    sweep.markChanged(root);
    await sweep.reconcile(root);
    events.length = 0;

    // A new pipeline remembers nothing. Announcing content downstream may
    // already hold is the safe direction — a restarted consumer holds nothing
    // either — and the cost is one hash per worktree, once. Persisting the last
    // tree would buy that back at the price of a cache in the schema.
    const restarted = createSweep({
      store,
      bus,
      runner: createGitRunner(),
      dataDir: join(base, 'data'),
    });
    await restarted.reconcile(root);

    expect(snapshots()).toHaveLength(1);
  });

  it('keeps a mark that arrives while the hash is running', async () => {
    const real = createGitRunner();
    let marking: (() => void) | null = null;
    const racing = createSweep({
      store,
      bus,
      dataDir: join(base, 'data'),
      runner: {
        run: async (repo, args, runOptions) => {
          const result = await real.run(repo, args, runOptions);
          // A signal landing mid-walk describes content the walk may already
          // have passed over, so clearing the mark afterwards would drop it
          // until the ceiling.
          if (args[0] === 'write-tree' && marking !== null) {
            marking();
            marking = null;
          }
          return result;
        },
      },
    });
    racing.markChanged(root);
    await racing.reconcile(root);
    events.length = 0;

    marking = () => {
      writeFileSync(join(root, 'a.txt'), 'landed mid-hash\n');
      racing.markChanged(root);
    };
    racing.markChanged(root);
    await racing.reconcile(root);
    events.length = 0;

    await racing.reconcile(root);

    expect(snapshots()).toHaveLength(1);
  });

  it('says nothing about a branch that is not checked out anywhere', async () => {
    git(root, 'branch', 'feature');
    await sweep.reconcile(root);

    // One worktree, one snapshot: a branch with no checkout has no uncommitted
    // work to hash, and its committed state is already in `branch.updated`.
    expect(snapshots()).toHaveLength(1);
  });

  it('records the snapshot on the branch, so two dirty states are not one identity', async () => {
    writeFileSync(join(root, 'a.txt'), 'dirty\n');
    await sweep.reconcile(root);

    const [repo] = await store.listRepos();
    const [branch] = await store.listBranchRefs(repo!.id);
    // Left null, `contentIdentity` is the head alone and two different dirty
    // states of one commit read as the same content.
    expect(branch?.dirty?.snapshotId).not.toBeNull();
  });

  it('keeps the recorded snapshot when nothing changed', async () => {
    writeFileSync(join(root, 'a.txt'), 'dirty\n');
    await sweep.reconcile(root);
    const [repo] = await store.listRepos();
    const first = (await store.listBranchRefs(repo!.id))[0]?.dirty?.snapshotId;

    await sweep.reconcile(root);

    // The sweep re-lists every branch with a null id, so a deduplicated capture
    // that skipped this would leave the row worse than before it ran.
    expect((await store.listBranchRefs(repo!.id))[0]?.dirty?.snapshotId).toBe(first);
  });

  it('publishes a tree without a diff when there is no common ancestor', async () => {
    const orphan = join(base, 'wt-orphan');
    git(root, 'worktree', 'add', '-q', '--detach', orphan);
    git(orphan, 'checkout', '-q', '--orphan', 'unrelated');
    execFileSync('git', ['-C', orphan, 'rm', '-rqf', '.'], { stdio: 'pipe' });
    writeFileSync(join(orphan, 'only.txt'), 'x\n');
    git(orphan, 'add', '-A');
    git(orphan, 'commit', '-qm', 'unrelated root');
    events.length = 0;

    await sweep.reconcile(root);

    const unrelated = snapshots().filter((snapshot) => snapshot.changeSetId === null);
    // A diff against nothing is not an empty diff; an empty one would read as
    // "this branch changed nothing".
    expect(unrelated).toHaveLength(1);
    expect(unrelated[0]?.treeOid).not.toBeNull();
  });

  it('publishes again after a branch disappears and comes back', async () => {
    const linked = join(base, 'wt-feature');
    git(root, 'worktree', 'add', '-q', '-b', 'feature', linked);
    await sweep.reconcile(root);

    git(root, 'worktree', 'remove', '--force', linked);
    git(root, 'branch', '-D', 'feature');
    await sweep.reconcile(root);
    events.length = 0;

    git(root, 'worktree', 'add', '-q', '-b', 'feature', linked);
    await sweep.reconcile(root);

    // The remembered identity went with the branch, so its content is announced
    // to a downstream that has never heard of it.
    expect(snapshots()).toHaveLength(1);
  });
});
