import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { InterlockError } from './errors.js';
import { LOG_LEVELS } from './logger.js';
import type { LogLevel } from './logger.js';
import type { RepoConfigOverride } from './models/repo.js';

/**
 * Configuration: the global schema with its defaults and validation, and the
 * per-repository override file layered on top of it.
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
  readonly sessions: SessionsConfig;
  readonly logLevel: LogLevel;
}

export interface DaemonConfig {
  /** Loopback only; the literal type keeps it unconfigurable. */
  readonly host: '127.0.0.1';
  /** `0` asks the OS for a free one, which is what parallel test workers use. */
  readonly port: number;
}

/**
 * What a running daemon publishes so a client on this machine can reach it.
 *
 * The configured port may be `0`, and a daemon that crashed leaves this behind,
 * so its presence is a claim rather than a guarantee: a client connects and
 * treats a refused connection as the daemon being gone.
 */
export interface DaemonRuntime {
  /** Refuse a daemon speaking a different wire format rather than guessing. */
  readonly protocolVersion: number;
  /** What the listener actually bound, never what was asked for. */
  readonly port: number;
  readonly pid: number;
  readonly startedAt: string;
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

export interface SessionsConfig {
  /**
   * How long an agent session may go without a hook before it is presumed
   * gone. A pid check catches a process that died; this catches one that is
   * alive and doing nothing, and a reused pid that passes the first check.
   */
  readonly staleAfterMs: number;
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
  sessions: { staleAfterMs: 5 * 60_000 },
  logLevel: 'info',
};

/** Name of the per-repository override file, read from the repository root. */
export const REPO_CONFIG_FILENAME = '.interlock.json';

/**
 * Ceiling on the override file.
 *
 * The file is repository content, so its size is chosen by whoever writes the
 * repository. Reading it into memory before deciding it is too large is the
 * thing the ceiling exists to prevent.
 */
export const MAX_REPO_CONFIG_BYTES = 64 * 1024;

/**
 * Ceiling on one ignore pattern.
 *
 * Enforced again where patterns are matched, because a matcher must be safe on
 * input that never passed through here. Rejecting the pattern at the boundary
 * is what makes it visible: a pattern silently too long to ever match is the
 * same as a typo nobody is told about.
 */
export const MAX_IGNORE_PATTERN_LENGTH = 200;

/**
 * Ceiling on how many ignore patterns a repository may declare.
 *
 * Every pattern is tried against every branch, so the two multiply.
 */
export const MAX_IGNORE_PATTERNS = 256;

const REPO_CONFIG_KEYS = ['ignore', 'ignoreBranches', 'toolchain'] as const;
const TOOLCHAIN_KEYS = ['install', 'typecheck', 'build', 'test'] as const;

/**
 * Parse a repository's override file.
 *
 * Every field is checked rather than trusted: the file is written by the agents
 * Interlock watches, and `ignoreBranches` decides which branches go unexamined.
 * An unrecognised key is a problem rather than something to ignore — a typo
 * that quietly does nothing is indistinguishable from a setting that was never
 * applied.
 *
 * Problems name a known key and the shape expected, and carry nothing the file
 * chose — not a value, and not the name of a key that is not in the schema. A
 * key is written by whoever writes the repository exactly as a value is, and an
 * `InterlockError` reaches the API and the agents.
 *
 * Every problem is reported at once, with one exception `JSON.parse` decides:
 * a repeated key keeps the last occurrence silently, so a file declaring
 * `ignore` twice is read as valid.
 *
 * @throws InterlockError `CONFIG_INVALID` listing every problem at once.
 */
export function parseRepoConfigOverride(source: string, path: string): RepoConfigOverride {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    // A leading byte-order mark is not whitespace to `JSON.parse`, and editors
    // on some platforms write one without being asked.
    parsed = JSON.parse(source.replace(/^\uFEFF/u, ''));
  } catch {
    throw repoConfigInvalid(['file is not valid JSON'], path);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw repoConfigInvalid(['top level must be a JSON object'], path);
  }

  const record = parsed as Record<string, unknown>;
  reportUnknownKeys(record, REPO_CONFIG_KEYS, 'the file', problems);

  const ignore = readPatternList(record, 'ignore', problems);
  const ignoreBranches = readPatternList(record, 'ignoreBranches', problems);
  const toolchain = readToolchain(record, problems);

  if (problems.length > 0) throw repoConfigInvalid(problems, path);

  return {
    ...(ignore === undefined ? {} : { ignore }),
    ...(ignoreBranches === undefined ? {} : { ignoreBranches }),
    ...(toolchain === undefined ? {} : { toolchain }),
  };
}

/**
 * Report keys outside the schema by counting them, never by naming them.
 *
 * A key is chosen by whoever writes the repository, so it is file content in
 * the same sense a value is — and this error reaches the API and the agents.
 * Naming the set that is accepted says everything a reader needs to fix the
 * file while carrying nothing back out of it.
 *
 * Counting rather than listing is also what bounds the error. One key is as
 * long as the file allows and there may be thousands of them, so echoing them
 * produced an error larger than the file that caused it.
 */
function reportUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  scope: string,
  problems: string[],
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key)).length;
  if (unknown === 0) return;

  problems.push(
    `${scope} has ${String(unknown)} unknown ${unknown === 1 ? 'key' : 'keys'}; ` +
      `expected only ${allowed.join(', ')}`,
  );
}

function readPatternList(
  record: Record<string, unknown>,
  key: 'ignore' | 'ignoreBranches',
  problems: string[],
): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    problems.push(`${key} must be an array of strings`);
    return undefined;
  }
  if (value.length > MAX_IGNORE_PATTERNS) {
    problems.push(
      `${key} has ${String(value.length)} entries, more than ${String(MAX_IGNORE_PATTERNS)}`,
    );
    return undefined;
  }

  const patterns: string[] = [];
  for (const [index, entry] of value.entries()) {
    const at = `${key}[${String(index)}]`;
    if (typeof entry !== 'string') {
      problems.push(`${at} must be a string`);
    } else if (entry === '') {
      problems.push(`${at} must not be empty`);
    } else if (entry.length > MAX_IGNORE_PATTERN_LENGTH) {
      problems.push(`${at} is longer than ${String(MAX_IGNORE_PATTERN_LENGTH)} characters`);
    } else {
      patterns.push(entry);
    }
  }
  return patterns.length === 0 ? undefined : patterns;
}

function readToolchain(
  record: Record<string, unknown>,
  problems: string[],
): RepoConfigOverride['toolchain'] | undefined {
  const value = record.toolchain;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push('toolchain must be a JSON object');
    return undefined;
  }

  const source = value as Record<string, unknown>;
  reportUnknownKeys(source, TOOLCHAIN_KEYS, 'toolchain', problems);

  const install = readCommand(source, 'install', problems);
  const typecheck = readCommand(source, 'typecheck', problems);
  const build = readCommand(source, 'build', problems);
  const test = readCommand(source, 'test', problems);

  const toolchain = {
    ...(install === undefined ? {} : { install }),
    ...(typecheck === undefined ? {} : { typecheck }),
    ...(build === undefined ? {} : { build }),
    ...(test === undefined ? {} : { test }),
  };
  // An absent key and one holding nothing mean the same thing, so only the
  // absent spelling survives — as with an empty `ignore` array. Two shapes for
  // nothing leaves every reader to handle both.
  return Object.keys(toolchain).length === 0 ? undefined : toolchain;
}

/**
 * One toolchain command.
 *
 * No length limit of its own: unlike a pattern, a command is not matched
 * against every branch, so the ceiling on the file is the only bound it needs.
 */
function readCommand(
  source: Record<string, unknown>,
  key: (typeof TOOLCHAIN_KEYS)[number],
  problems: string[],
): string | undefined {
  const command = source[key];
  if (command === undefined) return undefined;
  if (typeof command !== 'string' || command === '') {
    problems.push(`toolchain.${key} must be a non-empty string`);
    return undefined;
  }
  return command;
}

function repoConfigInvalid(problems: string[], path: string): InterlockError {
  return new InterlockError(
    'CONFIG_INVALID',
    `Invalid ${REPO_CONFIG_FILENAME}: ${problems.join('; ')}`,
    {
      details: { path, problems },
      remedy: `Fix ${path}, or delete it to fall back to the global configuration.`,
    },
  );
}

/** Standard config file location. Repos may override a subset via `.interlock.json`. */
export function configPath(dataDir: string = DEFAULT_DATA_DIR): string {
  return join(dataDir, 'config.json');
}

/**
 * Where Interlock keeps its state, from the environment or the default.
 *
 * One function for the daemon and every client of it, because the config file
 * lives in this directory and so cannot say where it is: the daemon reads the
 * variable to find its config, the CLI reads it to find the daemon, and two
 * readings of one variable are a bug waiting for a rename. An empty value
 * counts as unset — `INTERLOCK_DATA_DIR= interlockd` is not a request for the
 * current directory.
 */
export function dataDirFrom(env: Readonly<Record<string, string | undefined>>): string {
  const named = env.INTERLOCK_DATA_DIR;
  if (named === undefined || named === '') return DEFAULT_DATA_DIR;
  // Refused here, where the variable was read, rather than left to whatever
  // opens the directory first: a relative value would otherwise be reported by
  // the store, three layers down, with a remedy about database paths that
  // names nothing the user touched.
  if (!named.startsWith('/')) {
    throw new InterlockError('CONFIG_INVALID', 'INTERLOCK_DATA_DIR must be an absolute path', {
      details: { INTERLOCK_DATA_DIR: named },
      remedy: `Set INTERLOCK_DATA_DIR to a full path, e.g. ${DEFAULT_DATA_DIR}.`,
    });
  }
  return named;
}

/**
 * Sections of the file that are objects, and the keys each may hold.
 *
 * Read off the defaults rather than written down again, so this is the same
 * schema `validateConfig` checks values against and not a second one.
 */
const CONFIG_SECTIONS = ['daemon', 'scheduler', 'analyzers', 'sandbox', 'mcp', 'sessions'] as const;
type ConfigSection = (typeof CONFIG_SECTIONS)[number];

/**
 * Parse the global config file into the shape `resolveConfig` merges.
 *
 * This checks shape; `validateConfig` checks values, which is the split the
 * repository override file already uses. Shape is what a spread cannot check:
 * merged as it stands, a file saying `repo` for `repos` watches nothing, one
 * saying `scheduler.debounce` keeps the default, and `"daemon": "abc"` spreads
 * three characters into the daemon section — all without a word. An unknown key
 * is refused because a typo that quietly does nothing is indistinguishable from
 * a setting that was never applied, and this is the file a user edits on
 * purpose.
 *
 * Unlike the override file, unknown keys are named: this file never reaches the
 * API or an agent, and "unknown key `repo`" is the whole diagnosis.
 *
 * @throws InterlockError `CONFIG_INVALID` listing every problem at once.
 */
export function parseConfigFile(
  source: string,
  path: string,
): Omit<DeepPartial<InterlockConfig>, 'dataDir'> {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.replace(/^\uFEFF/u, ''));
  } catch {
    throw configFileInvalid(['file is not valid JSON'], path);
  }
  if (!isPlainObject(parsed)) throw configFileInvalid(['top level must be a JSON object'], path);

  // The data dir is where this file was found. A file naming a different one
  // is contradicting its own location, and honouring it would have the daemon
  // read its config from one directory and keep its state in another.
  if ('dataDir' in parsed) {
    problems.push('dataDir cannot be set here; the data directory is where this file lives');
  }
  const allowed = Object.keys(DEFAULT_CONFIG).filter((key) => key !== 'dataDir');
  // Scanned without `dataDir`: it is known and refused above, which is a better
  // diagnosis than "unknown key", and listing it among the keys that are
  // accepted would say the opposite of what the line before just said.
  const { dataDir: _refused, ...rest } = parsed;
  nameUnknownKeys(rest, allowed, 'the file', problems);

  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'dataDir' || !allowed.includes(key)) continue;
    if ((CONFIG_SECTIONS as readonly string[]).includes(key)) {
      const section = readSection(key as ConfigSection, value, problems);
      if (section !== undefined) input[key] = section;
    } else if (key === 'repos') {
      input.repos = readRepos(value, problems);
    } else {
      input[key] = value;
    }
  }

  if (problems.length > 0) throw configFileInvalid(problems, path);
  return input;
}

function readSection(
  name: ConfigSection,
  value: unknown,
  problems: string[],
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    problems.push(`${name} must be a JSON object`);
    return undefined;
  }
  nameUnknownKeys(value, Object.keys(DEFAULT_CONFIG[name]), name, problems);
  return value;
}

/**
 * Repository paths, with `~/` expanded.
 *
 * The one relative form a config file legitimately wants: it depends on the
 * user rather than on the working directory, so it is stable for a daemon in
 * the way `./repo` is not. `~user/` and a bare `~` are refused with a remedy
 * that says so, rather than reaching `validateConfig` as merely "not absolute".
 */
function readRepos(value: unknown, problems: string[]): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry: unknown, index) => {
    if (typeof entry !== 'string') return entry;
    if (entry === '~' || entry.startsWith('~/')) return join(homedir(), entry.slice(1));
    if (entry.startsWith('~')) {
      problems.push(`repos[${String(index)}]: only ~/ is expanded; write the path in full`);
    }
    return entry;
  });
}

/**
 * Unknown keys, by name.
 *
 * The counterpart of `reportUnknownKeys`, which counts rather than names
 * because the override file is repository content and its keys reach the API.
 * This file is the user's own and never leaves the machine, and the name of the
 * key is the whole diagnosis.
 */
function nameUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  scope: string,
  problems: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      problems.push(
        `${scope} has an unknown key \`${key}\`; expected one of ${allowed.join(', ')}`,
      );
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configFileInvalid(problems: string[], path: string): InterlockError {
  return new InterlockError('CONFIG_INVALID', `Invalid config file: ${problems.join('; ')}`, {
    details: { path, problems },
    remedy: `Edit ${path} and start the daemon again.`,
  });
}

/**
 * The config for a data dir: the file in it, over the defaults.
 *
 * A missing file is the normal first start and means the defaults. A file that
 * is there and cannot be read is not — a daemon that silently ran on defaults
 * over a config it could not open would look exactly like one that was never
 * configured, and the repositories it was meant to watch would go unwatched
 * without a word.
 *
 * A plain read, following symlinks and unbounded, unlike the two files this
 * shares a directory with. The override file gets `O_NOFOLLOW` and a size cap
 * because a repository writes it; the token file gets `O_NOFOLLOW` because its
 * mode is checked and tightened through the same descriptor and a symlink would
 * redirect the tightening. This file is the user's own, is read once, and has
 * no mode to change — there is nothing here for either to protect.
 *
 * @throws InterlockError `CONFIG_INVALID` for a file that cannot be read,
 *         cannot be parsed, or holds a value `validateConfig` refuses.
 */
export function loadConfig(dataDir: string): InterlockConfig {
  const path = configPath(dataDir);
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? null;
    if (code === 'ENOENT') return resolveConfig({ dataDir });
    throw new InterlockError('CONFIG_INVALID', 'The config file could not be read', {
      cause: error,
      details: { path, code },
      remedy: `Check that ${path} is a file readable by this user, or remove it to run on the defaults.`,
    });
  }
  // The parser's return type cannot carry `dataDir`, so there is no order of
  // these two in which the file could win — which is the property, and it is
  // in the signature rather than in a spread order nothing can observe.
  return resolveConfig({ ...parseConfigFile(source, path), dataDir });
}

/**
 * Where a running daemon publishes its port.
 *
 * Rewritten on every start and removed on a clean stop.
 */
export function runtimePath(dataDir: string = DEFAULT_DATA_DIR): string {
  return join(dataDir, 'daemon.json');
}

/**
 * Where the API bearer token lives, 0600.
 *
 * Separate from the runtime file because it is minted once and kept: agents and
 * the MCP server are configured with it, so a token rotating on restart breaks
 * every configured client.
 */
export function tokenPath(dataDir: string = DEFAULT_DATA_DIR): string {
  return join(dataDir, 'token');
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
    sessions: { ...DEFAULT_CONFIG.sessions, ...input.sessions },
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

/**
 * Returns a list of human-readable problems; empty means valid.
 *
 * Types are checked before ranges, because the config arrives through
 * `JSON.parse` and every field is `unknown` at run time whatever the interface
 * says. A range test on the wrong type never fires — `'abc' < 0` is false — and
 * the value then poisons the arithmetic that reads it: a string `debounceMs`
 * makes every deadline `NaN`, which is a debounce that silently never fires.
 */
export function validateConfig(config: InterlockConfig): string[] {
  const problems: string[] = [];

  if (!Array.isArray(config.repos)) {
    problems.push('repos must be an array of absolute paths');
  } else {
    for (const [index, repo] of config.repos.entries()) {
      if (typeof repo !== 'string') problems.push(`repos[${String(index)}] must be a string`);
      else if (!repo.startsWith('/')) problems.push(`repo path must be absolute: ${repo}`);
    }
  }

  if (typeof config.dataDir !== 'string' || config.dataDir === '') {
    problems.push('dataDir must be a non-empty path');
  } else if (!config.dataDir.startsWith('/')) {
    // The same rule the repositories get, for the same reason: a daemon's
    // working directory is whatever started it, and state kept relative to
    // that is state kept somewhere different on every start.
    problems.push(`dataDir must be absolute: ${config.dataDir}`);
  }
  if (!(LOG_LEVELS as readonly string[]).includes(config.logLevel)) {
    problems.push(`logLevel must be one of ${LOG_LEVELS.join(', ')}`);
  }

  if (!isPort(config.daemon.port) && !isEphemeral(config.daemon.port))
    problems.push(`daemon.port out of range: ${String(config.daemon.port)}`);
  if (!isPort(config.mcp.port) && !isEphemeral(config.mcp.port))
    problems.push(`mcp.port out of range: ${String(config.mcp.port)}`);
  // Two ephemeral requests never collide: the OS assigns each a free port.
  if (
    config.daemon.port === config.mcp.port &&
    !isEphemeral(config.daemon.port) &&
    !isEphemeral(config.mcp.port)
  ) {
    problems.push('daemon.port and mcp.port must differ');
  }

  requireNumber(
    config.scheduler.debounceMs,
    'scheduler.debounceMs',
    'must be >= 0',
    (n) => n >= 0,
    problems,
  );
  requireNumber(
    config.scheduler.concurrency,
    'scheduler.concurrency',
    'must be >= 1',
    (n) => n >= 1,
    problems,
  );
  requireNumber(
    config.scheduler.overlapPriorityBoost,
    'scheduler.overlapPriorityBoost',
    'must be >= 0',
    (n) => n >= 0,
    problems,
  );
  requireNumber(
    config.scheduler.maxBranches,
    'scheduler.maxBranches',
    'must be >= 2',
    (n) => n >= 2,
    problems,
  );
  requireNumber(config.sandbox.cpuLimit, 'sandbox.cpuLimit', 'must be > 0', (n) => n > 0, problems);
  requireNumber(
    config.sandbox.memoryLimitMb,
    'sandbox.memoryLimitMb',
    'must be >= 512',
    (n) => n >= 512,
    problems,
  );
  requireNumber(
    config.sandbox.timeoutMs,
    'sandbox.timeoutMs',
    'must be >= 1000',
    (n) => n >= 1_000,
    problems,
  );
  requireNumber(
    config.mcp.maxWarningsPerHour,
    'mcp.maxWarningsPerHour',
    'must be >= 0',
    (n) => n >= 0,
    problems,
  );
  requireNumber(
    config.sessions.staleAfterMs,
    'sessions.staleAfterMs',
    'must be >= 1000',
    (n) => n >= 1_000,
    problems,
  );

  for (const key of ['textual', 'typecheck', 'build', 'testTargeted', 'astSemantic'] as const) {
    requireBoolean(config.analyzers[key], `analyzers.${key}`, problems);
  }
  requireBoolean(config.sandbox.enabled, 'sandbox.enabled', problems);
  requireBoolean(config.mcp.enabled, 'mcp.enabled', problems);
  if (typeof config.sandbox.image !== 'string' || config.sandbox.image === '') {
    problems.push('sandbox.image must be a non-empty string');
  }

  // Execution analyzers require the sandbox: merged code never runs on the host.
  if (config.sandbox.enabled === false) {
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

/** Records a problem unless the value is a finite number inside its range. */
function requireNumber(
  value: number,
  name: string,
  expectation: string,
  inRange: (value: number) => boolean,
  problems: string[],
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`${name} must be a number`);
    return;
  }
  if (!inRange(value)) problems.push(`${name} ${expectation}`);
}

function requireBoolean(value: boolean, name: string, problems: string[]): void {
  if (typeof value !== 'boolean') problems.push(`${name} must be true or false`);
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value > 1024 && value < 65_536;
}

/**
 * `0` asks the OS for a free port and is read back off the listener.
 *
 * Accepted rather than a test-only escape hatch: parallel vitest workers each
 * need a port nothing else holds, and a fixed one there is a flake that appears
 * under load and never reproduces locally.
 */
function isEphemeral(value: number): boolean {
  return value === 0;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};
