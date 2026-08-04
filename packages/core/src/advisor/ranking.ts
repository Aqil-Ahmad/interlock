import { findingWeight, SEVERITY_RANK } from '@interlock/shared';
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
 * Sort findings by severity, then confidence, then recency.
 *
 * Severity dominates rather than multiplying into confidence: a high-severity
 * finding we are unsure about is a possible broken build, a low-severity one we
 * are certain of is a nit, and burying the first under the second costs hours
 * where the reverse costs seconds. Confidence is the tiebreak within a severity,
 * so sandbox verdicts — always confidence 1 — outrank heuristic findings.
 *
 * Low-confidence noise is excluded by `minWeight`, which is where severity ×
 * confidence still applies.
 */
export function rankFindings(findings: readonly Finding[], options: RankOptions = {}): Finding[] {
  const minWeight = options.minWeight ?? 0;
  const ranked = findings
    .filter((finding) => finding.status === 'open' && findingWeight(finding) >= minWeight)
    .sort((a, b) => {
      const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (bySeverity !== 0) return bySeverity;
      const byConfidence = b.confidence - a.confidence;
      if (byConfidence !== 0) return byConfidence;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
  return options.limit === undefined ? ranked : ranked.slice(0, options.limit);
}
