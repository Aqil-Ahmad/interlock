import { homedir } from 'node:os';
import { join } from 'node:path';
import { InterlockError } from './errors.js';
import type { LogLevel } from './logger.js';

/**
 * Global configuration schema, defaults and validation.
 *
 * Validated by hand rather than with a schema library because `shared` is
 * zero-dep and the surface is small. Revisit if this file grows past a few
 * hundred lines.
 */

export interface InterlockConfig {
  /** Repositories to watch. Absolute paths. */
  readonly repos: readonly string[];
  /** Where shadow clones, the SQLite store and logs live. Created with 0700. */
  readonly dataDir: string;
  readonly daemon: DaemonConfig;
  readonly scheduler: SchedulerConfig;
  readonly analyzers: AnalyzersConfig;
  readonly sandbox: SandboxConfig;
  readonly mcp: McpConfig;
  readonly logLevel: LogLevel;
}

export interface DaemonConfig {
  /** Loopback only; the literal type keeps it unconfigurable. */
  readonly host: '127.0.0.1';
  readonly port: number;
}

export interface SchedulerConfig {
  /** Quiet period after the last edit before a pair is re-run. */
  readonly debounceMs: number;
  /** Maximum speculative runs executing at once. */
  readonly concurrency: number;
  /** Priority added to pairs whose changes touch a common file. */
  readonly overlapPriorityBoost: number;
  /** Refuse to schedule when the repo has more in-flight branches than this. */
  readonly maxBranches: number;
}

export interface AnalyzersConfig {
  readonly textual: boolean;
  readonly typecheck: boolean;
  readonly build: boolean;
  readonly testTargeted: boolean;
  readonly astSemantic: boolean;
}

export interface SandboxConfig {
  /** Disabling it disables every execution analyzer. */
  readonly enabled: boolean;
  readonly image: string;
  readonly cpuLimit: number;
  readonly memoryLimitMb: number;
  readonly timeoutMs: number;
  /** Always false; typed as a literal so the invariant is testable. */
  readonly network: false;
}

export interface McpConfig {
  readonly enabled: boolean;
  readonly port: number;
  /** Maximum warnings delivered to a single agent session per hour. */
  readonly maxWarningsPerHour: number;
}

export const DEFAULT_DATA_DIR = join(homedir(), '.interlock');

export const DEFAULT_CONFIG: InterlockConfig = {
  repos: [],
  dataDir: DEFAULT_DATA_DIR,
  daemon: { host: '127.0.0.1', port: 47317 },
  scheduler: {
    debounceMs: 2_000,
    concurrency: 2,
    overlapPriorityBoost: 10,
    maxBranches: 12,
  },
  analyzers: {
    textual: true,
    typecheck: true,
    build: false,
    testTargeted: false,
    astSemantic: true,
  },
  sandbox: {
    enabled: true,
    image: 'node:22-bookworm-slim',
    cpuLimit: 2,
    memoryLimitMb: 4096,
    timeoutMs: 180_000,
    network: false,
  },
  mcp: { enabled: true, port: 47318, maxWarningsPerHour: 10 },
  logLevel: 'info',
};

/** Standard config file location. Repos may override a subset via `.interlock.json`. */
export function configPath(dataDir: string = DEFAULT_DATA_DIR): string {
  return join(dataDir, 'config.json');
}

/**
 * Merge partial user config over the defaults and validate the result.
 *
 * @throws InterlockError `CONFIG_INVALID` listing every problem at once, so a
 *         broken config is fixed in one pass.
 */
export function resolveConfig(input: DeepPartial<InterlockConfig> = {}): InterlockConfig {
  const config: InterlockConfig = {
    ...DEFAULT_CONFIG,
    ...input,
    repos: input.repos ?? DEFAULT_CONFIG.repos,
    daemon: { ...DEFAULT_CONFIG.daemon, ...input.daemon, host: '127.0.0.1' },
    scheduler: { ...DEFAULT_CONFIG.scheduler, ...input.scheduler },
    analyzers: { ...DEFAULT_CONFIG.analyzers, ...input.analyzers },
    sandbox: { ...DEFAULT_CONFIG.sandbox, ...input.sandbox, network: false },
    mcp: { ...DEFAULT_CONFIG.mcp, ...input.mcp },
  };

  const problems = validateConfig(config);
  if (problems.length > 0) {
    throw new InterlockError('CONFIG_INVALID', `Invalid Interlock config: ${problems.join('; ')}`, {
      details: { problems },
      remedy: `Edit ${configPath(config.dataDir)} and restart the daemon.`,
    });
  }
  return config;
}

/** Returns a list of human-readable problems; empty means valid. */
export function validateConfig(config: InterlockConfig): string[] {
  const problems: string[] = [];

  for (const repo of config.repos) {
    if (!repo.startsWith('/')) problems.push(`repo path must be absolute: ${repo}`);
  }
  if (!isPort(config.daemon.port)) problems.push(`daemon.port out of range: ${config.daemon.port}`);
  if (!isPort(config.mcp.port)) problems.push(`mcp.port out of range: ${config.mcp.port}`);
  if (config.daemon.port === config.mcp.port) problems.push('daemon.port and mcp.port must differ');
  if (config.scheduler.debounceMs < 0) problems.push('scheduler.debounceMs must be >= 0');
  if (config.scheduler.concurrency < 1) problems.push('scheduler.concurrency must be >= 1');
  if (config.scheduler.maxBranches < 2) problems.push('scheduler.maxBranches must be >= 2');
  if (config.sandbox.cpuLimit <= 0) problems.push('sandbox.cpuLimit must be > 0');
  if (config.sandbox.memoryLimitMb < 512) problems.push('sandbox.memoryLimitMb must be >= 512');
  if (config.sandbox.timeoutMs < 1_000) problems.push('sandbox.timeoutMs must be >= 1000');
  if (config.mcp.maxWarningsPerHour < 0) problems.push('mcp.maxWarningsPerHour must be >= 0');

  // Execution analyzers require the sandbox: merged code never runs on the host.
  if (!config.sandbox.enabled) {
    const needsSandbox = (['typecheck', 'build', 'testTargeted'] as const).filter(
      (key) => config.analyzers[key],
    );
    if (needsSandbox.length > 0) {
      problems.push(
        `analyzers ${needsSandbox.join(', ')} require sandbox.enabled — Interlock never executes merged code on the host`,
      );
    }
  }

  return problems;
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value > 1024 && value < 65_536;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};
