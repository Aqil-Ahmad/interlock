import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, resolveConfig, validateConfig } from './config.js';
import { isInterlockError } from './errors.js';

describe('resolveConfig', () => {
  it('fills defaults for anything not provided', () => {
    const config = resolveConfig({ repos: ['/tmp/repo'] });
    expect(config.repos).toEqual(['/tmp/repo']);
    expect(config.daemon.port).toBe(DEFAULT_CONFIG.daemon.port);
    expect(config.scheduler.debounceMs).toBe(DEFAULT_CONFIG.scheduler.debounceMs);
  });

  it('merges nested sections instead of replacing them', () => {
    const config = resolveConfig({ scheduler: { concurrency: 8 } });
    expect(config.scheduler.concurrency).toBe(8);
    expect(config.scheduler.maxBranches).toBe(DEFAULT_CONFIG.scheduler.maxBranches);
  });

  it('reports every problem at once', () => {
    try {
      resolveConfig({ repos: ['relative/path'], daemon: { port: 80 } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isInterlockError(error)).toBe(true);
      const problems = (error as { details: { problems: string[] } }).details.problems;
      expect(problems).toHaveLength(2);
    }
  });
});

describe('security invariants', () => {
  it('cannot be configured off loopback', () => {
    const config = resolveConfig({ daemon: { host: '0.0.0.0' as '127.0.0.1' } });
    expect(config.daemon.host).toBe('127.0.0.1');
  });

  it('cannot enable sandbox networking', () => {
    const config = resolveConfig({ sandbox: { network: true as false } });
    expect(config.sandbox.network).toBe(false);
  });

  it('refuses execution analyzers when the sandbox is disabled', () => {
    const problems = validateConfig({
      ...DEFAULT_CONFIG,
      sandbox: { ...DEFAULT_CONFIG.sandbox, enabled: false },
    });
    expect(problems.join(' ')).toContain('require sandbox.enabled');
  });
});
