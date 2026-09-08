/**
 * The localhost API consumed by the CLI, the dashboard and the MCP server.
 *
 * Binds `127.0.0.1` only and requires a bearer token generated at first start
 * and stored 0600 in the data dir. Both are asserted by tests; a regression
 * here is a vulnerability rather than a bug.
 *
 * Routes:
 *   GET  /api/health                      → daemon liveness and protocol version
 *   GET  /api/repos                       → watched repos
 *   GET  /api/repos/:id/branches          → in-flight branches and dirty state
 *   GET  /api/repos/:id/findings          → open findings, ranked
 *   GET  /api/findings/:id                → finding with full evidence
 *   POST /api/repos/:id/check             → force-check a pair
 *   GET  /api/repos/:id/order             → recommended merge order
 *   WS   /ws                              → live event stream for the dashboard
 *
 * The first three are served. The rest describe the shape being built toward and
 * are not routes yet: nothing produces findings, a merge order or a check, and a
 * route answering an empty list for them would say "no conflicts" rather than
 * "not built".
 */
export { createApiServer } from './server.js';
export type { ApiOptions, ApiServer, Bound } from './server.js';
export { bearerToken, ensureToken, tokenMatches } from './token.js';
