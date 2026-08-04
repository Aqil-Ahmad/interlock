import { notImplemented } from '@interlock/shared';
import type { InterlockConfig, Logger } from '@interlock/shared';
import type { EventBus } from '../bus/index.js';
import type { Store } from '../store/index.js';

/**
 * The localhost HTTP + WebSocket API consumed by the CLI, the dashboard and the
 * MCP server.
 *
 * Binds `127.0.0.1` only and requires a bearer token generated at first start
 * and stored 0600 in the data dir. Both are asserted by tests; a regression
 * here is a vulnerability rather than a bug.
 */

export interface ApiServer {
  start(): Promise<{ readonly port: number; readonly token: string }>;
  stop(): Promise<void>;
}

export interface ApiOptions {
  readonly config: InterlockConfig;
  readonly store: Store;
  readonly bus: EventBus;
  readonly logger: Logger;
}

/**
 * Routes:
 *   GET  /api/health                      → daemon liveness and version
 *   GET  /api/repos                       → watched repos
 *   GET  /api/repos/:id/branches          → in-flight branches and dirty state
 *   GET  /api/repos/:id/findings          → open findings, ranked
 *   GET  /api/findings/:id                → finding with full evidence
 *   POST /api/repos/:id/check             → force-check a pair
 *   GET  /api/repos/:id/order             → recommended merge order
 *   WS   /ws                              → live event stream for the dashboard
 */
export function createApiServer(_options: ApiOptions): ApiServer {
  return notImplemented('createApiServer', 'M1');
}
