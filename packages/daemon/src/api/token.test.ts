import { describe, expect, it } from 'vitest';
import { bearerToken, tokenMatches } from './token.js';

/**
 * The two halves of the token check that have no I/O in them: pulling the value
 * out of a header a client controls, and comparing it without leaking how far
 * the comparison got.
 */

describe('bearerToken', () => {
  it('reads the token out of a Bearer header', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
  });

  it('accepts the scheme in any case, because RFC 7235 does', () => {
    expect(bearerToken('bearer abc123')).toBe('abc123');
    expect(bearerToken('BEARER abc123')).toBe('abc123');
  });

  it('refuses another scheme rather than reading its credentials as a token', () => {
    expect(bearerToken('Basic abc123')).toBeNull();
    expect(bearerToken('Bearerabc123')).toBeNull();
  });

  it('refuses a missing, empty or schemeless header', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('')).toBeNull();
    expect(bearerToken('abc123')).toBeNull();
    expect(bearerToken('Bearer ')).toBeNull();
    expect(bearerToken('Bearer    ')).toBeNull();
  });

  it('trims the surrounding whitespace a client may send', () => {
    expect(bearerToken('Bearer  abc123 ')).toBe('abc123');
  });
});

describe('tokenMatches', () => {
  it('accepts the token it was given', () => {
    expect(tokenMatches('s3cret-value', 's3cret-value')).toBe(true);
  });

  it('rejects a token differing in one character', () => {
    expect(tokenMatches('s3cret-value', 's3cret-valuf')).toBe(false);
  });

  it('rejects a shorter and a longer token without throwing', () => {
    // `timingSafeEqual` raises on a length mismatch, so a comparison that fed it
    // the raw values would answer a wrong-length token with a 500 rather than a
    // 401 — and the status would say the length was wrong.
    expect(tokenMatches('s3cret-value', 's3cret')).toBe(false);
    expect(tokenMatches('s3cret-value', 's3cret-value-and-more')).toBe(false);
    expect(tokenMatches('s3cret-value', '')).toBe(false);
  });

  it('rejects a token that is a prefix of the expected one', () => {
    expect(tokenMatches('abcdef', 'abcde')).toBe(false);
  });
});
