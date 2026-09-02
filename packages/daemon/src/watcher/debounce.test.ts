import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebouncer } from './debounce.js';

describe('createDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const collect = (options: { waitMs?: number; maxWaitMs?: number } = {}) => {
    const flushed: [string, string[]][] = [];
    const debouncer = createDebouncer({
      waitMs: options.waitMs ?? 100,
      ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
      onFlush: (key, values) => flushed.push([key, [...values]]),
    });
    return { debouncer, flushed };
  };

  it('collapses a burst into one flush', () => {
    const { debouncer, flushed } = collect();

    // The three events a single atomic save produces: temp file, rename, write.
    debouncer.push('wt', 'a.tmp');
    debouncer.push('wt', 'a.txt');
    debouncer.push('wt', 'a.txt');
    vi.advanceTimersByTime(100);

    // Deduplicated: `a.txt` arrived twice and the consumer runs one `git status`
    // per path it is handed.
    expect(flushed).toEqual([['wt', ['a.tmp', 'a.txt']]]);
  });

  it('does not flush before the quiet period', () => {
    const { debouncer, flushed } = collect();

    debouncer.push('wt', 'a.txt');
    vi.advanceTimersByTime(99);

    expect(flushed).toEqual([]);
  });

  it('restarts the quiet period on each value', () => {
    const { debouncer, flushed } = collect();

    debouncer.push('wt', 'a.txt');
    vi.advanceTimersByTime(80);
    debouncer.push('wt', 'b.txt');
    vi.advanceTimersByTime(80);

    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(flushed).toEqual([['wt', ['a.txt', 'b.txt']]]);
  });

  it('keeps worktrees independent', () => {
    const { debouncer, flushed } = collect();

    debouncer.push('one', 'a.txt');
    vi.advanceTimersByTime(60);
    debouncer.push('two', 'b.txt');
    vi.advanceTimersByTime(40);

    // One busy worktree must not hold back another's signal.
    expect(flushed).toEqual([['one', ['a.txt']]]);
    vi.advanceTimersByTime(60);
    expect(flushed).toEqual([
      ['one', ['a.txt']],
      ['two', ['b.txt']],
    ]);
  });

  it('flushes at the ceiling under a writer that never pauses', () => {
    const { debouncer, flushed } = collect({ waitMs: 100, maxWaitMs: 250 });

    // An agent rewriting files in a loop: with a trailing debounce alone the
    // deadline moves forever and nothing is ever reported.
    for (let elapsed = 0; elapsed < 400; elapsed += 50) {
      debouncer.push('wt', `f${String(elapsed)}.txt`);
      vi.advanceTimersByTime(50);
    }

    expect(flushed.length).toBeGreaterThan(0);
    expect(flushed[0]?.[0]).toBe('wt');
  });

  it('never holds a key past the ceiling', () => {
    const { debouncer, flushed } = collect({ waitMs: 100, maxWaitMs: 250 });

    for (let elapsed = 0; elapsed < 250; elapsed += 10) {
      debouncer.push('wt', 'a.txt');
      vi.advanceTimersByTime(10);
    }

    expect(flushed).toHaveLength(1);
  });

  it('flushes on demand', () => {
    const { debouncer, flushed } = collect();

    debouncer.push('wt', 'a.txt');
    debouncer.flush('wt');

    expect(flushed).toEqual([['wt', ['a.txt']]]);
    // Not just "no second flush": the timer is disarmed. A stale one keeps the
    // event loop alive and pins its closure, once per worktree per burst.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(flushed).toHaveLength(1);
  });

  it('flushes every key when told to', () => {
    const { debouncer, flushed } = collect();

    debouncer.push('one', 'a.txt');
    debouncer.push('two', 'b.txt');
    debouncer.flush();

    expect(flushed.map(([key]) => key)).toEqual(['one', 'two']);
    expect(debouncer.pendingKeys).toBe(0);
  });

  it('drops pending values on cancel without flushing', () => {
    const { debouncer, flushed } = collect();

    debouncer.push('wt', 'a.txt');
    debouncer.cancel();
    vi.advanceTimersByTime(1000);

    // Closing a watcher must not deliver a signal to a consumer that has gone.
    expect(flushed).toEqual([]);
    expect(debouncer.pendingKeys).toBe(0);
  });

  it('cancels one key without touching the others', () => {
    const { debouncer, flushed } = collect();

    debouncer.push('one', 'a.txt');
    debouncer.push('two', 'b.txt');
    debouncer.cancel('one');
    vi.advanceTimersByTime(100);

    expect(flushed).toEqual([['two', ['b.txt']]]);
  });

  it('refuses a ceiling below its quiet period', () => {
    // Every batch would flush at the ceiling and the quiet period would never
    // apply — a combination that describes nothing, so it is loud rather than
    // silently reinterpreted.
    expect(() => createDebouncer({ waitMs: 100, maxWaitMs: 50, onFlush: () => undefined })).toThrow(
      /ceiling is below/u,
    );
  });

  it('accepts a ceiling equal to its quiet period', () => {
    expect(() =>
      createDebouncer({ waitMs: 100, maxWaitMs: 100, onFlush: () => undefined }),
    ).not.toThrow();
  });

  it('ignores a flush for a key with nothing pending', () => {
    const { debouncer, flushed } = collect();

    debouncer.flush('wt');

    expect(flushed).toEqual([]);
  });
});
