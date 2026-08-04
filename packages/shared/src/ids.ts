import { randomFillSync } from 'node:crypto';

/**
 * ULID generation and branded id types.
 *
 * ULIDs are 26 characters of Crockford base32 and sort lexicographically by
 * creation time, which the append-only event log relies on when replaying.
 *
 * Implemented here rather than pulled from npm because `shared` is zero-dep.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, no I L O U
const TIME_LEN = 10;
const RANDOM_LEN = 16;

export const ULID_LENGTH = TIME_LEN + RANDOM_LEN;
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * A ULID string, branded per entity so a `RepoId` cannot be passed where a
 * `FindingId` is expected.
 */
export type Ulid<Brand extends string> = string & { readonly __brand: Brand };

export type RepoId = Ulid<'repo'>;
export type BranchRefId = Ulid<'branch-ref'>;
export type AgentSessionId = Ulid<'agent-session'>;
export type ChangeSetId = Ulid<'change-set'>;
export type SnapshotId = Ulid<'snapshot'>;
export type MergePairId = Ulid<'merge-pair'>;
export type SpeculativeRunId = Ulid<'speculative-run'>;
export type FindingId = Ulid<'finding'>;
export type AdviceId = Ulid<'advice'>;
export type EventId = Ulid<'event'>;

let lastTime = -1;
let lastRandom = new Uint8Array(RANDOM_LEN);

function encodeTime(time: number): string {
  let out = '';
  let t = time;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += ENCODING[byte % 32]!;
  return out;
}

/** Increment the random component in place so ids from the same ms still sort. */
function bumpRandom(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i]! < 255) {
      bytes[i] = bytes[i]! + 1;
      return;
    }
    bytes[i] = 0;
  }
}

/**
 * Create a new ULID. Monotonic within a millisecond.
 *
 * Call with the target brand — `ulid<RepoId>()` — to type the id at creation.
 *
 * @param now - creation time in ms; injectable for deterministic tests.
 */
export function ulid<T extends Ulid<string> = Ulid<string>>(now: number = Date.now()): T {
  if (now === lastTime) {
    bumpRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomFillSync(new Uint8Array(RANDOM_LEN));
  }
  return (encodeTime(now) + encodeRandom(lastRandom)) as T;
}

/** Extract the creation timestamp (ms since epoch) encoded in a ULID. */
export function ulidTime(id: string): number {
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const index = ENCODING.indexOf(id[i]!);
    if (index === -1) throw new Error(`Not a ULID: ${id}`);
    time = time * 32 + index;
  }
  return time;
}

/** Type guard for values arriving from SQLite, HTTP or MCP payloads. */
export function isUlid(value: unknown): value is Ulid<string> {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}
