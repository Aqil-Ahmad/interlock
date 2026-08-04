import { findingWeight } from '@interlock/shared';
import type { Finding } from '@interlock/shared';

/**
 * Finding ranking.
 *
 * Agents receive at most a handful of warnings per hour, so whatever sorts to
 * the top is effectively the only thing that gets said.
 */

export interface RankOptions {
  /** Findings below this weight are never delivered to an agent. */
  readonly minWeight?: number;
  /** Maximum findings returned. */
  readonly limit?: number;
}

/**
 * Sort findings by severity × confidence, then by recency.
 *
 * Sandbox verdicts sit at confidence 1, so they always outrank heuristic
 * findings of the same severity.
 */
export function rankFindings(findings: readonly Finding[], options: RankOptions = {}): Finding[] {
  const minWeight = options.minWeight ?? 0;
  const ranked = findings
    .filter((finding) => finding.status === 'open' && findingWeight(finding) >= minWeight)
    .sort((a, b) => {
      const byWeight = findingWeight(b) - findingWeight(a);
      if (byWeight !== 0) return byWeight;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
  return options.limit === undefined ? ranked : ranked.slice(0, options.limit);
}
