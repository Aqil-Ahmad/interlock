import { notImplemented } from '@interlock/shared';
import type { BranchRefId, Finding, SpeculativeRunId } from '@interlock/shared';
import type { ConflictBlock } from './speculative-merge.js';

/**
 * Turns raw git conflict regions into Findings with evidence.
 *
 * Classification drives ranking: "both branches edited the same line of the
 * same function" needs a different severity from "both added an import at the
 * top of the file", though git reports them identically.
 */

export type TextualConflictClass =
  /** Same lines changed differently on both sides. */
  | 'overlapping-edit'
  /** Both sides appended to the same region (imports, exports, switch arms). */
  | 'adjacent-addition'
  /** One side deleted what the other modified. */
  | 'delete-vs-modify'
  /** One side renamed a file the other changed. */
  | 'rename-vs-modify'
  /** Both sides added a file at the same path. */
  | 'add-add';

export interface ClassifyRequest {
  readonly runId: SpeculativeRunId;
  readonly branchA: BranchRefId;
  readonly branchB: BranchRefId;
  readonly blocks: readonly ConflictBlock[];
}

export function classifyTextualConflicts(_request: ClassifyRequest): Finding[] {
  return notImplemented('classifyTextualConflicts', 'M2');
}
