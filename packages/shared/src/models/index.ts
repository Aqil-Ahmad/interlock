/**
 * Interlock's data models.
 *
 * Rules for this directory:
 *  - types and small pure helpers only; no I/O, no business logic;
 *  - every model is JSON-serializable — ids are ULID strings, times are ISO-8601
 *    strings rather than `Date`, so SQLite rows and HTTP payloads match;
 *  - a field is added here before it is stored or exposed anywhere else.
 */
export * from './repo.js';
export * from './branch-ref.js';
export * from './agent-session.js';
export * from './change-set.js';
export * from './merge-pair.js';
export * from './speculative-run.js';
export * from './finding.js';
export * from './advice.js';
export * from './event-record.js';
