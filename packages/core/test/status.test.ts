import { describe, expect, it } from 'vitest';
import { isUnmerged, isUntracked, parseStatus } from '../src/git/status.js';

/**
 * The status parser, driven with hand-built bytes.
 *
 * Its callers reach it through a real repository, which cannot produce every
 * shape on demand — an unmerged entry needs a conflicting merge, and a path
 * holding a newline is awkward to create on some filesystems. A regression here
 * would surface as a wrong snapshot rather than as a parse error.
 */
describe('parseStatus', () => {
  const nul = (...fields: string[]): string => fields.join('\0');

  it('reads a rename as destination then source', () => {
    // The reverse of `diff --name-status -z`, which puts the source first.
    expect(parseStatus(nul('R  to.txt', 'from.txt', ''))).toEqual([
      { index: 'R', worktree: ' ', path: 'to.txt', origPath: 'from.txt' },
    ]);
  });

  it('does not read the next entry as a source when there was no rename', () => {
    expect(parseStatus(nul(' M one.txt', '?? two.txt', ''))).toEqual([
      { index: ' ', worktree: 'M', path: 'one.txt', origPath: null },
      { index: '?', worktree: '?', path: 'two.txt', origPath: null },
    ]);
  });

  it('keeps a path containing a newline whole', () => {
    // Splitting this stream on newlines would cut the name in half and yield
    // two paths, neither of which exists.
    expect(parseStatus(nul(' M has\nnewline.txt', ''))[0]?.path).toBe('has\nnewline.txt');
  });

  it('keeps a path containing a space, which starts three characters in', () => {
    expect(parseStatus(nul('?? has space.txt', ''))[0]?.path).toBe('has space.txt');
  });

  it('ignores a field too short to be an entry', () => {
    expect(parseStatus(nul('', ' M', 'x', ' M ok.txt', ''))).toEqual([
      { index: ' ', worktree: 'M', path: 'ok.txt', origPath: null },
    ]);
  });

  it('stops cleanly when a rename has no source field', () => {
    expect(parseStatus(nul('R  to.txt'))).toEqual([
      { index: 'R', worktree: ' ', path: 'to.txt', origPath: null },
    ]);
  });
});

describe('classifying an entry', () => {
  const entry = (
    code: string,
  ): { index: string; worktree: string; path: string; origPath: null } => ({
    index: code[0]!,
    worktree: code[1]!,
    path: 'x',
    origPath: null,
  });

  it.each(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])('reads %s as unmerged', (code) => {
    expect(isUnmerged(entry(code))).toBe(true);
  });

  it.each(['MM', 'A ', ' M', '??'])('does not read %s as unmerged', (code) => {
    expect(isUnmerged(entry(code))).toBe(false);
  });

  it('reads only both-question-marks as untracked', () => {
    expect(isUntracked(entry('??'))).toBe(true);
    expect(isUntracked(entry(' M'))).toBe(false);
  });
});
