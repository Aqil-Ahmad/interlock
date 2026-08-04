/**
 * `@interlock/mcp-server` — the agent-facing surface.
 *
 * A thin adapter over the daemon API with no analysis logic and no state, so an
 * agent can never see anything a human could not see in `interlock status`.
 */
export * from './tools/index.js';
export * from './sanitize.js';
