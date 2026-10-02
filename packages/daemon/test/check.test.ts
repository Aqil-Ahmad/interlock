import { InterlockError, makePairKey, silentLogger, ulid } from '@interlock/shared';
import type {
  BranchRef,
  BranchRefId,
  Finding,
  FindingId,
  MergePairId,
  Repo,
  RepoId,
  SpeculativeRunId,
} from '@interlock/shared';
import { describe, expect, it } from 'vitest';
import { createChecks } from '../src/check.js';
import type { CheckRequest, Checks, ChecksOptions } from '../src/check.js';
import type { CheckOutcome, PairCandidate, PairRunResult } from '../src/scheduler/index.js';
import type { Store } from '../src/store/index.js';

/**
 * The check's own decisions, against fakes: when a run's outcome is an answer,
 * when it is a reason to ask again, and what each refusal says. That it merges
 * a real pair through a real daemon is the CLI's end-to-end suite.
 */
describe('a check', () => {
  const repoId = ulid<RepoId>();
  const repo: Repo = {
    id: repoId,
    rootPath: '/repo',
    defaultBranch: 'main',
    shadowPath: '/data/shadow',
    config: {},
    discoveredAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
  };
  const branch = (name: string): BranchRef => ({
    id: ulid<BranchRefId>(),
    repoId,
    ref: `refs/heads/${name}`,
    name,
    headSha: 'a'.repeat(40),
    worktreePath: null,
    dirty: null,
    sessionId: null,
    firstSeenAt: repo.discoveredAt,
    updatedAt: repo.discoveredAt,
  });
  const [main, one, two, three] = ['main', 'one', 'two', 'three'].map(branch) as [
    BranchRef,
    BranchRef,
    BranchRef,
    BranchRef,
  ];

  const finding = (a: BranchRefId, b: BranchRefId): Finding => ({
    id: ulid<FindingId>(),
    runId: ulid<SpeculativeRunId>(),
    kind: 'textual',
    rule: 'overlapping-edit',
    severity: 'medium',
    confidence: 1,
    status: 'open',
    title: 'Conflict',
    description: '',
    attribution: { branchA: a, branchB: b, originBranch: null, rationale: '' },
    evidence: [],
    firstSeenAt: repo.discoveredAt,
    updatedAt: repo.discoveredAt,
    resolvedAt: null,
  });

  const analysed: PairRunResult = {
    kind: 'analysed',
    runId: ulid<SpeculativeRunId>(),
    contentKey: 'k',
    clean: false,
    cached: false,
    findingCount: 1,
    finished: ulid(),
  };

  interface Harness {
    readonly checks: Checks;
    readonly calls: string[];
  }

  /** A check whose runs come back as `outcomes`, one per run, the last repeated. */
  const harness = (
    outcomes: readonly (CheckOutcome | (() => Promise<CheckOutcome>))[],
    overrides: Partial<ChecksOptions> = {},
    findings: readonly Finding[] = [],
  ): Harness => {
    const calls: string[] = [];
    let run = 0;
    const store = {
      listRepos: () => Promise.resolve([repo]),
      listBranchRefs: () => {
        calls.push('branches');
        return Promise.resolve([main, one, two, three]);
      },
      listOpenFindings: () => Promise.resolve([...findings]),
    } as unknown as Store;
    const checks = createChecks({
      store,
      refreshRepo: (rootPath) => {
        calls.push(`refresh ${rootPath}`);
        return Promise.resolve();
      },
      planPair: (_repo, a, b) => {
        calls.push('plan');
        const [x, y] = a < b ? [a, b] : [b, a];
        const candidate: PairCandidate = {
          pair: {
            id: ulid<MergePairId>(),
            repoId,
            a: x,
            b: y,
            key: makePairKey(x, y),
            mergeBaseSha: 'b'.repeat(40),
            priority: 0,
            lastRunAt: null,
            stale: true,
          },
          overlap: { tier: 'none', commonFiles: [] },
          target: false,
          openFindings: false,
        };
        return Promise.resolve(candidate);
      },
      check: () => {
        calls.push('run');
        const next = outcomes[Math.min(run++, outcomes.length - 1)]!;
        return typeof next === 'function' ? next() : Promise.resolve(next);
      },
      logger: silentLogger,
      ...overrides,
    });
    return { checks, calls };
  };

  const ask = (
    checks: Checks,
    request: Partial<CheckRequest> = {},
    signal = new AbortController().signal,
  ) => checks.run(repoId, { a: 'one', b: 'two', timeoutMs: 5_000, ...request }, signal);

  it('refreshes the repository before it reads a branch name, and answers with the pair', async () => {
    const { checks, calls } = harness([{ kind: 'landed', result: analysed }]);

    const report = await ask(checks);

    expect(calls).toEqual(['refresh /repo', 'branches', 'plan', 'run']);
    expect(report).toMatchObject({ a: { name: 'one' }, b: { name: 'two' }, clean: true });
  });

  it("reports the pair's open Findings, and only that pair's", async () => {
    const mine = finding(two.id, one.id);
    const { checks } = harness([{ kind: 'landed', result: analysed }], {}, [
      mine,
      finding(one.id, three.id),
    ]);

    const report = await ask(checks);

    expect(report.clean).toBe(false);
    expect(report.findings).toEqual([mine]);
  });

  it('answers a duplicate with the pair as it stands, not as clean', async () => {
    const { checks } = harness(
      [{ kind: 'landed', result: { kind: 'duplicate', contentKey: 'k' } }],
      {},
      [finding(one.id, two.id)],
    );
    expect((await ask(checks)).clean).toBe(false);
  });

  it('resolves a full ref, and one name against the default branch', async () => {
    const { checks } = harness([{ kind: 'landed', result: analysed }]);
    expect(await ask(checks, { a: 'refs/heads/one', b: null })).toMatchObject({
      a: { name: 'one' },
      b: { name: 'main' },
    });
  });

  it('asks again, planned afresh, for a run superseded or stale', async () => {
    const stale = new InterlockError('SNAPSHOT_STALE', 'gone', { infra: true });
    const { checks, calls } = harness([
      { kind: 'landed', result: { kind: 'superseded' } },
      { kind: 'failed', error: stale },
      { kind: 'landed', result: analysed },
    ]);

    await ask(checks);

    expect(calls.filter((call) => call === 'plan')).toHaveLength(3);
    expect(calls.filter((call) => call === 'run')).toHaveLength(3);
  });

  it('gives up on a pair that never holds still, saying why', async () => {
    const { checks, calls } = harness([{ kind: 'landed', result: { kind: 'superseded' } }]);

    await expect(ask(checks)).rejects.toMatchObject({ code: 'SNAPSHOT_STALE', infra: true });
    expect(calls.filter((call) => call === 'run')).toHaveLength(4);
  });

  it.each([
    [{ kind: 'skipped', reason: 'unrelated' }, 'BRANCHES_UNRELATED', false],
    [{ kind: 'skipped', reason: 'branch-gone' }, 'BRANCH_NOT_FOUND', false],
    [{ kind: 'skipped', reason: 'unborn' }, 'BRANCH_NOT_FOUND', false],
    [{ kind: 'skipped', reason: 'unreadable' }, 'GIT_COMMAND_FAILED', true],
    [{ kind: 'infra-failure', component: 'textual', message: 'x' }, 'ANALYZER_INFRA_FAILURE', true],
  ] as const)('turns %j into %s, never into an answer', async (result, code, infra) => {
    const { checks } = harness([{ kind: 'landed', result }]);
    await expect(ask(checks)).rejects.toMatchObject({ code, infra });
  });

  it('passes on what a run threw', async () => {
    const { checks } = harness([{ kind: 'failed', error: new Error('a bug') }]);
    await expect(ask(checks)).rejects.toThrow('a bug');
  });

  it('refuses an unknown name, listing the branches there are', async () => {
    const { checks, calls } = harness([{ kind: 'landed', result: analysed }]);
    await expect(ask(checks, { a: 'nope' })).rejects.toMatchObject({
      code: 'BRANCH_NOT_FOUND',
      remedy: 'Branches: main, one, three, two.',
    });
    expect(calls).not.toContain('run');
  });

  it('refuses a branch against itself, and the default branch against itself', async () => {
    const { checks } = harness([{ kind: 'landed', result: analysed }]);
    await expect(ask(checks, { a: 'one', b: 'refs/heads/one' })).rejects.toMatchObject({
      code: 'API_REQUEST_INVALID',
    });
    await expect(ask(checks, { a: 'main', b: null })).rejects.toMatchObject({
      code: 'API_REQUEST_INVALID',
      remedy: expect.stringContaining('default branch') as unknown,
    });
  });

  it('answers a run that outlives the deadline with a timeout, not as clean', async () => {
    const { checks } = harness([() => new Promise<CheckOutcome>(() => undefined)]);
    await expect(ask(checks, { timeoutMs: 50 })).rejects.toMatchObject({
      code: 'CHECK_TIMEOUT',
      infra: true,
    });
  });

  it('holds the pass over the repository to the deadline as well', async () => {
    const { checks, calls } = harness([{ kind: 'landed', result: analysed }], {
      refreshRepo: () => new Promise<void>(() => undefined),
    });
    await expect(ask(checks, { timeoutMs: 50 })).rejects.toMatchObject({ code: 'CHECK_TIMEOUT' });
    expect(calls).not.toContain('run');
  });

  it('stops waiting when the caller goes, without calling it a timeout', async () => {
    const caller = new AbortController();
    const { checks } = harness([() => new Promise<CheckOutcome>(() => undefined)]);
    const asking = ask(checks, {}, caller.signal);
    caller.abort();
    const error = await asking.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InterlockError);
    expect((error as InterlockError).code).not.toBe('CHECK_TIMEOUT');
  });
});
