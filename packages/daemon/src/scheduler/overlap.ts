import type { ChangeSet } from '@interlock/shared';

/**
 * How much two branches' changes have in common, by path.
 *
 * `file` — both touched one path, counting both ends of a rename: a textual
 * conflict is plausible.
 * `directory` — both touched a file in one directory, or one touched a path the
 * other made a directory of: the shape of a file/directory conflict, and of a
 * semantic one between neighbours.
 * `none` — nothing in common. No textual conflict can come of it, since git
 * conflicts only where both sides changed a path or its parent.
 * `unknown` — a side has no change set to compare, so nothing is ruled out.
 */
export type OverlapTier = 'file' | 'directory' | 'none' | 'unknown';

export interface PairOverlap {
  readonly tier: OverlapTier;
  /** Paths both sides touched, for logs and ranking; empty below `file`. */
  readonly commonFiles: readonly string[];
}

/**
 * Compare two branches' change sets.
 *
 * Each change set is diffed against its branch's merge base with the default
 * branch, not the pair's own. For two branches off the default branch those
 * agree, and for a branch cut from another the change set only grows, so the
 * comparison errs towards overlap — towards merging — which is the safe way to
 * be wrong: a merge is ground truth, and a pair never merged is a conflict never
 * looked for.
 */
export function pairOverlap(a: ChangeSet | null, b: ChangeSet | null): PairOverlap {
  if (a === null || b === null) return { tier: 'unknown', commonFiles: [] };

  const pathsA = pathsOf(a);
  const pathsB = pathsOf(b);
  const commonFiles = [...pathsA].filter((path) => pathsB.has(path)).sort();
  if (commonFiles.length > 0) return { tier: 'file', commonFiles };

  const dirsB = directoriesOf(pathsB);
  const sharedDir = [...directoriesOf(pathsA)].some((dir) => dirsB.has(dir));
  // A file on one side where the other has a directory: `d` against `d/x`.
  // Each side's ancestors built once: inside the callbacks they would be
  // rebuilt per path, quadratic in the size of a large refactor.
  const ancestorsA = ancestorsOf(pathsA);
  const ancestorsB = ancestorsOf(pathsB);
  const fileMeetsDir =
    [...pathsA].some((path) => ancestorsB.has(path)) ||
    [...pathsB].some((path) => ancestorsA.has(path));
  if (sharedDir || fileMeetsDir) return { tier: 'directory', commonFiles: [] };

  return { tier: 'none', commonFiles: [] };
}

/** Every path a change set touches, both ends of a rename included. */
function pathsOf(changeSet: ChangeSet): Set<string> {
  const paths = new Set<string>();
  for (const file of changeSet.files) {
    paths.add(file.path);
    if (file.previousPath !== null) paths.add(file.previousPath);
  }
  return paths;
}

/**
 * The directories paths sit in, the repository root left out: every
 * repository's top-level files share it, and a tier every pair reaches ranks
 * nothing.
 */
function directoriesOf(paths: ReadonlySet<string>): Set<string> {
  return new Set([...paths].map(parentOf).filter((dir) => dir !== ''));
}

/** The directory a path sits in; `''` for the repository root. */
function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function ancestorsOf(paths: ReadonlySet<string>): Set<string> {
  const ancestors = new Set<string>();
  for (const path of paths) {
    for (let dir = parentOf(path); dir !== ''; dir = parentOf(dir)) ancestors.add(dir);
  }
  return ancestors;
}
