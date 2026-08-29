/**
 * SQLite persistence: the store interface, its `node:sqlite` implementation and
 * the schema migrations behind it.
 */
export type { Store, StoreOptions } from './store.js';
export { openStore } from './store.js';
export * from './migrations/index.js';
