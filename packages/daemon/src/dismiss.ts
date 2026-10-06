import { textualFindingContent, textualFindingKey } from '@interlock/core';
import {
  DISMISSAL_REASONS,
  InterlockError,
  MAX_DISMISSAL_NOTE_LENGTH,
  isUlid,
} from '@interlock/shared';
import type { DismissalReason, Finding, FindingId, Logger } from '@interlock/shared';
import type { EventBus } from './bus/index.js';
import type { Store } from './store/index.js';

/**
 * `interlock dismiss`, on the daemon's side: a human saying a Finding is wrong,
 * or known, and the daemon holding it to that for as long as the conflict
 * stands at the content they judged.
 *
 * Holding it is reconciliation's work; this records the verdict, counts it,
 * and says so on the bus.
 */

/** What a caller asks for, once validated. */
export interface DismissRequest {
  readonly reason: DismissalReason;
  readonly note: string | null;
}

export interface Dismissals {
  /**
   * Dismiss one Finding, returning it as dismissed.
   *
   * @throws InterlockError `FINDING_NOT_FOUND` for an id the store does not
   *         hold; `FINDING_NOT_DISMISSABLE` for one resolved, dismissed
   *         already, or with nothing to recognise its conflict by again.
   */
  dismiss(id: FindingId, request: DismissRequest): Promise<Finding>;
}

export interface DismissalsOptions {
  readonly store: Store;
  readonly bus: EventBus;
  readonly logger: Logger;
  /** The clock a dismissal is stamped from. */
  readonly now?: () => number;
}

const DISMISS_KEYS: ReadonlySet<string> = new Set(['reason', 'note']);

/**
 * Validate a dismissal body.
 *
 * The same discipline as a check: every field checked, every unknown key
 * refused, every problem reported at once. The reason has no default — a
 * default would decide the false-positive rate for whoever did not choose.
 *
 * @throws InterlockError `API_REQUEST_INVALID`, naming every problem.
 */
export function parseDismissRequest(body: unknown): DismissRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid(['the body must be a JSON object']);
  }
  const record = body as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(record)) {
    if (!DISMISS_KEYS.has(key)) problems.push(`unknown field ${JSON.stringify(key)}`);
  }
  const reason = record.reason;
  const known = (DISMISSAL_REASONS as readonly unknown[]).includes(reason);
  if (!known) problems.push(`reason must be one of ${DISMISSAL_REASONS.join(', ')}`);
  let note: string | null = null;
  if (record.note !== undefined && record.note !== null) {
    if (typeof record.note !== 'string' || record.note === '') {
      problems.push('note must be non-empty text');
    } else if (record.note.length > MAX_DISMISSAL_NOTE_LENGTH) {
      problems.push(`note is longer than ${String(MAX_DISMISSAL_NOTE_LENGTH)} characters`);
    } else {
      note = record.note;
    }
  }
  if (problems.length > 0) throw invalid(problems);
  return { reason: reason as DismissalReason, note };
}

/**
 * A Finding id from a request path.
 *
 * Checked for shape before the store is asked, so a path segment that is no
 * id is the caller's mistake and says so, rather than reading as a Finding
 * that went away.
 *
 * @throws InterlockError `API_REQUEST_INVALID` for anything that is not a ULID.
 */
export function parseFindingId(segment: string): FindingId {
  if (!isUlid(segment)) {
    throw new InterlockError('API_REQUEST_INVALID', 'That is not a Finding id', {
      remedy: 'Pass the whole 26-character id `interlock check` prints for the Finding.',
    });
  }
  return segment as FindingId;
}

export function createDismissals(options: DismissalsOptions): Dismissals {
  const { store, bus } = options;
  const log = options.logger.child('dismiss');
  const now = options.now ?? Date.now;

  const dismiss = async (id: FindingId, request: DismissRequest): Promise<Finding> => {
    const finding = await store.getFinding(id);
    if (finding === null) {
      throw new InterlockError('FINDING_NOT_FOUND', 'No such Finding', {
        details: { findingId: id },
        remedy:
          'Run `interlock check` on the pair for the ids of its open Findings; a resolved one may have been pruned.',
      });
    }
    // Refused rather than dismissed alone: a dismissal that cannot recognise
    // its conflict on the next run would last one run, and the Finding would
    // be raised again under a new id.
    if (textualFindingKey(finding) === null || textualFindingContent(finding) === null) {
      throw notDismissable(id, 'The Finding has nothing to recognise its conflict by again');
    }
    if (finding.status === 'resolved') {
      throw notDismissable(id, 'The Finding is already resolved');
    }
    if (finding.status === 'dismissed') {
      throw notDismissable(id, 'The Finding is already dismissed');
    }

    const dismissedAt = new Date(now()).toISOString();
    const dismissed = await store.dismissFinding(id, {
      reason: request.reason,
      note: request.note,
      dismissedAt,
    });
    // Resolved by a run between the read and the write, which the write
    // refused rather than dismissing over.
    if (dismissed === null) throw notDismissable(id, 'The Finding was resolved meanwhile');

    // The event that raised it: what the dismissal is about, and through it
    // the run and the edit. The log keeps it while the Finding is live.
    const raised = await store.raisedEventOf(id);
    await bus.publish(
      {
        type: 'finding.dismissed',
        repoId: dismissed.repoId,
        at: dismissedAt,
        findingId: id,
        runId: finding.runId,
        kind: finding.kind,
        rule: finding.rule,
        reason: request.reason,
      },
      raised === null ? {} : { causedBy: raised },
    );
    if (raised === null) {
      log.warn('dismissed a Finding whose raise the log no longer holds', { findingId: id });
    }
    log.info('dismissed a Finding', {
      findingId: id,
      repoId: dismissed.repoId,
      rule: finding.rule,
      reason: request.reason,
    });
    return dismissed.finding;
  };

  return { dismiss };
}

function notDismissable(id: FindingId, message: string): InterlockError {
  return new InterlockError('FINDING_NOT_DISMISSABLE', message, {
    details: { findingId: id },
    remedy: 'Only an open Finding can be dismissed. `interlock check` lists the open ones.',
  });
}

function invalid(problems: readonly string[]): InterlockError {
  return new InterlockError('API_REQUEST_INVALID', 'The dismissal is invalid', {
    details: { problems },
    remedy: `Fix: ${problems.join('; ')}.`,
  });
}
