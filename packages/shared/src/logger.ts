/**
 * Structured JSON logging with secret redaction.
 *
 * Zero-dependency: `shared` is the leaf package. If a richer sink is needed
 * (rotation, transports), implement `LogSink` in the daemon rather than adding
 * a dependency here.
 */

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export interface LogRecord {
  readonly time: string;
  readonly level: LogLevel;
  readonly component: string;
  readonly msg: string;
  readonly [key: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Derive a logger with extra fields bound (e.g. `repoId`, `runId`). */
  child(component: string, fields?: Record<string, unknown>): Logger;
}

/**
 * Patterns redacted from every log record and from stored evidence.
 *
 * A safety net, not a licence to log sensitive data — credential files are
 * never read in the first place.
 */
const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[-_]?key|authorization|cookie)/i;
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const REDACTED = '[redacted]';

/** Redact obvious secrets from any free text before it is logged or stored. */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY_PATTERN.test(key)) out[key] = REDACTED;
    else if (typeof value === 'string') out[key] = redact(value);
    else out[key] = value;
  }
  return out;
}

/** Writes one JSON object per line to stderr. Default sink everywhere. */
export const jsonSink: LogSink = (record) => {
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly sink?: LogSink;
  readonly base?: Record<string, unknown>;
}

export function createLogger(component: string, options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? jsonSink;
  const base = options.base ?? {};
  const threshold = LEVEL_RANK[level];

  const emit = (recordLevel: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_RANK[recordLevel] < threshold) return;
    sink({
      time: new Date().toISOString(),
      level: recordLevel,
      component,
      msg: redact(msg),
      ...redactFields({ ...base, ...fields }),
    });
  };

  return {
    trace: (msg, fields) => emit('trace', msg, fields),
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (childComponent, fields) =>
      createLogger(`${component}.${childComponent}`, {
        level,
        sink,
        base: { ...base, ...fields },
      }),
  };
}

/** Discards everything. For tests that assert on behaviour, not output. */
export const silentLogger: Logger = createLogger('silent', {
  level: 'error',
  sink: () => undefined,
});
