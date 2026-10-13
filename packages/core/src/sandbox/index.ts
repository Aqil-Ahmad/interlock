/**
 * The Docker sandbox: where merged code runs, and the only place it runs.
 *
 * Every execution analyzer reaches a container through `createSandboxRunner`.
 * Isolation is fixed rather than configurable — no network, no capabilities, a
 * non-root user, a read-only tree — and only the limits come from config.
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
