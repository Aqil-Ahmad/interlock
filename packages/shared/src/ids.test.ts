import { describe, expect, it } from 'vitest';
import { isUlid, ULID_LENGTH, ulid, ulidTime } from './ids.js';

describe('ulid', () => {
  it('produces 26-character Crockford base32 ids', () => {
    const id = ulid();
    expect(id).toHaveLength(ULID_LENGTH);
    expect(isUlid(id)).toBe(true);
  });

  it('round-trips the creation timestamp', () => {
    const now = 1_760_000_000_000;
    expect(ulidTime(ulid(now))).toBe(now);
  });

  it('sorts lexicographically by creation time', () => {
    const earlier = ulid(1_000_000_000_000);
    const later = ulid(2_000_000_000_000);
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  it('stays monotonic within a single millisecond', () => {
    const now = 1_760_000_000_000;
    const ids = Array.from({ length: 100 }, () => ulid(now));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects non-ULID strings', () => {
    expect(isUlid('not-a-ulid')).toBe(false);
    expect(isUlid(42)).toBe(false);
    // I, L, O and U are excluded from the alphabet.
    expect(isUlid('IIIIIIIIIIIIIIIIIIIIIIIIII')).toBe(false);
  });
});
