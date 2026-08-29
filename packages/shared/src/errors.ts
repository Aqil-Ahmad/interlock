/**
 * Typed errors.
 *
 * Every error carries a stable `code` so callers can react without matching on
 * messages, and an `infra` flag so environmental failures (Docker down,
 * toolchain missing) are never reported to users as conflict Findings.
 *
 * A refused operation is neither: `GIT_COMMAND_REFUSED` means Interlock's own
 * code asked for something the safety rules forbid, so it is a bug here rather
 * than a broken environment or a property of the repository under analysis.
 */

export type InterlockErrorCode =
  | 'CONFIG_INVALID'
  | 'REPO_NOT_FOUND'
  | 'REPO_NOT_GIT'
  | 'REPO_BARE'
  | 'GIT_COMMAND_FAILED'
  | 'GIT_COMMAND_REFUSED'
  | 'SHADOW_UNAVAILABLE'
  | 'MERGE_FAILED'
  | 'SANDBOX_UNAVAILABLE'
  | 'SANDBOX_TIMEOUT'
  | 'TOOLCHAIN_UNSUPPORTED'
  | 'ANALYZER_INFRA_FAILURE'
  | 'STORE_UNAVAILABLE'
  | 'STORE_MIGRATION_FAILED'
  | 'DAEMON_UNREACHABLE'
  | 'UNAUTHORIZED'
  | 'NOT_IMPLEMENTED';

export interface InterlockErrorOptions extends ErrorOptions {
  /** Machine-readable context. Must never contain secrets or file contents. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** What the user can do about it. Printed verbatim by the CLI. */
  readonly remedy?: string;
  /** Environmental failure rather than a property of the code under analysis. */
  readonly infra?: boolean;
}

export class InterlockError extends Error {
  override readonly name = 'InterlockError';
  readonly code: InterlockErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  readonly remedy: string | undefined;
  readonly infra: boolean;

  constructor(code: InterlockErrorCode, message: string, options: InterlockErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = options.details ?? {};
    this.remedy = options.remedy;
    this.infra = options.infra ?? false;
  }

  /** Safe to log or send over the API: no stack, no cause chain. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      remedy: this.remedy,
      infra: this.infra,
    };
  }
}

export function isInterlockError(value: unknown): value is InterlockError {
  return value instanceof InterlockError;
}

/** Marks surface that is declared but not yet implemented. */
export function notImplemented(what: string): never {
  throw new InterlockError('NOT_IMPLEMENTED', `${what} is not implemented yet`);
}
