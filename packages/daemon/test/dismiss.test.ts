import { createLogger, isInterlockError, makePairKey, ulid } from '@interlock/shared';
import type {
  BranchRefId,
  EventId,
  EventRecord,
  Finding,
  FindingId,
  LogRecord,
  MergePairId,
  RepoId,
  SnapshotId,
  SpeculativeRunId,
} from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { budgetReport } from '../src/budget.js';
import { EventBus } from '../src/bus/index.js';
import { createDismissals, parseDismissRequest, parseFindingId } from '../src/dismiss.js';
import type { Dismissals } from '../src/dismiss.js';
import { openStore } from '../src/store/index.js';
import type { Store } from '../src/store/index.js';
import { rejection } from './support/rejection.js';

/**
 * Dismissing a Finding, and the budget read back from what dismissals count,
 * against a real store and bus: the refusals, the event and its cause, and
 * what a window counts.
 */

const AT = '2026-10-06T14:35:00.000Z';

describe('dismissals', () => {
  let store: Store;
  let bus: EventBus;
  let records: EventRecord[];
  let logs: LogRecord[];
  let dismissals: Dismissals;
  let repoId: RepoId;
  let a: BranchRefId;
  let b: BranchRefId;
  let runId: SpeculativeRunId;

  const conflict = (overrides: Partial<Finding> = {}): Finding => ({
    id: ulid<FindingId>(),
    runId,
    kind: 'textual',
    rule: 'overlapping-edit',
    severity: 'medium',
    confidence: 1,
    status: 'open',
    title: 'Both branches changed the same lines',
    description: '',
    attribution: { branchA: a, branchB: b, originBranch: null, rationale: '' },
    evidence: [
      {
        type: 'merge-conflict',
        mergeBaseSha: 'b'.repeat(40),
        commitA: 'c'.repeat(40),
        commitB: 'd'.repeat(40),
        path: 'config.ts',
        conflictTypes: ['CONFLICT (contents)'],
        base: { path: 'config.ts', mode: '100644', oid: '1'.repeat(40) },
        sideA: { path: 'config.ts', mode: '100644', oid: '2'.repeat(40) },
        sideB: { path: 'config.ts', mode: '100644', oid: '3'.repeat(40) },
      },
    ],
    firstSeenAt: '2026-10-06T14:00:00.000Z',
    updatedAt: '2026-10-06T14:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  });

  /** Raised as a run raises one: the row and its counted raise, then its event. */
  const raise = async (finding: Finding): Promise<EventId> => {
    await store.raiseFinding(finding);
    return bus.publish({
      type: 'finding.raised',
      repoId,
      at: finding.firstSeenAt,
      findingId: finding.id,
      runId: finding.runId,
      kind: finding.kind,
      rule: finding.rule,
    });
  };

  const refusal = async (work: Promise<unknown>): Promise<{ code: string; message: string }> => {
    const error = await rejection(work);
    return { code: error.code, message: error.message };
  };

  beforeEach(async () => {
    store = await openStore({ path: ':memory:' });
    records = [];
    logs = [];
    const logger = createLogger('test', { level: 'info', sink: (record) => logs.push(record) });
    bus = new EventBus({
      logger,
      onRecord: (record) => {
        records.push(record);
        void store.appendEvent(record);
      },
    });
    dismissals = createDismissals({ store, bus, logger, now: () => Date.parse(AT) });
    repoId = (
      await store.upsertRepo({
        id: ulid<RepoId>(),
        rootPath: '/repos/main',
        defaultBranch: 'main',
        shadowPath: '/data/shadows/x',
        config: {},
        discoveredAt: AT,
        lastSeenAt: AT,
      })
    ).id;
    const branch = async (name: string): Promise<BranchRefId> =>
      (
        await store.upsertBranchRef({
          id: ulid<BranchRefId>(),
          repoId,
          ref: `refs/heads/${name}`,
          name,
          headSha: 'a'.repeat(40),
          worktreePath: null,
          dirty: null,
          sessionId: null,
          firstSeenAt: AT,
          updatedAt: AT,
        })
      ).id;
    a = await branch('a');
    b = await branch('b');
    const pair = await store.upsertMergePair({
      id: ulid<MergePairId>(),
      repoId,
      a,
      b,
      key: makePairKey(a, b),
      mergeBaseSha: 'b'.repeat(40),
      priority: 0,
      lastRunAt: null,
      stale: false,
    });
    runId = ulid<SpeculativeRunId>();
    await store.upsertRun({
      id: runId,
      mergePairId: pair.id,
      snapshotA: ulid<SnapshotId>(),
      snapshotB: ulid<SnapshotId>(),
      status: 'complete',
      mergeOutcome: null,
      analyzerResults: [],
      findingIds: [],
      startedAt: AT,
      finishedAt: AT,
      durationMs: 1,
    });
  });

  afterEach(async () => {
    await store.close();
  });

  describe('the request', () => {
    it('takes a reason and an optional note', () => {
      expect(parseDismissRequest({ reason: 'wrong' })).toEqual({ reason: 'wrong', note: null });
      expect(parseDismissRequest({ reason: 'known', note: null })).toEqual({
        reason: 'known',
        note: null,
      });
      expect(parseDismissRequest({ reason: 'known', note: 'x'.repeat(500) })).toEqual({
        reason: 'known',
        note: 'x'.repeat(500),
      });
    });

    it('refuses a missing or unknown reason, a bad note and an unknown key, naming each', () => {
      const problems = (body: unknown): string[] => {
        try {
          parseDismissRequest(body);
        } catch (error) {
          if (isInterlockError(error) && error.code === 'API_REQUEST_INVALID') {
            return error.details.problems as string[];
          }
          throw error;
        }
        throw new Error('expected a refusal');
      };

      expect(problems({})).toEqual(['reason must be one of wrong, known']);
      expect(problems({ reason: 'meh' })).toEqual(['reason must be one of wrong, known']);
      expect(problems({ reason: 'wrong', note: '' })).toEqual(['note must be non-empty text']);
      expect(problems({ reason: 'wrong', note: 7 })).toEqual(['note must be non-empty text']);
      expect(problems({ reason: 'wrong', note: 'x'.repeat(501) })).toEqual([
        'note is longer than 500 characters',
      ]);
      expect(problems({ reason: 'wrong', why: 'x' })).toEqual(['unknown field "why"']);
      expect(problems({ reason: 'meh', note: '', extra: 1 })).toHaveLength(3);
      expect(problems(null)).toEqual(['the body must be a JSON object']);
      expect(problems(['wrong'])).toEqual(['the body must be a JSON object']);
    });

    it('takes a Finding id and nothing that is not one', () => {
      const id = ulid<FindingId>();
      expect(parseFindingId(id)).toBe(id);
      for (const segment of ['nope', id.slice(0, 10), `${id}x`, '../x']) {
        expect(() => parseFindingId(segment), segment).toThrow(/not a Finding id/u);
      }
    });
  });

  it('dismisses an open Finding, traced to the event that raised it', async () => {
    const finding = conflict();
    const raised = await raise(finding);

    const dismissed = await dismissals.dismiss(finding.id, { reason: 'wrong', note: 'rerere' });

    expect(dismissed).toMatchObject({
      id: finding.id,
      status: 'dismissed',
      dismissal: { reason: 'wrong', note: 'rerere', dismissedAt: AT },
    });
    expect(await store.getFinding(finding.id)).toEqual(dismissed);
    const event = records.find((record) => record.type === 'finding.dismissed')!;
    expect(event.causedBy).toBe(raised);
    expect(event.repoId).toBe(repoId);
    expect(event.payload).toEqual({
      type: 'finding.dismissed',
      repoId,
      at: AT,
      findingId: finding.id,
      runId,
      kind: 'textual',
      rule: 'overlapping-edit',
      reason: 'wrong',
    });
  });

  it('still dismisses one whose raise the log no longer holds, and says so', async () => {
    const finding = conflict();
    await store.raiseFinding(finding);

    await dismissals.dismiss(finding.id, { reason: 'known', note: null });

    const event = records.find((record) => record.type === 'finding.dismissed')!;
    expect(event.causedBy).toBeNull();
    expect(logs.map((record) => record.msg)).toContain(
      'dismissed a Finding whose raise the log no longer holds',
    );
  });

  it('refuses a Finding it does not hold', async () => {
    expect(
      await refusal(dismissals.dismiss(ulid<FindingId>(), { reason: 'wrong', note: null })),
    ).toMatchObject({ code: 'FINDING_NOT_FOUND' });
  });

  it('refuses one already resolved, and one already dismissed, changing neither', async () => {
    const resolved = conflict({ status: 'resolved', resolvedAt: AT });
    const dismissed = conflict();
    await raise(resolved);
    await raise(dismissed);
    await dismissals.dismiss(dismissed.id, { reason: 'wrong', note: null });

    expect(await refusal(dismissals.dismiss(resolved.id, { reason: 'wrong', note: null }))).toEqual(
      {
        code: 'FINDING_NOT_DISMISSABLE',
        message: 'The Finding is already resolved',
      },
    );
    expect(
      await refusal(dismissals.dismiss(dismissed.id, { reason: 'known', note: null })),
    ).toEqual({ code: 'FINDING_NOT_DISMISSABLE', message: 'The Finding is already dismissed' });
    expect(await store.getFinding(resolved.id)).toEqual(resolved);
    expect((await store.getFinding(dismissed.id))?.dismissal?.reason).toBe('wrong');
    expect(records.filter((record) => record.type === 'finding.dismissed')).toHaveLength(1);
  });

  it('refuses one with nothing to recognise its conflict by, and one of another kind', async () => {
    const unplaced = conflict({ evidence: [] });
    const typecheck = conflict({ kind: 'typecheck' });
    await raise(unplaced);
    await raise(typecheck);

    for (const finding of [unplaced, typecheck]) {
      expect(
        await refusal(dismissals.dismiss(finding.id, { reason: 'wrong', note: null })),
      ).toEqual({
        code: 'FINDING_NOT_DISMISSABLE',
        message: 'The Finding has nothing to recognise its conflict by again',
      });
      expect((await store.getFinding(finding.id))?.status).toBe('open');
    }
  });

  it('refuses one a run resolved between reading it and writing the dismissal', async () => {
    const finding = conflict();
    await raise(finding);
    // A run lands after the dismissal read the Finding open.
    const racing = {
      getFinding: async (id: FindingId) => {
        const read = await store.getFinding(id);
        await store.upsertFinding({ ...finding, status: 'resolved', resolvedAt: AT });
        return read;
      },
      dismissFinding: store.dismissFinding.bind(store),
      raisedEventOf: store.raisedEventOf.bind(store),
    } as unknown as Store;
    const raced = createDismissals({ store: racing, bus, logger: createLogger('test') });

    expect(await refusal(raced.dismiss(finding.id, { reason: 'wrong', note: null }))).toEqual({
      code: 'FINDING_NOT_DISMISSABLE',
      message: 'The Finding was resolved meanwhile',
    });
    expect((await store.getFinding(finding.id))?.status).toBe('resolved');
    expect(records.filter((record) => record.type === 'finding.dismissed')).toEqual([]);
  });

  describe('the budget', () => {
    const now = Date.parse(AT);

    it('names each window by the hour it starts, the current hour included', async () => {
      const report = await budgetReport(store, now);

      expect(report.windows.map(({ hours, since, until }) => ({ hours, since, until }))).toEqual([
        { hours: 24, since: '2026-10-05T15:00:00.000Z', until: AT },
        { hours: 168, since: '2026-09-29T15:00:00.000Z', until: AT },
      ]);
    });

    it('reports no data, not 0%, with nothing raised, and delivered as not measured', async () => {
      const [day] = (await budgetReport(store, now)).windows;

      expect(day).toMatchObject({
        raised: 0,
        dismissedWrong: 0,
        dismissedKnown: 0,
        rate: null,
        delivered: null,
        rules: [],
      });
    });

    it('counts a window from its first hour, and leaves out the hour before', async () => {
      await raise(conflict({ firstSeenAt: '2026-10-05T15:00:00.000Z' }));
      await raise(conflict({ firstSeenAt: '2026-10-05T14:59:59.999Z' }));
      await raise(conflict({ firstSeenAt: AT }));

      const [day, week] = (await budgetReport(store, now)).windows;

      expect(day!.raised).toBe(2);
      expect(week!.raised).toBe(3);
    });

    it('counts only a dismissal as wrong as false, and ranks rules by it', async () => {
      const findings = [
        conflict({ rule: 'overlapping-edit' }),
        conflict({ rule: 'overlapping-edit' }),
        conflict({ rule: 'overlapping-edit' }),
        conflict({ rule: 'modify-delete' }),
        conflict({ rule: 'modify-delete' }),
        conflict({ rule: 'add-add' }),
      ];
      for (const finding of findings) await raise(finding);
      await dismissals.dismiss(findings[0]!.id, { reason: 'known', note: null });
      await dismissals.dismiss(findings[3]!.id, { reason: 'wrong', note: null });
      await dismissals.dismiss(findings[4]!.id, { reason: 'wrong', note: null });

      const [day] = (await budgetReport(store, now)).windows;

      expect(day).toMatchObject({ raised: 6, dismissedWrong: 2, dismissedKnown: 1, rate: 2 / 6 });
      expect(day!.rules).toEqual([
        {
          kind: 'textual',
          rule: 'modify-delete',
          raised: 2,
          dismissedWrong: 2,
          dismissedKnown: 0,
          rate: 1,
        },
        {
          kind: 'textual',
          rule: 'overlapping-edit',
          raised: 3,
          dismissedWrong: 0,
          dismissedKnown: 1,
          rate: 0,
        },
        {
          kind: 'textual',
          rule: 'add-add',
          raised: 1,
          dismissedWrong: 0,
          dismissedKnown: 0,
          rate: 0,
        },
      ]);
    });

    it('counts a dismissal with the Findings raised beside it, whenever it was made', async () => {
      const old = conflict({ firstSeenAt: '2026-10-01T09:00:00.000Z' });
      await raise(old);
      await dismissals.dismiss(old.id, { reason: 'wrong', note: null });

      const [day, week] = (await budgetReport(store, now)).windows;

      // Dismissed today, raised five days ago: today's window raised nothing,
      // so it has nothing to be wrong about.
      expect(day).toMatchObject({ raised: 0, dismissedWrong: 0, rate: null });
      expect(week).toMatchObject({ raised: 1, dismissedWrong: 1, rate: 1 });
    });
  });
});
