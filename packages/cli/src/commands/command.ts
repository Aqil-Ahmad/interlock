/**
 * What every command is.
 *
 * Separate from the registry so a command can name this type without importing
 * the list it is a member of.
 */
export interface Command {
  readonly name: string;
  readonly summary: string;
  /** Returns a process exit code. */
  run(args: readonly string[]): Promise<number>;
}
