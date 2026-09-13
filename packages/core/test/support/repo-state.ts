import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * A byte-for-byte account of a repository, so a run can be proven to have left
 * it alone.
 *
 * A list of files git might write is a guess at what nobody thought of, and the
 * point is to catch what nobody thought of. So this walks everything: the
 * worktree, and everything under the git directory — the index, every ref
 * loose or packed, every reflog, `ORIG_HEAD` and `MERGE_HEAD` and `FETCH_HEAD`,
 * the config, the stash, a rebase in progress, submodule git dirs — and records
 * content, mode and mtime for each.
 *
 * Two places are allowed to grow, and only two: loose objects under
 * `objects/xx/` and packs under `objects/pack/`. That is what a snapshot writes
 * and what the object store's append-only contract covers — `gc` reclaims what
 * nothing references, and a new object changes no existing byte. Nothing else
 * under `objects/` is covered by it: `objects/info/alternates` redirects where
 * git reads objects from, a `tmp_obj_*` left at the top is a write that never
 * finished, and a lock file is a lock file. The allowance enumerates what is
 * legitimate rather than exempting the directory, for the same reason the walk
 * covers everything rather than a list. An object that changed or vanished is
 * still a write.
 *
 * One more thing is allowed there, and it was found by this suite rather than
 * anticipated: writing an object that already exists makes git `utime` the
 * existing file — `freshen_loose_object`, so that `gc --prune=<time>` does not
 * reap an object something just referenced again. Content, mode and size of an
 * object are still held to the byte; its mtime is git's to move.
 */

export interface FileState {
  /** SHA-256 of the content, or of the link target for a symlink. */
  readonly digest: string;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly size: number;
}

/** Every path, relative to the root it was captured from, with its state. */
export type RepoState = ReadonlyMap<string, FileState>;

export interface StateDiff {
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  /** Paths that appeared. Legitimate only under `objects/`. */
  readonly added: readonly string[];
}

/**
 * Capture the state of a directory tree.
 *
 * `lstat`, so a symlink is recorded as a link to a target rather than followed
 * — following one would record the state of something outside the tree, and
 * replacing a link with a copy of its target would go unnoticed.
 *
 * The tree is assumed quiescent: nothing writing while this walks. A capture
 * racing a writer throws on a file that vanished between `readdir` and `lstat`,
 * which is the right failure — loud, and pointing at the writer — rather than
 * a diff that blames whichever side the race landed on.
 */
export function captureState(root: string): RepoState {
  const state = new Map<string, FileState>();
  walk(root, root, state);
  return state;
}

function walk(root: string, directory: string, state: Map<string, FileState>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const rel = relative(root, path);
    const stat = lstatSync(path);

    if (entry.isDirectory()) {
      walk(root, path, state);
      continue;
    }

    const digest = createHash('sha256');
    if (entry.isSymbolicLink()) digest.update(`link:${readlinkSync(path)}`);
    else if (entry.isFile()) digest.update(readFileSync(path));
    else digest.update(`special:${String(stat.mode)}`);

    state.set(rel, {
      digest: digest.digest('hex'),
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  }
}

/**
 * What changed between two captures of the same tree.
 *
 * `objects/` under a git directory is the one place additions are not
 * reported: a snapshot writes there by design. Everything else that appears
 * is a write.
 */
export function diffState(before: RepoState, after: RepoState): StateDiff {
  const changed: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];

  for (const [path, was] of before) {
    const now = after.get(path);
    if (now === undefined) {
      removed.push(path);
      continue;
    }
    if (!same(was, now, isObject(path))) changed.push(path);
  }
  for (const path of after.keys()) {
    if (!before.has(path) && !isObject(path)) added.push(path);
  }

  return {
    changed: changed.sort(),
    removed: removed.sort(),
    added: added.sort(),
  };
}

/** Byte-for-byte, and time-for-time unless git is allowed to freshen this one. */
function same(a: FileState, b: FileState, freshenable: boolean): boolean {
  return (
    a.digest === b.digest &&
    a.mode === b.mode &&
    a.size === b.size &&
    (freshenable || a.mtimeMs === b.mtimeMs)
  );
}

/**
 * A loose object or a pack in the object store of the git dir, or of a
 * submodule's under `modules/`.
 *
 * Anchored on `.git` so a worktree directory that happens to be called
 * `objects` is not mistaken for one, and on the last `objects` segment so a
 * submodule named `objects` does not shift the match. Only the two shapes git
 * writes for an object qualify; `info/`, a top-level temp file and a lock are
 * not objects and get no allowance.
 */
function isObject(path: string): boolean {
  const parts = path.split(sep);
  if (parts[0] !== '.git') return false;
  const index = parts.lastIndexOf('objects');
  if (index === -1) return false;
  const bucket = parts[index + 1] ?? '';
  return parts.length > index + 2 && (bucket === 'pack' || /^[0-9a-f]{2}$/u.test(bucket));
}

/**
 * The diff as a diagnosis rather than a boolean.
 *
 * When this fails the first question is what wrote, so the output is the list
 * of paths, grouped by what happened to them, with the state on each side for
 * a path that changed.
 */
export function describeDiff(diff: StateDiff, before: RepoState, after: RepoState): string {
  const lines: string[] = [];
  for (const path of diff.changed) {
    const was = before.get(path);
    const now = after.get(path);
    lines.push(`changed  ${path}`);
    if (was !== undefined && now !== undefined) {
      if (was.digest !== now.digest)
        lines.push(`           content ${was.digest.slice(0, 12)} → ${now.digest.slice(0, 12)}`);
      if (was.mode !== now.mode)
        lines.push(`           mode ${was.mode.toString(8)} → ${now.mode.toString(8)}`);
      if (was.mtimeMs !== now.mtimeMs)
        lines.push(`           mtime ${String(was.mtimeMs)} → ${String(now.mtimeMs)}`);
      if (was.size !== now.size)
        lines.push(`           size ${String(was.size)} → ${String(now.size)}`);
    }
  }
  for (const path of diff.removed) lines.push(`removed  ${path}`);
  for (const path of diff.added) lines.push(`added    ${path}`);
  return lines.join('\n');
}

export function isClean(diff: StateDiff): boolean {
  return diff.changed.length === 0 && diff.removed.length === 0 && diff.added.length === 0;
}
