import { describe, expect, it } from 'vitest';
import { parseCollection } from './daemon-client.js';

/**
 * The collection record is printed as durations and instants, so a shape this
 * build cannot read is refused by the field that is wrong rather than shown as
 * `NaN s`.
 */

const PATH = '/api/repos/x/collection';
const SIZE = { loose: 1, packed: 2, kib: 3 };
const LAST = {
  endedAt: '2026-10-11T11:00:00.000Z',
  pausedMs: 1_150,
  quietMs: 70,
  before: SIZE,
  after: SIZE,
};
const FAILING = { failures: 2, retryAt: '2026-10-11T14:00:00.000Z', reason: 'disk full' };
const IDLE = { phase: 'idle', since: null, last: null, failing: null };

const field = (value: unknown): unknown => {
  try {
    parseCollection(value, PATH);
  } catch (error) {
    return (error as { details?: { field?: unknown } }).details?.field;
  }
  return null;
};

describe('parseCollection', () => {
  it('reads every phase, and a record with a last collection and a failure', () => {
    expect(parseCollection(IDLE, PATH)).toStrictEqual(IDLE);
    for (const phase of ['pinning', 'waiting-for-quiet', 'holding']) {
      const state = { phase, since: '2026-10-11T12:00:00.000Z', last: LAST, failing: FAILING };
      expect(parseCollection(state, PATH)).toStrictEqual(state);
    }
  });

  it('drops fields it does not know rather than passing them on', () => {
    expect(parseCollection({ ...IDLE, extra: 1, last: { ...LAST, extra: 2 } }, PATH)).toStrictEqual(
      { ...IDLE, last: LAST },
    );
  });

  it('refuses a record that is not one', () => {
    expect(field(undefined)).toBe('collection');
    expect(field(null)).toBe('collection');
    expect(field([])).toBe('collection');
    expect(field('idle')).toBe('collection');
  });

  it('refuses a phase it does not know', () => {
    expect(field({ ...IDLE, phase: 'repacking' })).toBe('phase');
    expect(field({ ...IDLE, phase: undefined })).toBe('phase');
  });

  it('refuses a phase under way with no start, and idle with one', () => {
    expect(field({ ...IDLE, phase: 'holding' })).toBe('since');
    expect(field({ ...IDLE, phase: 'holding', since: 'yesterday' })).toBe('since');
    expect(field({ ...IDLE, since: '2026-10-11T12:00:00.000Z' })).toBe('since');
  });

  it('refuses an instant written any other way than the daemon writes it', () => {
    expect(field({ ...IDLE, last: { ...LAST, endedAt: '2026-10-11' } })).toBe('last.endedAt');
    expect(field({ ...IDLE, last: { ...LAST, endedAt: 0 } })).toBe('last.endedAt');
  });

  it('refuses a duration or a size that is not a whole count', () => {
    expect(field({ ...IDLE, last: { ...LAST, pausedMs: -1 } })).toBe('last.pausedMs');
    expect(field({ ...IDLE, last: { ...LAST, pausedMs: 1.5 } })).toBe('last.pausedMs');
    expect(field({ ...IDLE, last: { ...LAST, quietMs: '70' } })).toBe('last.quietMs');
    expect(field({ ...IDLE, last: { ...LAST, before: null } })).toBe('last.before');
    expect(field({ ...IDLE, last: { ...LAST, before: { ...SIZE, loose: null } } })).toBe(
      'last.before.loose',
    );
    expect(field({ ...IDLE, last: { ...LAST, after: { ...SIZE, packed: -1 } } })).toBe(
      'last.after.packed',
    );
    expect(field({ ...IDLE, last: { ...LAST, after: { ...SIZE, kib: 'x' } } })).toBe(
      'last.after.kib',
    );
  });

  it('refuses a missing last or failing rather than reading it as none', () => {
    expect(field({ phase: 'idle', since: null, failing: null })).toBe('last');
    expect(field({ phase: 'idle', since: null, last: null })).toBe('failing');
  });

  it('refuses a failure that counts none, has no next attempt or no reason', () => {
    expect(field({ ...IDLE, failing: { ...FAILING, failures: 0 } })).toBe('failing.failures');
    expect(field({ ...IDLE, failing: { ...FAILING, retryAt: null } })).toBe('failing.retryAt');
    expect(field({ ...IDLE, failing: { ...FAILING, reason: 5 } })).toBe('failing.reason');
  });

  it('says what it refused and where it came from', () => {
    expect(() => parseCollection(null, PATH)).toThrow(
      expect.objectContaining({
        code: 'API_REQUEST_INVALID',
        details: { path: PATH, field: 'collection' },
      }) as Error,
    );
  });
});
