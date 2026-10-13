/**
 * Everything that prepares a merged tree for, or runs it in, the sandbox.
 *
 * Merged code is agent-written and unreviewed, so nothing here executes it on
 * the host: detection reads the tree out of the object database, and commands
 * are carried as data until the sandbox runs them.
 */
export * from './toolchain.js';
