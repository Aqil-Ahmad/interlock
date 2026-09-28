import { describe, expect, it } from 'vitest';
import { ANALYZER_VERDICTS, isInterlockError, ulid } from '@interlock/shared';
import type {
  AgentSessionId,
  AnalyzerResult,
  BranchRef,
  BranchRefId,
  DirtyState,
  Evidence,
  Finding,
  FindingId,
  MergePair,
  MergePairId,
  InterlockError,
  RepoId,
  SpeculativeRunId,
} from '@interlock/shared';
import { makePairKey } from '@interlock/shared';
import {
  analyzerCacheParams,
  bool,
  branchRefParams,
  evidenceParams,
  json,
  mergePairParams,
  num,
  numOrNull,
  oneOf,
  text,
  textOrNull,
  toCachedVerdict,
  toBranchRef,
  toMergePair,
} from './rows.js';

/** Run `read` and return the error it threw, narrowed. */
function refusal(read: () => unknown): InterlockError {
  let caught: unknown;
  try {
    read();
  } catch (error: unknown) {
    caught = error;
  }
  if (!isInterlockError(caught))
    throw new Error(`expected an InterlockError, got: ${String(caught)}`);
  return caught;
}

/**
 * The mapping layer, where a distinction is lost silently rather than loudly.
 */
describe('column readers', () => {
  it('names the column and the type it expected', () => {
    const error = refusal(() => text({ head_sha: 7 }, 'head_sha'));

    expect(error.code).toBe('STORE_UNAVAILABLE');
    expect(error.message).toContain('head_sha');
    expect(error.infra).toBe(true);
  });

  it('separates a null column from a missing one', () => {
    expect(textOrNull({ cwd: null }, 'cwd')).toBeNull();
    // An absent column is `undefined`, which is not a value the schema can hold
    // — it means the query did not select it.
    expect(() => textOrNull({}, 'cwd')).toThrow();
  });

  it('reads numbers and rejects text in a numeric column', () => {
    expect(num({ priority: 10 }, 'priority')).toBe(10);
    expect(numOrNull({ duration_ms: null }, 'duration_ms')).toBeNull();
    expect(() => num({ priority: '10' }, 'priority')).toThrow();
    expect(() => numOrNull({ duration_ms: '10' }, 'duration_ms')).toThrow();
  });

  it('reads SQLite integers as booleans', () => {
    expect(bool({ stale: 0 }, 'stale')).toBe(false);
    expect(bool({ stale: 1 }, 'stale')).toBe(true);
  });

  it('refuses a value outside the set the model defines', () => {
    expect(oneOf({ verdict: 'clean' }, 'verdict', ANALYZER_VERDICTS)).toBe('clean');

    const error = refusal(() => oneOf({ verdict: 'probably-fine' }, 'verdict', ANALYZER_VERDICTS));

    expect(error.code).toBe('STORE_UNAVAILABLE');
    expect(error.message).toContain('verdict');
    expect(error.details).toEqual({
      column: 'verdict',
      expected: 'one of clean, findings, infra-failure, skipped, timeout',
    });
  });

  it('reports a JSON column that no longer parses rather than throwing SyntaxError', () => {
    const error = refusal(() => json({ files: '{"path":' }, 'files'));

    expect(error.code).toBe('STORE_UNAVAILABLE');
    expect(error.details).toEqual({ column: 'files' });
  });
});

describe('branch refs', () => {
  const base = (dirty: DirtyState | null): BranchRef => ({
    id: ulid<BranchRefId>(),
    repoId: ulid<RepoId>(),
    ref: 'refs/heads/feature',
    name: 'feature',
    headSha: 'a'.repeat(40),
    worktreePath: null,
    dirty,
    sessionId: null,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const clean: DirtyState = {
    isDirty: false,
    snapshotId: null,
    stagedFiles: [],
    unstagedFiles: [],
    untrackedFiles: [],
    capturedAt: '2026-01-01T00:00:00.000Z',
  };

  it('stores an unreadable worktree as SQL NULL, not as the string "null"', () => {
    // `JSON.stringify(null)` is the string "null", which reads back through
    // JSON.parse as a value — so the unknown state would return as a state.
    expect(branchRefParams(base(null)).dirty).toBeNull();
  });

  it('keeps unknown and clean apart across the round trip', () => {
    const unknown = toBranchRef({
      ...branchRefParams(base(null)),
      session_id: null,
    });
    const observed = toBranchRef({
      ...branchRefParams(base(clean)),
      session_id: null,
    });

    expect(unknown.dirty).toBeNull();
    expect(observed.dirty).toEqual(clean);
  });

  it('takes the session from the query rather than from the branch row', () => {
    const sessionId = ulid<AgentSessionId>();
    const ref = toBranchRef({ ...branchRefParams(base(null)), session_id: sessionId });

    expect(ref.sessionId).toBe(sessionId);
    // Nothing in the parameters carries it, which is what keeps a sweep that
    // reports no session from clearing one.
    expect(branchRefParams(base(null))).not.toHaveProperty('session_id');
  });
});

describe('merge pairs', () => {
  it('round-trips `stale` through SQLite integers', () => {
    const a = ulid<BranchRefId>();
    const b = ulid<BranchRefId>();
    const pair: MergePair = {
      id: ulid<MergePairId>(),
      repoId: ulid<RepoId>(),
      a,
      b,
      key: makePairKey(a, b),
      mergeBaseSha: 'b'.repeat(40),
      priority: 3,
      lastRunAt: null,
      stale: true,
    };

    const params = mergePairParams(pair);
    expect(params.stale).toBe(1);
    expect(toMergePair(params)).toEqual(pair);
  });
});

describe('analyzer cache', () => {
  const result: AnalyzerResult = {
    analyzer: 'typecheck',
    verdict: 'findings',
    findingIds: [ulid<FindingId>()],
    durationMs: 1200,
    cached: false,
    diagnostic: null,
  };

  it('answers `cached` rather than storing it', () => {
    const params = analyzerCacheParams(
      'k',
      { result, runId: ulid<SpeculativeRunId>(), findings: [] },
      '2026-01-01T00:00:00.000Z',
    );

    expect(params).not.toHaveProperty('cached');
    // A result that reached this table was cached by the act of reading it, so
    // storing the flag would only record how some earlier caller got it.
    expect(toCachedVerdict({ ...params }).result.cached).toBe(true);
  });

  describe('the Findings a hit writes back', () => {
    const [a, b] = [ulid<BranchRefId>(), ulid<BranchRefId>()];
    const valid: Finding = {
      id: ulid<FindingId>(),
      runId: ulid<SpeculativeRunId>(),
      kind: 'textual',
      rule: 'overlapping-edit',
      severity: 'high',
      confidence: 1,
      status: 'open',
      title: 'Both branches edited total.ts',
      description: 'total.ts',
      attribution: { branchA: a, branchB: b, originBranch: null, rationale: 'both' },
      evidence: [
        { type: 'span', branchRefId: a, path: 'total.ts', startLine: 1, endLine: 2, excerpt: 'x' },
      ],
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      resolvedAt: null,
    };
    const rowWith = (findings: unknown) => ({
      ...analyzerCacheParams(
        'k',
        { result, runId: ulid<SpeculativeRunId>(), findings: [] },
        '2026-01-01T00:00:00.000Z',
      ),
      findings: JSON.stringify(findings),
    });

    it('reads back what was written', () => {
      expect(toCachedVerdict(rowWith([valid])).findings).toEqual([valid]);
    });

    // One field wrong at a time, each of which would otherwise be written into
    // the findings table and fail every later read of the repository's.
    it.each([
      ['not a list', valid],
      ['an item that is not an object', ['finding']],
      ['a missing id', [{ ...valid, id: undefined }]],
      ['an unknown kind', [{ ...valid, kind: 'guess' }]],
      ['an unknown severity', [{ ...valid, severity: 'bogus' }]],
      ['an unknown status', [{ ...valid, status: 'maybe' }]],
      ['a confidence that is not a number', [{ ...valid, confidence: '1' }]],
      ['a resolvedAt that is neither text nor null', [{ ...valid, resolvedAt: 0 }]],
      ['no attribution', [{ ...valid, attribution: null }]],
      [
        'an attribution missing a branch',
        [{ ...valid, attribution: { ...valid.attribution, branchB: 1 } }],
      ],
      [
        'an attribution without its rationale',
        [{ ...valid, attribution: { ...valid.attribution, rationale: null } }],
      ],
      [
        'an origin that is neither text nor null',
        [{ ...valid, attribution: { ...valid.attribution, originBranch: 7 } }],
      ],
      ['evidence that is not a list', [{ ...valid, evidence: {} }]],
      ['evidence with no type', [{ ...valid, evidence: [{ path: 'total.ts' }] }]],
      ['evidence that is not an object', [{ ...valid, evidence: [null] }]],
    ] as const)('refuses %s', (_, findings) => {
      const error = refusal(() => toCachedVerdict(rowWith(findings)));
      expect(error.code).toBe('STORE_UNAVAILABLE');
      expect(error.details).toMatchObject({ column: 'findings' });
    });
  });
});

describe('evidence', () => {
  it('lifts the discriminator out of the body so it can be queried', () => {
    const evidence: Evidence = {
      type: 'span',
      branchRefId: ulid<BranchRefId>(),
      path: 'src/a.ts',
      startLine: 1,
      endLine: 2,
      excerpt: 'x',
    };

    const params = evidenceParams(ulid<FindingId>(), 0, evidence);

    expect(params.type).toBe('span');
    expect(JSON.parse(params.body as string)).toEqual(evidence);
  });
});
