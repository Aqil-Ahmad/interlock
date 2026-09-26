import { InterlockError, REDACTED, SEVERITY_RANK, redact, ulid } from '@interlock/shared';
import type {
  BranchRefId,
  Evidence,
  Finding,
  FindingId,
  MergeConflictEvidence,
  MergeConflictSide,
  Severity,
  SpanEvidence,
  SpeculativeRunId,
} from '@interlock/shared';
import { runRequired } from '../git/repo-handle.js';
import type { GitRunner, ShadowRepo } from '../git/repo-handle.js';
import { chunkPaths } from '../git/worktree.js';
import { alignLines } from './line-diff.js';
import {
  REGULAR_MODES,
  scanConflictRegions,
  TYPE_BINARY,
  TYPE_CONTENTS,
} from './speculative-merge.js';
import type {
  ConflictRegionLines,
  ConflictStage,
  MergeMessage,
  SpeculativeMergeRequest,
  SpeculativeMergeResult,
} from './speculative-merge.js';

/**
 * Turns a conflicted speculative merge into Findings with evidence.
 *
 * Classification drives ranking: "both branches edited the same line of the
 * same function" needs a different severity from "both added an import at the
 * top of the file", though git reports them identically.
 *
 * The class comes from structure — which stages a path has, and the type token
 * git writes for machine consumption — never from the prose beside it, which
 * is reworded between releases.
 */

export type TextualConflictClass =
  /** Both sides changed at least one line of the merge base, differently. */
  | 'overlapping-edit'
  /**
   * Both sides changed the same region without changing a base line in common:
   * additions at one point (imports, exports, switch arms) or edits of
   * neighbouring lines.
   */
  | 'adjacent-addition'
  /** One side deleted a file the other modified. */
  | 'delete-vs-modify'
  /** One side renamed a file the other deleted. */
  | 'rename-vs-delete'
  /** Both sides added a file at the same path. */
  | 'add-add'
  /**
   * Any other conflict git reports: a rename on both sides, a file against a
   * directory or a symlink, a submodule. git is certain these conflict, so they
   * are reported, without spans, rather than read as a clean merge.
   */
  | 'other-conflict'
  /**
   * Both sides changed a file git can only keep one version of — binary
   * content, or a symlink's target — so there are no lines to compare and one
   * side's change is lost.
   */
  | 'whole-file-edit';

/**
 * Severity by class.
 *
 * Confidence is not where the uncertainty lives: git conflicting is ground
 * truth, so every textual Finding carries a confidence of 1. What is uncertain
 * is how much the conflict costs whoever resolves it, and that follows the
 * class.
 *
 * - `overlapping-edit` — the same lines were written two ways; one version is
 *   lost unless someone reconciles them by hand.
 * - `delete-vs-modify`, `rename-vs-delete` — one side's work goes with the file
 *   the other deleted.
 * - `add-add` — both wrote the same file from nothing. Nothing that existed is
 *   lost, but the file has to be reconciled whole.
 * - `other-conflict` — certain to need a person, and nothing narrower is known
 *   about what it costs them; medium says exactly that much.
 * - `adjacent-addition` — both changed next to each other and neither touched
 *   the other's lines; keeping both is usually the resolution. Low, because
 *   every pair of branches that adds an import at the same place lands here, and
 *   a high-severity finding for that is how a tool gets uninstalled.
 */
export const SEVERITY_BY_CLASS: Readonly<Record<TextualConflictClass, Severity>> = {
  'overlapping-edit': 'high',
  'delete-vs-modify': 'high',
  'rename-vs-delete': 'high',
  'add-add': 'medium',
  'other-conflict': 'medium',
  'whole-file-edit': 'high',
  'adjacent-addition': 'low',
};

/**
 * At most this many Findings per run, and at most this many conflicted paths
 * examined to produce them.
 *
 * Each costs a handful of `cat-file` calls, and a repository — which may be
 * hostile — decides how many paths conflict. Paths are examined most severe
 * first, by what their class can be before any blob is read, and the rest are
 * counted rather than reported.
 */
export const MAX_FINDINGS_PER_RUN = 50;

/** Spans per side per Finding; the regions past it are counted in the description. */
export const MAX_SPANS_PER_SIDE = 10;

/**
 * An excerpt is at most this many lines and this many characters of the span,
 * redacted. The span's line numbers say how much was left out.
 */
export const MAX_EXCERPT_LINES = 10;
export const MAX_EXCERPT_CHARS = 600;

/**
 * A blob larger than this is not read, and gets no span.
 *
 * Up to four versions of up to fifty files are read per run, and the files that
 * conflict most are lockfiles and generated code. Its regions unread, a content
 * conflict in such a file is classed the weaker way, as anything else it cannot
 * tell apart is.
 */
export const MAX_BLOB_BYTES = 1024 * 1024;

/**
 * Past this many differing lines, a side is not aligned and gets no span.
 *
 * Aligning costs the square of the differences, and what differs between a
 * branch's file and the merge resolved to that branch is the other branch's
 * clean changes — usually a few lines, and when it is not, silence is cheaper
 * than a guess.
 */
const MAX_ALIGN_EDITS = 1000;

const TYPE_MODIFY_DELETE = 'CONFLICT (modify/delete)';
const TYPE_RENAME_DELETE = 'CONFLICT (rename/delete)';

/** How far git looks for a NUL before calling content binary. */
const BINARY_SNIFF_LENGTH = 8000;

const TITLES: Readonly<Record<TextualConflictClass, string>> = {
  'overlapping-edit': 'Both branches changed the same lines',
  'adjacent-addition': 'Both branches changed neighbouring lines',
  'delete-vs-modify': 'One branch deleted a file the other changed',
  'rename-vs-delete': 'One branch deleted a file the other renamed',
  'add-add': 'Both branches added the same file',
  'other-conflict': 'The branches changed a file in ways git cannot combine',
  'whole-file-edit': 'Both branches changed a file git cannot merge line by line',
};

const DESCRIPTIONS: Readonly<Record<TextualConflictClass, string>> = {
  'overlapping-edit':
    'git cannot merge the two branches: each changed at least one line of the merge base, differently. One version is lost unless the two are reconciled by hand.',
  'adjacent-addition':
    'git cannot merge the two branches: they changed the same region without changing a line in common, as when both add an import at one place. Keeping both is usually the resolution.',
  'delete-vs-modify':
    'git cannot merge the two branches: one deleted a file the other modified, so the modification goes with the file.',
  'rename-vs-delete':
    'git cannot merge the two branches: one renamed a file the other deleted, so whatever changed with the rename goes with the file.',
  'add-add':
    'git cannot merge the two branches: both created the same file independently, and it has to be reconciled whole.',
  'whole-file-edit':
    'git cannot merge the two branches: both changed a file it can only keep one version of — binary content, or a symlink — so one side’s change is lost unless the two are reconciled by hand.',
  'other-conflict':
    "git cannot merge the two branches, with a conflict no narrower class describes — a rename on both sides, a file against a directory or a symlink, a submodule. git's type for it is in the evidence.",
};

const RATIONALE =
  'A textual conflict is symmetric: git cannot combine the two sides, and neither side caused it more than the other.';

export interface ClassifyRequest {
  readonly runId: SpeculativeRunId;
  readonly branchA: BranchRefId;
  readonly branchB: BranchRefId;
  /** The merge as it was asked for: shadow, both commits and the merge base. */
  readonly merge: SpeculativeMergeRequest;
  readonly merged: SpeculativeMergeResult;
  /** ISO-8601; stamped on every Finding as first seen and updated. */
  readonly now: string;
}

export interface ClassifyOptions {
  readonly runner: GitRunner;
}

export interface ClassifiedConflicts {
  /** Most severe first, and at most {@link MAX_FINDINGS_PER_RUN}. */
  readonly findings: readonly Finding[];
  /** Conflicted paths past the bound, examined for nothing. */
  readonly dropped: number;
}

/**
 * Classify every conflicted path of a merge.
 *
 * Reads blobs from the shadow — each side's file and the merged one — and
 * throws the runner's `InterlockError` when one cannot be read: a Finding is
 * never made from less than it claims, and nothing is returned in its place.
 */
export async function classifyTextualConflicts(
  request: ClassifyRequest,
  options: ClassifyOptions,
): Promise<ClassifiedConflicts> {
  const { merged } = request;
  const candidates: Candidate[] = [];
  const uncovered: Conflict[] = [];

  for (const conflict of groupConflicts(merged)) {
    const shape = shapeOf(conflict);
    if (shape === null) uncovered.push(conflict);
    else candidates.push({ conflict, shape });
  }
  // A conflicted merge never comes back as nothing: git is certain, and silence
  // here would read as "no conflicts found".
  for (const conflict of gatherUncovered(uncovered, merged)) {
    candidates.push({ conflict, shape: { kind: 'class', class: 'other-conflict' } });
  }

  // Stable, so git's path order holds within a rank.
  candidates.sort((a, b) => priorityOf(b.shape) - priorityOf(a.shape));
  const examined = candidates.slice(0, MAX_FINDINGS_PER_RUN);

  const reader = new BlobReader(request.merge.shadow, options.runner);
  const sides = await resolveSides(examined, request, reader);

  // One listing for every text conflict's merged file, rather than one each.
  const mergedEntries = await reader.list(
    request.merged.treeOid,
    examined
      .filter(({ shape }) => shape.kind !== 'class' && shape.text)
      .map(({ conflict }) => conflict.recorded[0]!),
  );

  const findings: Finding[] = [];
  for (const [index, candidate] of examined.entries()) {
    const resolved = sides[index]!;
    const body = await examine(candidate, resolved, request, reader, mergedEntries);
    findings.push(toFinding(request, candidate, resolved, body));
  }
  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  return { findings, dropped: candidates.length - examined.length };
}

/**
 * What makes two textual Findings the same finding, or null for any other.
 *
 * The pair, unordered — a conflict does not change with the order it was
 * merged in — the class, and the path the conflict is about. Not the
 * span: it moves whenever either branch edits above the conflict, and a key that
 * moved with it would make a new finding on every poll while the old one went
 * stale beside it. Not the commits either, for the same reason. A class change
 * is a different finding, since what it asks of whoever resolves it changed.
 */
export function textualFindingKey(finding: Finding): string | null {
  const merge = finding.evidence.find(
    (evidence): evidence is MergeConflictEvidence => evidence.type === 'merge-conflict',
  );
  if (finding.kind !== 'textual' || merge === undefined) return null;
  const pair = [finding.attribution.branchA, finding.attribution.branchB].sort();
  return JSON.stringify(['textual', finding.rule, ...pair, merge.path]);
}

// --- Structure ---------------------------------------------------------------

interface Conflict {
  /**
   * The path the conflict is about. git's own, except for a file it moved aside
   * to `<path>~<commit>`, which is filed under the path it was moved from: the
   * aside name changes with every commit, and identity must not.
   */
  readonly path: string;
  /** The paths git recorded the conflict's stages under. */
  readonly recorded: readonly string[];
  readonly base: ConflictStage | undefined;
  readonly ours: ConflictStage | undefined;
  readonly theirs: ConflictStage | undefined;
  /** Conflict type tokens naming this path, once each. */
  readonly types: readonly string[];
}

/** What a path's stages and tokens say, before any blob is read. */
type Shape =
  | {
      readonly kind: 'class';
      readonly class: 'delete-vs-modify' | 'rename-vs-delete' | 'other-conflict';
    }
  | { readonly kind: 'add-add'; readonly text: boolean }
  /** Both sides changed a file the base had; the regions decide the class. */
  | { readonly kind: 'content'; readonly text: boolean };

interface Candidate {
  readonly conflict: Conflict;
  readonly shape: Shape;
}

function groupConflicts(merged: SpeculativeMergeResult): Conflict[] {
  const types = new Map<string, Set<string>>();
  for (const message of conflictMessages(merged)) {
    for (const path of message.paths) {
      const set = types.get(path) ?? new Set<string>();
      set.add(message.type);
      types.set(path, set);
    }
  }
  // Indexed once each: the repository decides how many paths conflict, and a
  // lookup per path over every stage or message is quadratic in a number a
  // hostile one chooses, all of it paid before the per-run bound applies.
  const stages = new Map<string, (ConflictStage | undefined)[]>();
  for (const stage of merged.stages) {
    const byNumber = stages.get(stage.path) ?? [undefined, undefined, undefined];
    byNumber[stage.stage - 1] ??= stage;
    stages.set(stage.path, byNumber);
  }
  const origins = movedFromIndex(merged);
  return merged.conflictedPaths.map((path) => {
    const [base, ours, theirs] = stages.get(path) ?? [];
    return {
      path: origins.get(path) ?? path,
      recorded: [path],
      base,
      ours,
      theirs,
      types: [...(types.get(path) ?? [])],
    };
  });
}

function conflictMessages(merged: SpeculativeMergeResult): MergeMessage[] {
  return merged.messages.filter((message) => message.type.startsWith('CONFLICT'));
}

/**
 * The path each moved-aside file came from.
 *
 * git names both in the message about the move — `d~<commit>` beside `d` — so
 * the original is read off that pairing rather than off the shape of the name,
 * which a real file can share. The first message pairing a path wins.
 */
function movedFromIndex(merged: SpeculativeMergeResult): Map<string, string> {
  const origins = new Map<string, string>();
  for (const message of conflictMessages(merged)) {
    for (const path of message.paths) {
      if (origins.has(path)) continue;
      const original = message.paths.find((other) => path.startsWith(`${other}~`));
      if (original !== undefined) origins.set(path, original);
    }
  }
  return origins;
}

/**
 * One conflict per git message among paths no class covers.
 *
 * A rename on both sides records three paths — the base's and each side's new
 * name — for what is one conflict, and a file against a symlink records one
 * side under a moved-aside name. Each message names every path it concerns, so
 * the paths are gathered by it; a path no message names stays on its own.
 */
function gatherUncovered(
  conflicts: readonly Conflict[],
  merged: SpeculativeMergeResult,
): Conflict[] {
  const pending = new Map(conflicts.map((conflict) => [conflict.recorded[0]!, conflict]));
  const gathered: Conflict[] = [];
  for (const message of conflictMessages(merged)) {
    const parts = message.paths.flatMap((path) => pending.get(path) ?? []);
    if (parts.length === 0) continue;
    for (const part of parts) pending.delete(part.recorded[0]!);
    gathered.push({
      path: parts[0]!.path,
      recorded: parts.flatMap((part) => part.recorded),
      base: parts.find((part) => part.base !== undefined)?.base,
      ours: parts.find((part) => part.ours !== undefined)?.ours,
      theirs: parts.find((part) => part.theirs !== undefined)?.theirs,
      types: [...new Set(parts.flatMap((part) => part.types))],
    });
  }
  gathered.push(...pending.values());
  return gathered;
}

/**
 * The class a conflicted path's structure supports, or null when none does.
 *
 * Every mapping requires the stage set it implies as well as the token, so a
 * shape that does not fit is never forced into the nearest class; it is
 * reported as `other-conflict` instead.
 */
function shapeOf(conflict: Conflict): Shape | null {
  const { base, ours, theirs, types } = conflict;
  const has = (type: string): boolean => types.includes(type);
  const oneSide = (ours === undefined) !== (theirs === undefined);

  if (has(TYPE_RENAME_DELETE) && base !== undefined && oneSide) {
    return { kind: 'class', class: 'rename-vs-delete' };
  }
  if (has(TYPE_MODIFY_DELETE) && base !== undefined && oneSide) {
    return { kind: 'class', class: 'delete-vs-modify' };
  }
  if (has(TYPE_CONTENTS) && ours !== undefined && theirs !== undefined) {
    // git reports a binary conflict as `contents` too; its word on what is text
    // is the authority, since an attribute can make a text file binary.
    const text =
      !has(TYPE_BINARY) && REGULAR_MODES.has(ours.mode) && REGULAR_MODES.has(theirs.mode);
    return base === undefined ? { kind: 'add-add', text } : { kind: 'content', text };
  }
  return null;
}

/**
 * The order paths are examined in, when there are more than the bound.
 *
 * By the most severe class a shape can turn out to be, and within that a class
 * already certain first: a text conflict may yet read as `adjacent-addition`,
 * and fifty of those must not crowd out a deletion that is certainly `high`.
 */
function priorityOf(shape: Shape): number {
  const certain = shape.kind !== 'content' || !shape.text;
  const ceiling =
    shape.kind === 'class'
      ? SEVERITY_BY_CLASS[shape.class]
      : shape.kind === 'add-add'
        ? SEVERITY_BY_CLASS['add-add']
        : shape.text
          ? SEVERITY_BY_CLASS['overlapping-edit']
          : SEVERITY_BY_CLASS['whole-file-edit'];
  return SEVERITY_RANK[ceiling] * 2 + (certain ? 1 : 0);
}

// --- Each side's file ----------------------------------------------------------

interface ResolvedSides {
  readonly base: MergeConflictSide | null;
  readonly sideA: MergeConflictSide | null;
  readonly sideB: MergeConflictSide | null;
}

/**
 * Where each stage's blob lives on its own commit.
 *
 * git records every stage of a conflict under one path, which after a rename is
 * the new name — a path that exists on one side only. A span has to name the
 * path on its own branch, so each stage is looked for at the recorded path in
 * its commit first, and otherwise by its blob anywhere in that commit: one match
 * is the path, more than one is a file copied, and gets no path rather than a
 * guess.
 */
async function resolveSides(
  candidates: readonly Candidate[],
  request: ClassifyRequest,
  reader: BlobReader,
): Promise<ResolvedSides[]> {
  const { mergeBaseSha, commitA, commitB } = request.merge;
  const locate = async (
    commit: string,
    pick: (conflict: Conflict) => ConflictStage | undefined,
  ): Promise<(MergeConflictSide | null)[]> => {
    const stages = candidates.map((candidate) => pick(candidate.conflict));
    const recorded = await reader.list(
      commit,
      stages.flatMap((stage) => (stage === undefined ? [] : [stage.path])),
    );
    const out: (MergeConflictSide | null)[] = [];
    for (const stage of stages) {
      if (stage === undefined) {
        out.push(null);
        continue;
      }
      const path =
        recorded.get(stage.path)?.oid === stage.oid
          ? stage.path
          : await reader.pathOf(commit, stage.oid);
      out.push({ path, mode: stage.mode, oid: stage.oid });
    }
    return out;
  };

  const base = await locate(mergeBaseSha, (conflict) => conflict.base);
  const sideA = await locate(commitA, (conflict) => conflict.ours);
  const sideB = await locate(commitB, (conflict) => conflict.theirs);
  return candidates.map((_, index) => ({
    base: base[index]!,
    sideA: sideA[index]!,
    sideB: sideB[index]!,
  }));
}

// --- Spans -----------------------------------------------------------------------

interface Examined {
  readonly class: TextualConflictClass;
  /**
   * By region: index i on each side is region i, null where that side's lines
   * could not be placed. Kept aligned rather than filtered, so a span is only
   * ever shown beside the other side's span for the same region.
   */
  readonly spansA: readonly (SpanEvidence | null)[];
  readonly spansB: readonly (SpanEvidence | null)[];
  /** Regions or hunks with no span on a side that has lines there, past the bound included. */
  readonly spansOmitted: number;
}

async function examine(
  candidate: Candidate,
  sides: ResolvedSides,
  request: ClassifyRequest,
  reader: BlobReader,
  mergedEntries: ReadonlyMap<string, TreeEntry>,
): Promise<Examined> {
  const { shape, conflict } = candidate;
  const { branchA, branchB } = request;

  if (shape.kind === 'class' && shape.class === 'other-conflict') {
    // Nothing here is lines in one file on each side; git's tokens and the
    // blobs are the evidence.
    return { class: shape.class, spansA: [], spansB: [], spansOmitted: 0 };
  }

  if (shape.kind === 'class') {
    // One side has no file; the other's changes against the base are what the
    // deletion takes with it.
    const deletedByA = sides.sideA === null;
    const survivor = deletedByA ? sides.sideB : sides.sideA;
    let spans: SpanEvidence[] = [];
    let omitted = 0;
    if (isText(sides.base) && isText(survivor) && survivor.path !== null) {
      const baseText = await reader.text(sides.base.oid);
      const survivorText = await reader.text(survivor.oid);
      const readable =
        baseText !== null &&
        survivorText !== null &&
        !looksBinary(baseText) &&
        !looksBinary(survivorText);
      if (readable) {
        const survivorLines = survivorText.split('\n');
        const hunks = changedHunks(baseText.split('\n'), survivorLines);
        if (hunks !== null) {
          const branch = deletedByA ? branchB : branchA;
          const kept = hunks.slice(0, MAX_SPANS_PER_SIDE);
          spans = kept.map((range) => spanFor(branch, survivor.path!, survivorLines, range));
          omitted = hunks.length - kept.length;
        }
      }
    }
    return {
      class: shape.class,
      spansA: deletedByA ? [] : spans,
      spansB: deletedByA ? spans : [],
      spansOmitted: omitted,
    };
  }

  if (!shape.text) {
    // No lines to place, so no span, and no claim about lines either: whether
    // the two changes touched the same part of the file is unknowable here.
    const cls = shape.kind === 'add-add' ? 'add-add' : 'whole-file-edit';
    return { class: cls, spansA: [], spansB: [], spansOmitted: 0 };
  }

  const mergedOid = mergedEntries.get(conflict.recorded[0]!);
  // Both sides are regular files here, so the merged entry is one too.
  const mergedText = mergedOid === undefined ? null : await reader.text(mergedOid.oid);
  const regions = mergedText === null ? [] : scanConflictRegions(mergedText);
  const cls: TextualConflictClass =
    shape.kind === 'add-add'
      ? 'add-add'
      : regions.some((region) => regionOverlaps(region) === true)
        ? 'overlapping-edit'
        : // Includes a region with no base and a file whose regions could not
          // be read: when it cannot tell, it says the weaker thing.
          'adjacent-addition';

  const mergedLines = mergedText?.split('\n') ?? [];
  const shown = Math.min(regions.length, MAX_SPANS_PER_SIDE);
  const place = async (
    side: MergeConflictSide | null,
    which: 'ours' | 'theirs',
    branch: BranchRefId,
  ): Promise<(SpanEvidence | null)[]> => {
    // Both sides exist and are regular files, or the shape would not be text;
    // a side can still lack a path, when its blob sits at more than one.
    const path = side?.path ?? null;
    const none = new Array<null>(shown).fill(null);
    if (side === null || path === null) return none;
    const lines = (await reader.text(side.oid))?.split('\n');
    if (lines === undefined) return none;
    return placeRegions(mergedLines, regions, which, lines)
      .slice(0, shown)
      .map((range) => (range === null ? null : spanFor(branch, path, lines, range)));
  };

  const spansA = await place(sides.sideA, 'ours', branchA);
  const spansB = await place(sides.sideB, 'theirs', branchB);
  const placedBoth = spansA.filter((span, index) => span !== null && spansB[index] !== null);
  return { class: cls, spansA, spansB, spansOmitted: regions.length - placedBoth.length };
}

function isText(side: MergeConflictSide | null): side is MergeConflictSide {
  return side !== null && REGULAR_MODES.has(side.mode);
}

/**
 * git's own test for binary content: a NUL in the first 8000 bytes.
 *
 * Only where git gives no verdict. A content conflict comes with
 * `CONFLICT (binary)` when it is one, and that is the authority; a
 * modify/delete or rename/delete says nothing either way, and a span over a
 * binary file's "lines" would be invented.
 */
function looksBinary(text: string): boolean {
  return text.slice(0, BINARY_SNIFF_LENGTH).includes('\0');
}

/** Zero-based, half-open line range within one side's file. */
type LineRange = readonly [from: number, to: number];

function spanFor(
  branchRefId: BranchRefId,
  path: string,
  lines: readonly string[],
  [from, to]: LineRange,
): SpanEvidence {
  return {
    type: 'span',
    branchRefId,
    path,
    startLine: from + 1,
    endLine: to,
    excerpt: excerptOf(lines.slice(from, to)),
  };
}

/** A private key's opening line, which a span can hold without the closing one. */
const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u;

/**
 * At most {@link MAX_EXCERPT_LINES} lines and {@link MAX_EXCERPT_CHARS}
 * characters of a span, redacted.
 *
 * Redacted whole, before anything is cut. The patterns match a secret only
 * entire — a key from its `BEGIN` line to its `END`, a token to its minimum
 * length — so a line limit through a key or a character limit through a token
 * leaves a fragment nothing recognises, and it would be stored as it is. What
 * still opens a key after redacting is a key the span holds only the start of,
 * and everything from its `BEGIN` goes. A span holding only a key's middle has
 * no marker to find, and is the limit of reading a secret by its shape.
 */
export function excerptOf(lines: readonly string[]): string {
  const redacted = redact(lines.join('\n'));
  const open = redacted.search(KEY_BEGIN);
  const safe = open === -1 ? redacted : `${redacted.slice(0, open)}${REDACTED}`;
  const text = safe.split('\n').slice(0, MAX_EXCERPT_LINES).join('\n');
  // By code point, so a cut never leaves half a surrogate pair.
  return [...text].slice(0, MAX_EXCERPT_CHARS).join('');
}

/**
 * Where each region's side sits in that side's own file.
 *
 * The merged file with every region resolved to one side is that side's file
 * plus the other side's clean changes, so aligning the two places each region's
 * lines exactly — where merged-file line numbers would point at lines that exist
 * on no branch. A region is placed only when all its lines align, contiguously;
 * one with no lines on this side is placed only when the lines either side of it
 * are neighbours in the file. Anything else is null: no span beats a wrong one.
 */
export function placeRegions(
  mergedLines: readonly string[],
  regions: readonly ConflictRegionLines[],
  which: 'ours' | 'theirs',
  sideLines: readonly string[],
): (LineRange | null)[] {
  const resolved: string[] = [];
  const starts: number[] = [];
  let at = 0;
  for (const region of regions) {
    while (at < region.startLine - 1) resolved.push(mergedLines[at++]!);
    starts.push(resolved.length);
    resolved.push(...region[which]);
    at = region.endLine;
  }
  while (at < mergedLines.length) resolved.push(mergedLines[at++]!);

  const match = alignLines(resolved, sideLines, MAX_ALIGN_EDITS);
  if (match === null) return regions.map(() => null);

  return regions.map((region, index) => {
    const start = starts[index]!;
    const count = region[which].length;
    if (count > 0) {
      const first = match[start]!;
      if (first === -1) return null;
      for (let offset = 1; offset < count; offset++) {
        if (match[start + offset] !== first + offset) return null;
      }
      return [first, first + count];
    }
    const before = start === 0 ? -1 : match[start - 1]!;
    // Past the last line, the region is at the end of the file.
    const after = match[start] ?? sideLines.length;
    // Matches only increase, so an unmatched line before is fine exactly when
    // the line after is the file's first — nothing before it exists here. An
    // unmatched line after never passes: -1 is no line's successor.
    if (after !== before + 1) return null;
    return [after, after];
  });
}

/**
 * Whether both sides of a region changed a line of the base in common.
 *
 * Null when the region carries no base, which a merge without diff3 markers
 * writes, or when a side is too far from the base to align.
 *
 * Each side is aligned to the base: a base line with no counterpart is one that
 * side replaced or deleted, and a side line with none is inserted in the gap
 * before the next base line. Both sides replacing one base line overlaps, and so
 * does one side inserting inside a run the other replaced. Two insertions at one
 * gap do not — that is two imports added at the same place — and nor does one
 * side's change next to the other's.
 */
export function regionOverlaps(region: ConflictRegionLines): boolean | null {
  if (region.base === null) return null;
  const ours = touched(region.base, region.ours);
  const theirs = touched(region.base, region.theirs);
  if (ours === null || theirs === null) return null;

  for (const line of ours.changed) if (theirs.changed.has(line)) return true;
  const inside = (gap: number, run: ReadonlySet<number>): boolean =>
    run.has(gap - 1) && run.has(gap);
  for (const gap of ours.inserted) if (inside(gap, theirs.changed)) return true;
  for (const gap of theirs.inserted) if (inside(gap, ours.changed)) return true;
  return false;
}

interface Touched {
  /** Base lines the side replaced or deleted. */
  readonly changed: ReadonlySet<number>;
  /** Gaps the side inserted into; gap g sits before base line g. */
  readonly inserted: ReadonlySet<number>;
}

function touched(base: readonly string[], side: readonly string[]): Touched | null {
  const match = alignLines(base, side, MAX_ALIGN_EDITS);
  if (match === null) return null;
  const changed = new Set<number>();
  const inserted = new Set<number>();
  const matchedSide = new Map<number, number>();
  match.forEach((j, i) => {
    if (j === -1) changed.add(i);
    else matchedSide.set(j, i);
  });
  let gap = 0;
  for (let j = 0; j < side.length; j++) {
    const i = matchedSide.get(j);
    if (i === undefined) inserted.add(gap);
    else gap = i + 1;
  }
  return { changed, inserted };
}

/**
 * The ranges of `side` that differ from `base`, in `side`'s own lines.
 *
 * A pure deletion is an empty range where the deleted lines were. Null when the
 * two are too far apart to align.
 */
export function changedHunks(base: readonly string[], side: readonly string[]): LineRange[] | null {
  const match = alignLines(base, side, MAX_ALIGN_EDITS);
  if (match === null) return null;
  const hunks: LineRange[] = [];
  let i = 0;
  let j = 0;
  while (i < base.length || j < side.length) {
    if (i < base.length && match[i] === j) {
      i++;
      j++;
      continue;
    }
    const from = j;
    while (i < base.length && match[i] === -1) i++;
    j = i < base.length ? match[i]! : side.length;
    hunks.push([from, j]);
  }
  return hunks;
}

// --- The Finding -----------------------------------------------------------------

function toFinding(
  request: ClassifyRequest,
  candidate: Candidate,
  sides: ResolvedSides,
  examined: Examined,
): Finding {
  const { merge } = request;
  const provenance: MergeConflictEvidence = {
    type: 'merge-conflict',
    mergeBaseSha: merge.mergeBaseSha,
    commitA: merge.commitA,
    commitB: merge.commitB,
    path: candidate.conflict.path,
    conflictTypes: candidate.conflict.types,
    base: sides.base,
    sideA: sides.sideA,
    sideB: sides.sideB,
  };
  const evidence: Evidence[] = [provenance];
  // Region by region, each side's span beside the other's for the same region.
  const regions = Math.max(examined.spansA.length, examined.spansB.length);
  for (let index = 0; index < regions; index++) {
    const a = examined.spansA[index];
    const b = examined.spansB[index];
    if (a != null) evidence.push(a);
    if (b != null) evidence.push(b);
  }

  const omitted =
    examined.spansOmitted > 0
      ? ` ${String(examined.spansOmitted)} ${examined.spansOmitted === 1 ? 'region lacks' : 'regions lack'} a span on one side or both.`
      : '';
  return {
    id: ulid<FindingId>(),
    runId: request.runId,
    kind: 'textual',
    rule: examined.class,
    severity: SEVERITY_BY_CLASS[examined.class],
    confidence: 1,
    status: 'open',
    title: TITLES[examined.class],
    description: DESCRIPTIONS[examined.class] + omitted,
    attribution: {
      branchA: request.branchA,
      branchB: request.branchB,
      originBranch: null,
      rationale: RATIONALE,
    },
    evidence,
    firstSeenAt: request.now,
    updatedAt: request.now,
    resolvedAt: null,
  };
}

// --- Reading the shadow -----------------------------------------------------------

interface TreeEntry {
  readonly mode: string;
  readonly oid: string;
  /** Bytes; null for anything but a blob. */
  readonly size: number | null;
}

/** Blob and tree reads for one classification, each object read at most once. */
class BlobReader {
  readonly #shadow: ShadowRepo;
  readonly #runner: GitRunner;
  readonly #texts = new Map<string, string | null>();
  readonly #sizes = new Map<string, number>();
  readonly #listings = new Map<string, Map<string, string[]>>();

  constructor(shadow: ShadowRepo, runner: GitRunner) {
    this.#shadow = shadow;
    this.#runner = runner;
  }

  /** The entries of `tree` at exactly these paths; `-z`, since a path may hold a newline. */
  async list(tree: string, paths: readonly string[]): Promise<Map<string, TreeEntry>> {
    const found = new Map<string, TreeEntry>();
    for (const chunk of chunkPaths([...new Set(paths)])) {
      // `-l` for sizes: git reads them off the object headers it has open anyway.
      const listing = await runRequired(this.#runner, this.#shadow, [
        'ls-tree',
        '-z',
        '-l',
        '--full-tree',
        tree,
        '--',
        ...chunk,
      ]);
      for (const [path, entry] of parseListing(listing.stdout)) {
        found.set(path, entry);
        if (entry.size !== null) this.#sizes.set(entry.oid, entry.size);
      }
    }
    return found;
  }

  /** The one path in `commit` holding blob `oid`, or null for none or several. */
  async pathOf(commit: string, oid: string): Promise<string | null> {
    let byOid = this.#listings.get(commit);
    if (byOid === undefined) {
      const listing = await runRequired(this.#runner, this.#shadow, [
        'ls-tree',
        '-r',
        '-z',
        '--full-tree',
        commit,
      ]);
      byOid = new Map();
      for (const [path, entry] of parseListing(listing.stdout)) {
        // In place: every empty `.gitkeep` shares one blob, and copying the list
        // per duplicate is quadratic in how many there are.
        const paths = byOid.get(entry.oid);
        if (paths === undefined) byOid.set(entry.oid, [path]);
        else paths.push(path);
      }
      this.#listings.set(commit, byOid);
    }
    const paths = byOid.get(oid) ?? [];
    return paths.length === 1 ? paths[0]! : null;
  }

  /** A blob's content, or null when it is larger than {@link MAX_BLOB_BYTES}. */
  async text(oid: string): Promise<string | null> {
    const cached = this.#texts.get(oid);
    if (cached !== undefined) return cached;
    const size = this.#sizes.get(oid) ?? (await this.#sizeOf(oid));
    const text =
      size > MAX_BLOB_BYTES
        ? null
        : (await runRequired(this.#runner, this.#shadow, ['cat-file', 'blob', oid])).stdout;
    this.#texts.set(oid, text);
    return text;
  }

  async #sizeOf(oid: string): Promise<number> {
    const answer = await runRequired(this.#runner, this.#shadow, ['cat-file', '-s', oid]);
    const size = Number(answer.stdout.trim());
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new InterlockError('MERGE_FAILED', 'git answered a blob size that is not a number', {
        remedy:
          'Report the git version in use; its cat-file output differs from the documented form.',
        infra: true,
      });
    }
    return size;
  }
}

/**
 * `<mode> SP <type> SP <object> TAB <path>`, NUL-terminated; blobs only. With
 * `-l`, the object is followed by its size, padded with spaces, which are
 * git's own and never the path's — the path starts after the tab.
 */
function parseListing(stdout: string): [string, TreeEntry][] {
  const entries: [string, TreeEntry][] = [];
  for (const record of stdout.split('\0')) {
    // The empty record after the last terminator has no tab, and no type.
    const tab = record.indexOf('\t');
    const [mode = '', type, oid = '', size] = record.slice(0, tab).split(' ').filter(Boolean);
    if (type !== 'blob') continue;
    const bytes = size === undefined ? null : Number(size);
    entries.push([
      record.slice(tab + 1),
      { mode, oid, size: bytes !== null && Number.isSafeInteger(bytes) ? bytes : null },
    ]);
  }
  return entries;
}
