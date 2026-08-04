import { describe, expect, it } from 'vitest';
import { isMutatingCommand } from './repo-handle.js';

describe('isMutatingCommand', () => {
  it('flags commands that write repository state', () => {
    expect(isMutatingCommand(['commit', '-m', 'x'])).toBe(true);
    expect(isMutatingCommand(['worktree', 'add', '/tmp/wt'])).toBe(true);
  });

  it('sees through global flags that take a value', () => {
    expect(isMutatingCommand(['-C', '/repo', 'merge', 'feature'])).toBe(true);
    expect(isMutatingCommand(['-c', 'user.name=x', 'commit'])).toBe(true);
    expect(isMutatingCommand(['--git-dir', '/repo/.git', 'status'])).toBe(false);
  });

  it('allows read-only plumbing', () => {
    expect(isMutatingCommand(['rev-parse', 'HEAD'])).toBe(false);
    expect(isMutatingCommand(['status', '--porcelain=v2'])).toBe(false);
    expect(isMutatingCommand(['merge-base', 'a', 'b'])).toBe(false);
    expect(isMutatingCommand(['diff', '--name-only'])).toBe(false);
  });
});
