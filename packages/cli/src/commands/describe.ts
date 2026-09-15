import { isInterlockError } from '@interlock/shared';

/**
 * An error as a person sees it: the code, the message and, when there is one,
 * the remedy.
 *
 * The code leads because a stable one is the whole reason it exists — a caller
 * is meant to react to it without matching on prose, and a failure that prints
 * only the prose leaves matching on prose as the only option. The remedy is the
 * part a person can act on and is printed verbatim.
 */
export function describeError(error: unknown): string {
  if (!isInterlockError(error)) return error instanceof Error ? error.message : String(error);
  const line = `${error.code}: ${error.message}`;
  return error.remedy === undefined ? line : `${line}\n\n${error.remedy}`;
}
