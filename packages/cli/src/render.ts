import type { BranchRef, Repo } from '@interlock/shared';

/**
 * Turning what the daemon reports into something a terminal can show.
 *
 * Kept apart from the command and from the client because it is a pure function
 * of the data: the suite asserts on what is rendered without a daemon, a socket
 * or a repository anywhere near it.
 */

/** What is known about a branch's worktree, which is three states rather than two. */
export type BranchState = 'clean' | 'dirty' | 'unknown';

export interface RenderOptions {
  /** Files listed under one branch before the rest are summarised. */
  readonly fileLimit?: number;
}

/**
 * Files shown per branch before the rest become a count.
 *
 * A branch that touched two thousand files is a real thing an agent does, and
 * printing all of them buries every other branch in the report.
 */
const DEFAULT_FILE_LIMIT = 10;

/**
 * Whether a code point must never reach a terminal verbatim.
 *
 * Paths here are repository content — an untracked file is named by whoever
 * writes the repository, and the agents Interlock watches write repositories.
 * An escape sequence in a path moves the cursor, clears the screen or sets a
 * colour that outlives the process; the bidi controls reorder what is displayed,
 * so the name shown is not the name on disk. Both are `wrapUntrusted`'s
 * reasoning one layer down, with the terminal as the boundary.
 *
 * Scanned rather than matched against a character class, for the reason the
 * glob matcher scans: the input is chosen by the repository, and a predicate
 * can say why each range is here where a dense class cannot.
 */
function unsafe(point: number): boolean {
  return (
    // C0, which is where ESC lives, and with it every terminal sequence.
    point < 0x20 ||
    point === 0x7f ||
    // C1. Rarely sent deliberately, still acted on by terminals that decode it.
    (point >= 0x80 && point <= 0x9f) ||
    // Directional marks, embeddings, overrides and isolates: the trojan-source
    // family, which changes the reading order without changing the bytes.
    point === 0x200e ||
    point === 0x200f ||
    (point >= 0x202a && point <= 0x202e) ||
    (point >= 0x2066 && point <= 0x2069)
  );
}

/** Render a string inert, keeping it readable rather than dropping it. */
export function safeText(value: string): string {
  let out = '';
  // Iterated by code point rather than by unit, so a surrogate pair is never
  // split into two halves that escape separately.
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (!unsafe(point)) {
      out += character;
      continue;
    }
    out +=
      point <= 0xff ? `\\x${point.toString(16).padStart(2, '0')}` : `\\u{${point.toString(16)}}`;
  }
  return out;
}

/**
 * Whether a branch's worktree is clean, dirty, or was not readable.
 *
 * `null` is the third state and never folds into the first: an unreachable
 * worktree reported as clean is the one display that is actively misleading,
 * because "nothing to see" is exactly wrong about work nobody could look at.
 */
export function branchState(branch: BranchRef): BranchState {
  if (branch.dirty === null) return 'unknown';
  return branch.dirty.isDirty ? 'dirty' : 'clean';
}

export interface RepoView {
  readonly repo: Repo;
  readonly branches: readonly BranchRef[];
}

/** The touched files of a branch, grouped as git groups them. */
function touched(branch: BranchRef): { label: string; paths: readonly string[] }[] {
  if (branch.dirty === null) return [];
  return [
    { label: 'staged', paths: branch.dirty.stagedFiles },
    { label: 'unstaged', paths: branch.dirty.unstagedFiles },
    { label: 'untracked', paths: branch.dirty.untrackedFiles },
  ].filter((group) => group.paths.length > 0);
}

function fileCount(branch: BranchRef): number {
  return touched(branch).reduce((total, group) => total + group.paths.length, 0);
}

/** The human report. Wide fields are padded; nothing is truncated but the file list. */
export function renderStatus(views: readonly RepoView[], options: RenderOptions = {}): string {
  if (views.length === 0) {
    return [
      'No repositories are being watched.',
      '',
      'Add one to the `repos` list in the daemon configuration and restart it.',
      '',
    ].join('\n');
  }

  const limit = options.fileLimit ?? DEFAULT_FILE_LIMIT;
  const lines: string[] = [];

  for (const [index, view] of views.entries()) {
    if (index > 0) lines.push('');
    lines.push(
      `${safeText(view.repo.rootPath)}  (default ${safeText(view.repo.defaultBranch)})`,
      '',
    );

    if (view.branches.length === 0) {
      lines.push('  no branches');
      continue;
    }

    const width = Math.max(...view.branches.map((branch) => safeText(branch.name).length));
    for (const branch of view.branches) {
      const state = branchState(branch);
      const count = fileCount(branch);
      // The count is omitted at zero rather than printed, which is what keeps a
      // worktree nobody could read from reporting `0 files` — that reads as
      // "nothing changed" where the truth is "not known". A clean branch says
      // nothing about a count for the same reason: there is nothing to count.
      const suffix = count === 0 ? '' : `  ${String(count)} file${count === 1 ? '' : 's'}`;
      lines.push(`  ${safeText(branch.name).padEnd(width)}  ${state}${suffix}`);

      if (state === 'unknown') {
        lines.push(`  ${' '.repeat(width)}  worktree could not be read`);
        continue;
      }
      for (const group of touched(branch)) {
        for (const path of group.paths.slice(0, limit)) {
          lines.push(`  ${' '.repeat(width)}    ${group.label.padEnd(9)} ${safeText(path)}`);
        }
        const hidden = group.paths.length - limit;
        if (hidden > 0) {
          lines.push(`  ${' '.repeat(width)}    ${' '.repeat(9)} … and ${String(hidden)} more`);
        }
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * The same facts, for something that is not a person.
 *
 * `JSON.stringify` escapes every control character it emits, so this needs no
 * sanitising of its own — and it must not do any, since a consumer wants the
 * path that is on disk rather than one made safe for a screen.
 */
export function renderJson(views: readonly RepoView[]): string {
  return `${JSON.stringify(
    {
      repos: views.map((view) => ({
        id: view.repo.id,
        rootPath: view.repo.rootPath,
        defaultBranch: view.repo.defaultBranch,
        branches: view.branches.map((branch) => ({
          name: branch.name,
          ref: branch.ref,
          headSha: branch.headSha,
          state: branchState(branch),
          worktreePath: branch.worktreePath,
          fileCount: branch.dirty === null ? null : fileCount(branch),
          files:
            branch.dirty === null
              ? null
              : {
                  staged: branch.dirty.stagedFiles,
                  unstaged: branch.dirty.unstagedFiles,
                  untracked: branch.dirty.untrackedFiles,
                },
        })),
      })),
    },
    null,
    2,
  )}\n`;
}
