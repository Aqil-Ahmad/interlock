import { describe, expect, it } from 'vitest';
import type { Finding, FindingId } from '@interlock/shared';
import { rankFindings } from './ranking.js';

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    runId: 'RUN' as Finding['runId'],
    kind: 'typecheck',
    rule: 'test',
    severity: 'medium',
    confidence: 1,
    status: 'open',
    title: 'title',
    description: '',
    attribution: {
      branchA: 'A' as Finding['attribution']['branchA'],
      branchB: 'B' as Finding['attribution']['branchB'],
      originBranch: null,
      rationale: '',
    },
    evidence: [],
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
    ...overrides,
    id: overrides.id as FindingId,
  };
}

describe('rankFindings', () => {
  it('orders by severity then confidence', () => {
    const ranked = rankFindings([
      finding({ id: 'low-certain', severity: 'low', confidence: 1 }),
      finding({ id: 'high-certain', severity: 'high', confidence: 1 }),
      finding({ id: 'high-unsure', severity: 'high', confidence: 0.3 }),
    ]);
    expect(ranked.map((f) => f.id)).toEqual(['high-certain', 'high-unsure', 'low-certain']);
  });

  it('breaks ties by recency', () => {
    const ranked = rankFindings([
      finding({ id: 'older', updatedAt: '2026-01-01T00:00:00.000Z' }),
      finding({ id: 'newer', updatedAt: '2026-06-01T00:00:00.000Z' }),
    ]);
    expect(ranked.map((f) => f.id)).toEqual(['newer', 'older']);
  });

  it('only surfaces open findings', () => {
    const ranked = rankFindings([
      finding({ id: 'resolved', status: 'resolved' }),
      finding({ id: 'dismissed', status: 'dismissed' }),
      finding({ id: 'stale', status: 'stale' }),
      finding({ id: 'open' }),
    ]);
    expect(ranked.map((f) => f.id)).toEqual(['open']);
  });

  it('respects the noise budget', () => {
    const ranked = rankFindings(
      [
        finding({ id: 'strong', severity: 'high' }),
        finding({ id: 'weak', severity: 'info', confidence: 0.2 }),
      ],
      { minWeight: 0.2, limit: 1 },
    );
    expect(ranked.map((f) => f.id)).toEqual(['strong']);
  });
});
