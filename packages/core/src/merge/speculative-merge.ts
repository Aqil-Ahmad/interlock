import { InterlockError } from '@interlock/shared';
import { assertObjectId, isObjectId, runRequired } from '../git/repo-handle.js';
import type { GitResult, GitRunner, ShadowRepo } from '../git/repo-handle.js';
import { chunkPaths } from '../git/worktree.js';

/**
 * Pairwise speculative merge.
 *
 * Both sides are commits in the shadow clone: a branch head, or a snapshot
 * commit built from uncommitted work, which is what lets a conflict be reported
 * before anything is committed. The merge happens in the object database with
 * `merge-tree --write-tree` — no worktree, no index, no checkout — and a
 * conflicted merge still writes a tree, with markers in the conflicted files,
 * so conflict regions are read out of that tree rather than out of a checkout.
 */

export interface SpeculativeMergeRequest {
  readonly shadow: ShadowRepo;
  readonly commitA: string;
  readonly commitB: string;
  /**
   * The base the pair is merged against, supplied rather than rediscovered.
   *
   * A Finding names the merge base as evidence, and a merge git ran against a
   * base of its own choosing — a virtual one, on criss-cross history — would not
   * be the one it names. Two commits with no common ancestor have no base to
   * put here, which is why they never arrive: `mergeBase` answers null for them.
   */
  readonly mergeBaseSha: string;
}

export interface SpeculativeMergeOptions {
  readonly runner: GitRunner;
}

export interface SpeculativeMergeResult {
  readonly clean: boolean;
  /**
   * The tree git wrote. Where the merge conflicted it is still a tree, holding
   * the conflicted files with markers in them, and it is where
   * {@link conflictBlocks} were read from.
   */
  readonly treeOid: string;
  /** Every path with a conflicted stage, once each, in git's order. */
  readonly conflictedPaths: readonly string[];
  readonly stages: readonly ConflictStage[];
  readonly messages: readonly MergeMessage[];
  /** Regions read from content conflicts; none for a binary one. */
  readonly conflictBlocks: readonly ConflictBlock[];
  /** The whole call, regions included: the cost a pair actually has. */
  readonly durationMs: number;
}

/**
 * One side of a conflicted path, as the index would record it.
 *
 * The paths of one conflict need not agree: a rename on both sides puts the
 * base under the old name and each side under its new one, and a file meeting a
 * directory or a symlink is moved aside to a `<path>~<commit>` name that exists
 * on neither branch.
 */
export interface ConflictStage {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
  /** 1 is the base, 2 is `commitA`, 3 is `commitB`. */
  readonly stage: 1 | 2 | 3;
}

/**
 * One informational message.
 *
 * `type` is the stable token git documents for machine consumption —
 * `CONFLICT (contents)`, `CONFLICT (binary)`, `CONFLICT (rename/rename)` — and
 * is what anything downstream keys on. `text` is prose, reworded between
 * releases, and fit only for showing to a person.
 */
export interface MergeMessage {
  readonly paths: readonly string[];
  readonly type: string;
  readonly text: string;
}

/**
 * One conflict region in a merged file.
 *
 * Lines are 1-based within the merged file and span the markers. `base` is
 * null for a region written without one, in git's default conflict style.
 *
 * The text is decoded as UTF-8, as everything the runner returns is: a file in
 * another encoding keeps exact line spans but shows replacement characters in
 * its content.
 */
export interface ConflictBlock {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly ours: string;
  readonly theirs: string;
  readonly base: string | null;
}

/** `merge-tree` answers a clean merge with 0 and a conflicted one with 1. */
const EXIT_CLEAN = 0;
const EXIT_CONFLICTED = 1;

/**
 * git's answer to a form it does not understand.
 *
 * This is the capability check. `--merge-base` arrived in git 2.40 and
 * `--attr-source` in 2.41, and 2.38 accepts `--write-tree` while refusing both —
 * so a probe for the subcommand,
 * or for `--write-tree`, passes on a git that cannot run this merge. Asking the
 * merge itself costs nothing on a git that works, and the argv is Interlock's
 * own and checked, so a usage error here has no other cause.
 */
const EXIT_USAGE = 129;

const TYPE_CONTENTS = 'CONFLICT (contents)';
/**
 * Reported alongside `CONFLICT (contents)` for the same file, not instead of it,
 * so `contents` alone does not mean there are markers to read.
 */
const TYPE_BINARY = 'CONFLICT (binary)';

/** The length git writes markers at unless a `conflict-marker-size` says otherwise. */
const MIN_MARKER_LENGTH = 7;

/**
 * Merge `commitB` into `commitA` in the shadow's object database.
 *
 * A conflict is a result, not an error. This throws only when the merge could
 * not be attempted: `TOOLCHAIN_UNSUPPORTED` for a git older than 2.41,
 * `SNAPSHOT_STALE` when one of the three commits is not in the shadow — most
 * often a snapshot whose shadow was rebuilt — and `MERGE_FAILED` otherwise.
 */
export async function speculativeMerge(
  request: SpeculativeMergeRequest,
  options: SpeculativeMergeOptions,
): Promise<SpeculativeMergeResult> {
  const { shadow, commitA, commitB, mergeBaseSha } = request;
  const { runner } = options;
  // They come back from storage, and a value shaped like a flag is read by git
  // as one.
  assertObjectId(commitA, 'commitA');
  assertObjectId(commitB, 'commitB');
  assertObjectId(mergeBaseSha, 'mergeBaseSha');

  const startedAt = Date.now();
  const result = await runner.run(shadow, [
    // A bare clone has no worktree to read `.gitattributes` from, so without
    // this every attribute that shapes a merge — `binary`, the `union` driver,
    // `conflict-marker-size` — is silently ignored, and a pair conflicts here
    // that merges cleanly for real, or the other way about. Read from
    // `commitA`, as a `git merge` run in A's checkout would.
    `--attr-source=${commitA}`,
    'merge-tree',
    '--write-tree',
    '-z',
    `--merge-base=${mergeBaseSha}`,
    commitA,
    commitB,
  ]);

  if (result.exitCode === EXIT_USAGE) {
    throw new InterlockError('TOOLCHAIN_UNSUPPORTED', 'This git cannot run a speculative merge', {
      details: { exitCode: result.exitCode },
      remedy: 'Install git 2.41 or later and put it first on PATH.',
      infra: true,
    });
  }
  if (result.exitCode !== EXIT_CLEAN && result.exitCode !== EXIT_CONFLICTED) {
    throw await explainFailure(shadow, runner, request, result);
  }

  const output = parseMergeTree(result.stdout);
  const clean = result.exitCode === EXIT_CLEAN;
  // Exit status and output have to agree. A clean exit listing conflicts, or a
  // conflicted one listing none, is output this parser does not understand,
  // and reporting either as it stands would be a guess.
  if (clean !== (output.stages.length === 0)) {
    throw unparseable('the exit status and the conflicted files disagree');
  }
  // git names every conflict it reports, so a conflicted merge whose messages
  // stop short of any is output cut off after the stages.
  if (!clean && !output.messages.some((message) => message.type.startsWith('CONFLICT'))) {
    throw unparseable('a conflicted merge names no conflict');
  }

  const conflictBlocks = clean
    ? []
    : await readConflictBlocks(shadow, runner, output.treeOid, output.messages);

  return {
    clean,
    treeOid: output.treeOid,
    conflictedPaths: [...new Set(output.stages.map((stage) => stage.path))],
    stages: output.stages,
    messages: output.messages,
    conflictBlocks,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Name why a merge that git ran could not be attempted.
 *
 * Asked only after a failure, so a merge that works pays nothing for it. git's
 * stderr names paths and branches, which is repository content, and stays out of
 * the error as it does everywhere else.
 */
async function explainFailure(
  shadow: ShadowRepo,
  runner: GitRunner,
  request: SpeculativeMergeRequest,
  result: GitResult,
): Promise<InterlockError> {
  const commits = [
    ['commitA', request.commitA],
    ['commitB', request.commitB],
    ['mergeBaseSha', request.mergeBaseSha],
  ] as const;
  for (const [field, oid] of commits) {
    // The tree as well as the commit: a snapshot captured into the user's store
    // leaves its commit in the shadow and its tree where their `gc` reaps it.
    const found = await runner.run(shadow, ['cat-file', '-e', `${oid}^{tree}`]);
    if (found.exitCode !== 0) {
      return new InterlockError('SNAPSHOT_STALE', `The merge's ${field} is not in the shadow`, {
        details: { field },
        remedy: 'Capture the worktrees again, into this shadow, and merge the new snapshots.',
      });
    }
  }
  return new InterlockError('MERGE_FAILED', 'git could not attempt the merge', {
    details: { exitCode: result.exitCode },
    remedy: 'Check that the shadow clone is intact; removing it makes the next refresh rebuild it.',
    infra: true,
  });
}

interface MergeTreeOutput {
  readonly treeOid: string;
  readonly stages: readonly ConflictStage[];
  readonly messages: readonly MergeMessage[];
}

/**
 * Parse `merge-tree --write-tree -z`.
 *
 * The tree, then a stage per record until an empty one, then messages until
 * the end: each a count, that many paths, the type and the text. NUL-separated
 * throughout, so a path holding a newline or a quote arrives as it is.
 *
 * Anything that does not fit is refused rather than skipped, since a record
 * this cannot read may be the conflict that mattered.
 */
function parseMergeTree(stdout: string): MergeTreeOutput {
  const fields = stdout.split('\0');
  // Every record is terminated, so the split leaves one empty field at the end.
  // Output cut short loses that instead, and fails the structural checks below.
  fields.pop();

  const treeOid = fields[0] ?? '';
  if (!isObjectId(treeOid)) throw unparseable('the first field is not a tree id');

  let at = 1;
  const stages: ConflictStage[] = [];
  while (at < fields.length && fields[at] !== '') stages.push(parseStage(fields[at++]!));

  const messages: MergeMessage[] = [];
  // The empty record between the sections; a clean merge ends before it.
  at++;
  while (at < fields.length) {
    const count = Number(fields[at]);
    if (!Number.isInteger(count) || count < 1) throw unparseable('a message has no path count');
    const paths = fields.slice(at + 1, at + 1 + count);
    const type = fields[at + 1 + count];
    const text = fields[at + 2 + count];
    if (paths.length !== count || type === undefined || text === undefined) {
      throw unparseable('a message ends early');
    }
    // The prose carries a newline of its own before the terminator.
    messages.push({ paths, type, text: text.replace(/\n$/u, '') });
    at += count + 3;
  }

  return { treeOid, stages, messages };
}

/** `<mode> SP <object> SP <stage> TAB <path>`. */
function parseStage(record: string): ConflictStage {
  const tab = record.indexOf('\t');
  const [mode = '', oid = '', stage = '', extra] = record.slice(0, tab).split(' ');
  if (tab === -1 || extra !== undefined || !/^[0-7]{6}$/u.test(mode) || !isObjectId(oid)) {
    throw unparseable('a conflicted-file record is malformed');
  }
  if (stage !== '1' && stage !== '2' && stage !== '3') {
    throw unparseable('a conflicted-file record names no stage');
  }
  return { path: record.slice(tab + 1), mode, oid, stage: Number(stage) as 1 | 2 | 3 };
}

function unparseable(why: string): InterlockError {
  return new InterlockError('MERGE_FAILED', `merge-tree output could not be read: ${why}`, {
    remedy:
      'Report the git version in use; its merge-tree output differs from the documented form.',
    infra: true,
  });
}

/**
 * Read the conflict regions out of the merged tree.
 *
 * Only for paths with a content conflict and not a binary one — git reports a
 * binary file as both. git's classification is the authority rather than a
 * sniff of the blob: a file marked binary by attribute can be plain text with
 * no markers in it, and a text file can hold a NUL past the point git looks,
 * with real markers around it.
 */
async function readConflictBlocks(
  shadow: ShadowRepo,
  runner: GitRunner,
  treeOid: string,
  messages: readonly MergeMessage[],
): Promise<ConflictBlock[]> {
  const binary = new Set(messages.filter((m) => m.type === TYPE_BINARY).flatMap((m) => m.paths));
  const textual = [
    ...new Set(messages.filter((m) => m.type === TYPE_CONTENTS).flatMap((m) => m.paths)),
  ].filter((path) => !binary.has(path));
  if (textual.length === 0) return [];

  const blocks: ConflictBlock[] = [];
  for (const chunk of chunkPaths(textual)) {
    const listing = await runRequired(runner, shadow, [
      'ls-tree',
      '-r',
      '-z',
      treeOid,
      '--',
      ...chunk,
    ]);
    for (const entry of listing.stdout.split('\0')) {
      // `<mode> SP <type> SP <object> TAB <path>`; a symlink or a submodule
      // holds a target or a commit, never markers.
      const tab = entry.indexOf('\t');
      const [mode, type, oid] = entry.slice(0, tab).split(' ');
      if (tab === -1 || type !== 'blob' || (mode !== '100644' && mode !== '100755')) continue;
      const blob = await runRequired(runner, shadow, ['cat-file', 'blob', oid!]);
      blocks.push(...parseConflictRegions(entry.slice(tab + 1), blob.stdout));
    }
  }
  return blocks;
}

/**
 * Find the conflict regions in one merged file.
 *
 * A region opens with a run of at least seven `<` and closes with a `>` run of
 * the same length — the length is the repository's to set through
 * `conflict-marker-size`, so it is read off the opening marker rather than
 * assumed. A region that never closes ends the parse: whatever follows is not
 * text this can vouch for.
 *
 * A side whose own content holds a line that is exactly the separator run
 * reads as ending there; git does not lengthen its markers to avoid one, so no
 * reading of the file can tell the two apart.
 */
export function parseConflictRegions(path: string, text: string): ConflictBlock[] {
  const lines = text.split('\n');
  const blocks: ConflictBlock[] = [];

  for (let at = 0; at < lines.length; at++) {
    const size = markerLength(lines[at]!, '<');
    if (size === null) continue;

    const ours: string[] = [];
    let base: string[] | null = null;
    const theirs: string[] = [];
    let section: 'ours' | 'base' | 'theirs' = 'ours';
    let end: number | null = null;

    for (let line = at + 1; line < lines.length; line++) {
      const current = lines[line]!;
      if (section === 'ours' && markerLength(current, '|') === size) {
        section = 'base';
        base = [];
      } else if (section !== 'theirs' && withoutCr(current) === '='.repeat(size)) {
        section = 'theirs';
      } else if (section === 'theirs' && markerLength(current, '>') === size) {
        end = line;
        break;
      } else {
        (section === 'ours' ? ours : section === 'base' ? base! : theirs).push(current);
      }
    }

    if (end === null) break;
    blocks.push({
      path,
      startLine: at + 1,
      endLine: end + 1,
      ours: ours.join('\n'),
      theirs: theirs.join('\n'),
      base: base === null ? null : base.join('\n'),
    });
    at = end;
  }
  return blocks;
}

/**
 * The length of a marker run that opens `line`, or null when it is not one.
 *
 * A marker is the run alone or followed by a space and a label; anything else
 * after the run makes it content that happens to start the same way.
 */
function markerLength(line: string, char: '<' | '|' | '>'): number | null {
  const bare = withoutCr(line);
  let length = 0;
  while (bare[length] === char) length++;
  if (length < MIN_MARKER_LENGTH) return null;
  return length === bare.length || bare[length] === ' ' ? length : null;
}

/** Markers in a CRLF file end in `\r`, which is not part of the marker. */
function withoutCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}
