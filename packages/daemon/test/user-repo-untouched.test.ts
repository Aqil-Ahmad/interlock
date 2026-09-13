import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, resolveConfig } from '@interlock/shared';
import type { BranchRef } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureState, describeDiff, diffState } from '../../core/test/support/repo-state.js';
import { createDaemon } from '../src/daemon.js';
import type { Daemon } from '../src/daemon.js';
import { openStore } from '../src/store/index.js';

/**
 * The running daemon leaves a watched repository byte-identical.
 *
 * The daemon runs no git of its own — it composes the functions the core suite
 * already drives against every awkward state — so what this proves is the
 * composition: that the watcher, the sweep and the snapshot pipeline, wired
 * together and reacting to a real edit, sneak nothing in. Same hasher, same
 * allowance for the object store, same diagnosis on failure.
 *
 * The edit is the test's own, so the diff is asserted to be exactly that edit:
 * the one file the test wrote, and nothing else anywhere.
 */

describe('the daemon never modifies a user repository', () => {
  let base: string;
  let dataDir: string;
  let root: string;
  let linked: string;
  let daemon: Daemon;

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  const branches = async (): Promise<BranchRef[]> => {
    const store = await openStore({ path: join(dataDir, 'interlock.db') });
    try {
      const all: BranchRef[] = [];
      for (const repo of await store.listRepos())
        all.push(...(await store.listBranchRefs(repo.id)));
      return all;
    } finally {
      await store.close();
    }
  };

  const until = async (probe: () => Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (!(await probe())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-daemon-untouched-')));
    dataDir = join(base, 'data');
    root = join(base, 'repo');
    linked = join(base, 'feature');
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
    git(root, 'config', 'user.name', 'Interlock Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    // No detached `maintenance run --auto` after the fixture's own commits: it
    // holds `objects/maintenance.lock` after `commit` returns, and a capture
    // that sees it would blame the daemon for a lock the fixture's git left.
    git(root, 'config', 'maintenance.auto', 'false');
    git(root, 'config', 'gc.auto', '0');
    writeFileSync(join(root, 'a.txt'), 'a\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'one');
    git(root, 'worktree', 'add', '-q', '-b', 'feature', linked);
    // Already dirty when the daemon first looks, so the startup pass snapshots
    // real uncommitted work rather than a clean tree.
    writeFileSync(join(root, 'a.txt'), 'staged\n');
    git(root, 'add', 'a.txt');
    writeFileSync(join(linked, 'a.txt'), 'edited in the linked worktree\n');
    writeFileSync(join(linked, 'untracked.txt'), 'new\n');

    daemon = createDaemon({
      config: resolveConfig({ dataDir, repos: [root], daemon: { port: 0 } }),
      logger: createLogger('test', { level: 'error', sink: () => undefined }),
      sweepIntervalMs: 200,
    });
  });

  afterEach(async () => {
    await daemon.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('leaves both worktrees and the shared git dir byte-identical across start, edit and stop', async () => {
    const beforeRoot = captureState(root);
    const beforeLinked = captureState(linked);

    await daemon.start();
    await until(async () => {
      const all = await branches();
      return all.length === 2 && all.every((b) => b.dirty?.snapshotId != null);
    }, 'the startup pass to snapshot both worktrees');

    // The signal path: an edit lands, the watcher marks the worktree, the
    // sweep captures it. This is the test's own write, and the only one. The
    // id is read before the write, not after: a sweep quick enough to land in
    // between would make "changed since" true before anything was waited for.
    const stampedBefore = (await branches()).find((b) => b.name === 'feature')?.dirty?.snapshotId;
    writeFileSync(join(linked, 'a.txt'), 'edited again\n');
    await until(async () => {
      const feature = (await branches()).find((b) => b.name === 'feature');
      const stamped = feature?.dirty?.snapshotId ?? null;
      return stamped !== null && stamped !== stampedBefore;
    }, 'the edit to be snapshotted');

    await daemon.stop();

    const afterRoot = captureState(root);
    const rootDiff = diffState(beforeRoot, afterRoot);
    expect(rootDiff, describeDiff(rootDiff, beforeRoot, afterRoot)).toStrictEqual({
      changed: [],
      removed: [],
      added: [],
    });

    const afterLinked = captureState(linked);
    const linkedDiff = diffState(beforeLinked, afterLinked);
    // Exactly the edit, and nothing beside it.
    expect(linkedDiff, describeDiff(linkedDiff, beforeLinked, afterLinked)).toStrictEqual({
      changed: ['a.txt'],
      removed: [],
      added: [],
    });
  });
});
