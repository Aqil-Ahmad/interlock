/**
 * `@interlock/mcp-server` — the agent-facing surface.
 *
 * A thin adapter over the daemon API with no analysis logic and no state, so an
 * agent can never see anything a human could not see in `interlock status`.
 *
 * What exists today is the part that has to be right before any transport does:
 * the tool schemas agents will see, and `wrapUntrusted()`, the prompt-injection
 * boundary. The server lifecycle and `interlock-mcp` binary arrive with M5.
 */
export * from './tools/index.js';
export * from './sanitize.js';
