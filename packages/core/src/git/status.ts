/**
 * Parsing for `git status --porcelain -z`.
 *
 * Separate from its callers because two of them need different things from the
 * same bytes — discovery wants files grouped by what changed about them, and
 * snapshotting wants the paths to restage — and a second parser would be a
 * second place for the rename handling to be wrong.
 */

/** Two-letter status codes that mark a path as conflicted. */
const UNMERGED_CODES: ReadonlySet<string> = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

export interface StatusEntry {
  /** Staged column of the two-letter code; `?` for an untracked path. */
  readonly index: string;
  /** Unstaged column. */
  readonly worktree: string;
  readonly path: string;
  /** Where a rename or copy came from, `null` when the entry is neither. */
  readonly origPath: string | null;
}

/** True when both columns describe a merge that has not been resolved. */
export function isUnmerged(entry: StatusEntry): boolean {
  return UNMERGED_CODES.has(`${entry.index}${entry.worktree}`);
}

export function isUntracked(entry: StatusEntry): boolean {
  return entry.index === '?' && entry.worktree === '?';
}

/**
 * Parse the NUL-separated form into one entry per path.
 *
 * NUL-separated rather than newline, because a path may contain a newline and
 * splitting on one is the classic way to corrupt a file list.
 *
 * A rename or copy occupies two fields — the destination, then the source — so
 * the source is attached to its entry rather than read as the next one.
 *
 * Both columns are consumed, though only the index column is verifiable against
 * current git: porcelain v1 reports a worktree rename as a deletion and an
 * untracked file, with `status.renames` set or not. The worktree branch is
 * therefore untested and untestable here, and it assumes a git that reports
 * `R` in that column would also emit the source field. One that reported `R`
 * alone would make this consume the next entry — the off-by-one it guards
 * against, inverted — so it is defence, not coverage.
 */
export function parseStatus(stdout: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const fields = stdout.split('\0');

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    // Every entry is two status characters, a space, then the path.
    if (field === undefined || field.length < 4) continue;

    const index = field[0]!;
    const worktree = field[1]!;
    const path = field.slice(3);

    const renamed = index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C';
    const origPath = renamed ? (fields[++i] ?? null) : null;

    entries.push({ index, worktree, path, origPath });
  }

  return entries;
}
