/**
 * The Docker sandbox, and everything that prepares a merged tree for it: where
 * merged code runs, and the only place it runs.
 *
 * Every execution analyzer reaches a container through `createSandboxRunner`.
 * Isolation is fixed rather than configurable — no network, no capabilities, a
 * non-root user, a read-only tree — and only the limits come from config.
 * Toolchain detection reads the tree out of the object database, and commands
 * are carried as data until the sandbox runs them.
 */
export {
  CACHE_TARGET,
  DEFAULT_PIDS_LIMIT,
  SANDBOX_LABEL,
  SCRATCH_TARGET,
  TREE_TARGET,
  shellCommand,
} from './docker-args.js';
export type { SandboxMount } from './docker-args.js';
export * from './runner.js';
export * from './toolchain.js';
