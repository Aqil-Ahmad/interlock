/**
 * Git layer: discovery, worktrees, shadow operations, diff extraction.
 *
 * Invariant for this directory: operations against a user repository are
 * read-only. Anything that writes — commits, checkouts, merges — targets the
 * shadow clone under Interlock's data dir. The handle types encode that split
 * so a write against a user path does not typecheck.
 */
export * from './repo-handle.js';
export * from './discovery.js';
export * from './worktree.js';
export * from './shadow.js';
export * from './diff.js';
