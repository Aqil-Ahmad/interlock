import { isInterlockError } from '@interlock/shared';
import type { InterlockError } from '@interlock/shared';

/**
 * Await a rejection and narrow it, so assertions run against a typed error
 * rather than an untyped matcher — the error type is part of the contract.
 */
export async function rejection(promise: Promise<unknown>): Promise<InterlockError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!isInterlockError(error)) {
    throw new Error(`expected an InterlockError, got: ${String(error)}`);
  }
  return error;
}
