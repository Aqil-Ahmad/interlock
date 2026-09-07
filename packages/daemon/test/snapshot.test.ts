import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  ): { sweep: Sweep; hashes: () => number } => {
    let hashes = 0;
    const real = createGitRunner();
    return {
      hashes: () => hashes,
      sweep: createSweep({
        store,
        bus,
        dataDir: join(base, 'data'),
        ...options,
        runner: {
          run: (repo, args, runOptions) => {
            if (args[0] === 'write-tree') hashes += 1;
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

  it('does not hash a worktree nothing reported changing', async () => {
    await sweep.reconcile(root);
    events.length = 0;

    // The edit is real, but no signal named this worktree. Hashing every one on
    // every timed pass is the whole of the daemon's idle cost — measured at
    // about half a second per ten thousand files — and it buys only the changes
    // the filesystem failed to report, which the ceiling catches instead.
    writeFileSync(join(root, 'a.txt'), 'edited\n');
    await sweep.reconcile(root);

    expect(snapshots()).toEqual([]);
  });

  it('consumes the mark, so one signal does not hash for ever', async () => {
    const { sweep: counting, hashes } = countingSweep();
    counting.markChanged(root);
    await counting.reconcile(root);
    const afterFirst = hashes();

    // A mark that is never consumed makes every later pass hash again, which is
    // the whole idle cost coming back for one edit.
    writeFileSync(join(root, 'a.txt'), 'edited\n');
    await counting.reconcile(root);

    expect(hashes()).toBe(afterFirst);
    expect(snapshots().filter((snapshot) => snapshot.treeOid !== null)).toHaveLength(1);
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
