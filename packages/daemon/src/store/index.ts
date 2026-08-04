import { notImplemented } from '@interlock/shared';
import type {
  AgentSession,
  BranchRef,
  ChangeSet,
  EventRecord,
  Finding,
  MergePair,
  Repo,
  SpeculativeRun,
} from '@interlock/shared';

/**
 * SQLite persistence (ADR-0003).
 *
 * Migrations exist from the first schema onward: the store outlives every
 * refactor, and a corrupt local database costs an afternoon.
 *
 * The database lives under the Interlock data dir with 0700 permissions. It
 * holds no secrets and no full file contents — evidence stores spans and
 * truncated excerpts.
 */

export interface Store {
  // Entities
  upsertRepo(repo: Repo): Promise<void>;
  listRepos(): Promise<Repo[]>;

  upsertBranchRef(ref: BranchRef): Promise<void>;
  listBranchRefs(repoId: Repo['id']): Promise<BranchRef[]>;

  upsertSession(session: AgentSession): Promise<void>;
  upsertChangeSet(changeSet: ChangeSet): Promise<void>;
  upsertMergePair(pair: MergePair): Promise<void>;
  upsertRun(run: SpeculativeRun): Promise<void>;

  upsertFinding(finding: Finding): Promise<void>;
  listOpenFindings(repoId: Repo['id']): Promise<Finding[]>;

  /** Append-only: there is no update or delete path for events. */
  appendEvent(record: EventRecord): Promise<void>;
  /** Replay in id order; ULIDs sort by creation time. */
  readEvents(since?: EventRecord['id']): AsyncIterable<EventRecord>;

  /** Cached analyzer verdict for (snapshotA, snapshotB, analyzer, toolchain). */
  getCachedVerdict(key: string): Promise<SpeculativeRun['analyzerResults'][number] | null>;
  putCachedVerdict(key: string, result: SpeculativeRun['analyzerResults'][number]): Promise<void>;

  /** Enforce retention: prune old runs and events beyond the configured window. */
  prune(before: string): Promise<number>;

  close(): Promise<void>;
}

export interface StoreOptions {
  /** Absolute path to the SQLite file, or `:memory:` in tests. */
  readonly path: string;
}

export function openStore(_options: StoreOptions): Promise<Store> {
  return notImplemented('openStore', 'M1');
}

export * from './migrations/index.js';
