import type { EventId, RepoId } from '../ids.js';
import type { InterlockEvent } from '../events/index.js';

/**
 * Append-only log of every bus event.
 *
 * Backs replay debugging and makes each Finding traceable to the events that
 * produced it.
 */
export interface EventRecord {
  readonly id: EventId;
  readonly repoId: RepoId | null;
  readonly type: InterlockEvent['type'];
  readonly payload: InterlockEvent;
  readonly at: string;
  /** Event that caused this one. */
  readonly causedBy: EventId | null;
}
