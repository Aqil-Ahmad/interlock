import { describe, it } from 'vitest';

/**
 * Asserts that a full Interlock run leaves watched repositories byte-identical.
 *
 * Interlock watches repositories people are actively working in, so a stray
 * checkout or a touched index destroys uncommitted work that exists nowhere
 * else. This test is the backstop for that.
 *
 * Shape, once discovery and the merge engine exist:
 *  1. build a fixture repo with several worktrees — some dirty, some with
 *     staged-but-uncommitted changes and untracked files;
 *  2. hash everything observable: file contents, modes and mtimes, plus
 *     `.git/index`, `.git/HEAD`, `.git/refs/**`, `.git/config`, `packed-refs`,
 *     stash and reflog;
 *  3. run a full cycle — discovery, snapshot, speculative merge, analyzers;
 *  4. re-hash and assert equality.
 *
 * Left as `todo` rather than deleted so the gap shows in every test run.
 */
describe('user repositories are never modified', () => {
  it.todo('leaves file contents, modes and mtimes unchanged after a full run');
  it.todo('leaves .git/index, HEAD, refs, config and packed-refs unchanged');
  it.todo('leaves the stash and reflog unchanged');
  it.todo('does not create branches, tags or worktrees in the user repo');
  it.todo('holds no lock files in the user repo after the run');
});
