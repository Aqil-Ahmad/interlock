/**
 * Ranking of findings.
 *
 * Pure: takes Findings, returns an ordering. Delivery over MCP, CLI or the
 * dashboard — and the rate limiting that goes with it — lives in the daemon.
 */
export * from './ranking.js';
