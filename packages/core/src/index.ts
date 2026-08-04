/**
 * `@interlock/core` — domain logic.
 *
 * Git and shadow operations, speculative merging, the analyzer pipeline and
 * finding ranking. No servers, timers or watchers; those live in
 * `@interlock/daemon`, which composes what is exported here.
 *
 * Submodules are importable directly (`@interlock/core/merge`).
 */
export * from './git/index.js';
export * from './merge/index.js';
export * from './analyzers/index.js';
export * from './advisor/index.js';
