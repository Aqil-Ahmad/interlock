/**
 * `@interlock/shared` — the dependency leaf of the monorepo.
 *
 * Contains: data models, event definitions, config schema, typed errors, logging
 * and id generation. Contains no business logic and imports no sibling package
 * (enforced by eslint.config.js).
 */
export * from './models/index.js';
export * from './events/index.js';
export * from './config.js';
export * from './errors.js';
export * from './glob.js';
export * from './ids.js';
export * from './logger.js';

/** Wire-format version for the daemon API, MCP payloads and the event log. */
export const INTERLOCK_PROTOCOL_VERSION = 1;
