import { SEVERITY_RANK, redact, ulid } from '@interlock/shared';
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
import { scanConflictRegions } from './speculative-merge.js';
import type {
  ConflictRegionLines,
  ConflictStage,
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
  | 'rename-vs-modify'
  /** Both sides added a file at the same path. */
  | 'add-add';

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
 * - `delete-vs-modify`, `rename-vs-modify` — one side's work goes with the file
 *   the other deleted.
 * - `add-add` — both wrote the same file from nothing. Nothing that existed is
 *   lost, but the file has to be reconciled whole.
 * - `adjacent-addition` — both changed next to each other and neither touched
 *   the other's lines; keeping both is usually the resolution. Low, because
 *   every pair of branches that adds an import at the same place lands here, and
 *   a high-severity finding for that is how a tool gets uninstalled.
 */
export const SEVERITY_BY_CLASS: Readonly<Record<TextualConflictClass, Severity>> = {
  'overlapping-edit': 'high',
  'delete-vs-modify': 'high',
  'rename-vs-modify': 'high',
  'add-add': 'medium',
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
 * Past this many differing lines, a side is not aligned and gets no span.
 *
 * Aligning costs the square of the differences, and what differs between a
 * branch's file and the merge resolved to that branch is the other branch's
 * clean changes — usually a few lines, and when it is not, silence is cheaper
 * than a guess.
 */
const MAX_ALIGN_EDITS = 1000;

const TYPE_CONTENTS = 'CONFLICT (contents)';
const TYPE_BINARY = 'CONFLICT (binary)';
const TYPE_MODIFY_DELETE = 'CONFLICT (modify/delete)';
const TYPE_RENAME_DELETE = 'CONFLICT (rename/delete)';

/** How far git looks for a NUL before calling content binary. */
const BINARY_SNIFF_LENGTH = 8000;

/** Modes whose blob is text a line can be read from; a symlink holds a target. */
const REGULAR_MODES: ReadonlySet<string> = new Set(['100644', '100755']);

const TITLES: Readonly<Record<TextualConflictClass, string>> = {
  'overlapping-edit': 'Both branches changed the same lines',
  'adjacent-addition': 'Both branches changed neighbouring lines',
  'delete-vs-modify': 'One branch deleted a file the other changed',
  'rename-vs-modify': 'One branch deleted a file the other renamed',
  'add-add': 'Both branches added the same file',
};

const DESCRIPTIONS: Readonly<Record<TextualConflictClass, string>> = {
  'overlapping-edit':
    'git cannot merge the two branches: each changed at least one line of the merge base, differently. One version is lost unless the two are reconciled by hand.',
  'adjacent-addition':
    'git cannot merge the two branches: they changed the same region without changing a line in common, as when both add an import at one place. Keeping both is usually the resolution.',
  'delete-vs-modify':
    'git cannot merge the two branches: one deleted a file the other modified, so the modification goes with the file.',
  'rename-vs-modify':
    'git cannot merge the two branches: one renamed a file the other deleted, so whatever changed with the rename goes with the file.',
  'add-add':
    'git cannot merge the two branches: both created the same file independently, and it has to be reconciled whole.',
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
  /** Conflict types seen on paths no class covers, e.g. `CONFLICT (rename/rename)`. */
  readonly unclassified: readonly string[];
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
  const unclassified = new Set<string>();
  const candidates: Candidate[] = [];

  for (const conflict of groupConflicts(merged)) {
    const shape = shapeOf(conflict);
    if (shape === null) {
      for (const type of conflict.types) unclassified.add(type);
    } else {
      candidates.push({ conflict, shape });
    }
  }

  // Stable, so git's path order holds within a rank.
  candidates.sort((a, b) => priorityOf(b.shape) - priorityOf(a.shape));
  const examined = candidates.slice(0, MAX_FINDINGS_PER_RUN);

  const reader = new BlobReader(request.merge.shadow, options.runner);
  const sides = await resolveSides(examined, request, reader);

  const findings: Finding[] = [];
  for (const [index, candidate] of examined.entries()) {
    const resolved = sides[index]!;
    const body = await examine(candidate, resolved, request, reader);
    findings.push(toFinding(request, candidate, resolved, body));
  }
  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  return {
    findings,
    unclassified: [...unclassified],
    dropped: candidates.length - examined.length,
  };
}

/**
 * What makes two textual Findings the same finding, or null for any other.
 *
 * The pair, unordered — a conflict does not change with the order it was
 * merged in — the class, and the path git recorded the conflict under. Not the
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
  readonly path: string;
  readonly base: ConflictStage | undefined;
  readonly ours: ConflictStage | undefined;
  readonly theirs: ConflictStage | undefined;
  /** Conflict type tokens naming this path, once each. */
  readonly types: readonly string[];
}

/** What a path's stages and tokens say, before any blob is read. */
type Shape =
  | { readonly kind: 'class'; readonly class: 'delete-vs-modify' | 'rename-vs-modify' }
  | { readonly kind: 'add-add'; readonly text: boolean }
  /** Both sides changed a file the base had; the regions decide the class. */
  | { readonly kind: 'content'; readonly text: boolean };

interface Candidate {
  readonly conflict: Conflict;
  readonly shape: Shape;
}

function groupConflicts(merged: SpeculativeMergeResult): Conflict[] {
  const types = new Map<string, Set<string>>();
  for (const message of merged.messages) {
    if (!message.type.startsWith('CONFLICT')) continue;
    for (const path of message.paths) {
      const set = types.get(path) ?? new Set<string>();
      set.add(message.type);
      types.set(path, set);
    }
  }
  return merged.conflictedPaths.map((path) => {
    const stage = (n: 1 | 2 | 3): ConflictStage | undefined =>
      merged.stages.find((s) => s.path === path && s.stage === n);
    return {
      path,
      base: stage(1),
      ours: stage(2),
      theirs: stage(3),
      types: [...(types.get(path) ?? [])],
    };
  });
}

/**
 * The class a conflicted path's structure supports, or null when none does.
 *
 * Every mapping requires the stage set it implies as well as the token, so a
 * shape git has never produced is left unclassified rather than forced into
 * the nearest class.
 */
function shapeOf(conflict: Conflict): Shape | null {
  const { base, ours, theirs, types } = conflict;
  const has = (type: string): boolean => types.includes(type);
  const oneSide = (ours === undefined) !== (theirs === undefined);

  if (has(TYPE_RENAME_DELETE) && base !== undefined && oneSide) {
    return { kind: 'class', class: 'rename-vs-modify' };
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
        : SEVERITY_BY_CLASS['overlapping-edit'];
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
  readonly spansA: readonly SpanEvidence[];
  readonly spansB: readonly SpanEvidence[];
  /** Regions or hunks past {@link MAX_SPANS_PER_SIDE}, on the side with more. */
  readonly spansOmitted: number;
}

async function examine(
  candidate: Candidate,
  sides: ResolvedSides,
  request: ClassifyRequest,
  reader: BlobReader,
): Promise<Examined> {
  const { shape, conflict } = candidate;
  const { branchA, branchB } = request;

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
      const hunks =
        looksBinary(baseText) || looksBinary(survivorText)
          ? null
          : changedHunks(baseText.split('\n'), survivorText.split('\n'));
      if (hunks !== null) {
        const branch = deletedByA ? branchB : branchA;
        const kept = hunks.slice(0, MAX_SPANS_PER_SIDE);
        spans = await spansFor(branch, survivor.path, survivor.oid, kept, reader);
        omitted = hunks.length - kept.length;
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
    // No lines to place: a span here would be invented.
    const cls = shape.kind === 'add-add' ? 'add-add' : 'overlapping-edit';
    return { class: cls, spansA: [], spansB: [], spansOmitted: 0 };
  }

  const mergedOid = (await reader.list(request.merged.treeOid, [conflict.path])).get(conflict.path);
  // Both sides are regular files here, so the merged entry is one too.
  const regions =
    mergedOid === undefined ? [] : scanConflictRegions(await reader.text(mergedOid.oid));
  const cls: TextualConflictClass =
    shape.kind === 'add-add'
      ? 'add-add'
      : regions.some((region) => regionOverlaps(region) === true)
        ? 'overlapping-edit'
        : // Includes a region with no base and a file with no regions to read:
          // when it cannot tell, it says the weaker thing.
          'adjacent-addition';

  const mergedLines = mergedOid === undefined ? [] : await reader.lines(mergedOid.oid);
  const place = async (
    side: MergeConflictSide | null,
    which: 'ours' | 'theirs',
    branch: BranchRefId,
  ): Promise<SpanEvidence[]> => {
    // Both sides exist and are regular files, or the shape would not be text;
    // a side can still lack a path, when its blob sits at more than one.
    const path = side?.path ?? null;
    if (side === null || path === null || regions.length === 0) return [];
    const lines = await reader.lines(side.oid);
    const placed = placeRegions(mergedLines, regions, which, lines).slice(0, MAX_SPANS_PER_SIDE);
    const found = placed.filter((range): range is LineRange => range !== null);
    return spansFor(branch, path, side.oid, found, reader);
  };

  return {
    class: cls,
    spansA: await place(sides.sideA, 'ours', branchA),
    spansB: await place(sides.sideB, 'theirs', branchB),
    spansOmitted: Math.max(0, regions.length - MAX_SPANS_PER_SIDE),
  };
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

async function spansFor(
  branchRefId: BranchRefId,
  path: string,
  oid: string,
  ranges: readonly LineRange[],
  reader: BlobReader,
): Promise<SpanEvidence[]> {
  const lines = await reader.lines(oid);
  return ranges.map(([from, to]) => ({
    type: 'span',
    branchRefId,
    path,
    startLine: from + 1,
    endLine: to,
    excerpt: excerptOf(lines.slice(from, to)),
  }));
}

/** At most {@link MAX_EXCERPT_LINES} lines and {@link MAX_EXCERPT_CHARS} characters, redacted. */
export function excerptOf(lines: readonly string[]): string {
  const text = lines.slice(0, MAX_EXCERPT_LINES).join('\n');
  // By code point, so a cut never leaves half a surrogate pair.
  const cut = [...text].slice(0, MAX_EXCERPT_CHARS).join('');
  return redact(cut);
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
  const pairs = Math.max(examined.spansA.length, examined.spansB.length);
  for (let index = 0; index < pairs; index++) {
    const a = examined.spansA[index];
    const b = examined.spansB[index];
    if (a !== undefined) evidence.push(a);
    if (b !== undefined) evidence.push(b);
  }

  const omitted =
    examined.spansOmitted > 0
      ? ` ${examined.spansOmitted} further ${examined.spansOmitted === 1 ? 'region has' : 'regions have'} no span.`
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
}

/** Blob and tree reads for one classification, each object read at most once. */
class BlobReader {
  readonly #shadow: ShadowRepo;
  readonly #runner: GitRunner;
  readonly #texts = new Map<string, string>();
  readonly #listings = new Map<string, Map<string, string[]>>();

  constructor(shadow: ShadowRepo, runner: GitRunner) {
    this.#shadow = shadow;
    this.#runner = runner;
  }

  /** The entries of `tree` at exactly these paths; `-z`, since a path may hold a newline. */
  async list(tree: string, paths: readonly string[]): Promise<Map<string, TreeEntry>> {
    const found = new Map<string, TreeEntry>();
    for (const chunk of chunkPaths([...new Set(paths)])) {
      const listing = await runRequired(this.#runner, this.#shadow, [
        'ls-tree',
        '-z',
        '--full-tree',
        tree,
        '--',
        ...chunk,
      ]);
      for (const [path, entry] of parseListing(listing.stdout)) found.set(path, entry);
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
        byOid.set(entry.oid, [...(byOid.get(entry.oid) ?? []), path]);
      }
      this.#listings.set(commit, byOid);
    }
    const paths = byOid.get(oid) ?? [];
    return paths.length === 1 ? paths[0]! : null;
  }

  async text(oid: string): Promise<string> {
    const cached = this.#texts.get(oid);
    if (cached !== undefined) return cached;
    const blob = await runRequired(this.#runner, this.#shadow, ['cat-file', 'blob', oid]);
    this.#texts.set(oid, blob.stdout);
    return blob.stdout;
  }

  async lines(oid: string): Promise<string[]> {
    return (await this.text(oid)).split('\n');
  }
}

/** `<mode> SP <type> SP <object> TAB <path>`, NUL-terminated; blobs only. */
function parseListing(stdout: string): [string, TreeEntry][] {
  const entries: [string, TreeEntry][] = [];
  for (const record of stdout.split('\0')) {
    // The empty record after the last terminator has no tab, and no type.
    const tab = record.indexOf('\t');
    const [mode = '', type, oid = ''] = record.slice(0, tab).split(' ');
    if (type !== 'blob') continue;
    entries.push([record.slice(tab + 1), { mode, oid }]);
  }
  return entries;
}
