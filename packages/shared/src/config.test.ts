import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  MAX_IGNORE_PATTERN_LENGTH,
  MAX_IGNORE_PATTERNS,
  parseRepoConfigOverride,
  resolveConfig,
  validateConfig,
} from './config.js';
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

/** Reads the problem list off a rejected parse, or fails the test. */
function problemsFrom(source: string): string[] {
  try {
    parseRepoConfigOverride(source, '/repo/.interlock.json');
    expect.unreachable('should have thrown');
  } catch (error) {
    expect(isInterlockError(error)).toBe(true);
    return (error as { details: { problems: string[] } }).details.problems;
  }
}

describe('validateConfig', () => {
  const { scheduler: S, sandbox: B, mcp: M } = DEFAULT_CONFIG;

  it('refuses a value of the wrong type before testing its range', () => {
    // The config arrives through JSON.parse, so a range test can be handed a
    // string, where it never fires and the value poisons the arithmetic that
    // reads it: a string debounce makes every deadline NaN.
    const problems = validateConfig({
      ...DEFAULT_CONFIG,
      scheduler: { ...DEFAULT_CONFIG.scheduler, debounceMs: 'abc' as unknown as number },
    });
    expect(problems).toEqual(['scheduler.debounceMs must be a number']);
  });

  it.each([
    ['logLevel outside its union', { logLevel: 'shout' }, 'logLevel must be one of'],
    ['a non-array repos', { repos: 'dist' }, 'repos must be an array'],
    ['an empty dataDir', { dataDir: '' }, 'dataDir must be a non-empty path'],
  ])('refuses %s', (_name, patch, expected) => {
    const problems = validateConfig({ ...DEFAULT_CONFIG, ...patch } as never);
    expect(problems.join('; ')).toContain(expected);
  });

  it('refuses a non-boolean analyzer flag', () => {
    const problems = validateConfig({
      ...DEFAULT_CONFIG,
      analyzers: { ...DEFAULT_CONFIG.analyzers, textual: 'yes' as unknown as boolean },
    });
    expect(problems).toContain('analyzers.textual must be true or false');
  });

  it('refuses the daemon and mcp sharing a port', () => {
    // A constraint between two sections rather than within one, so nothing
    // else in the file exercises the path that reads both.
    const problems = validateConfig({
      ...DEFAULT_CONFIG,
      mcp: { ...DEFAULT_CONFIG.mcp, port: DEFAULT_CONFIG.daemon.port },
    });
    expect(problems).toContain('daemon.port and mcp.port must differ');
  });

  it.each([
    ['scheduler.concurrency must be >= 1', { scheduler: { ...S, concurrency: 0 } }],
    ['scheduler.maxBranches must be >= 2', { scheduler: { ...S, maxBranches: 1 } }],
    [
      'scheduler.overlapPriorityBoost must be >= 0',
      { scheduler: { ...S, overlapPriorityBoost: -1 } },
    ],
    ['sandbox.cpuLimit must be > 0', { sandbox: { ...B, cpuLimit: 0 } }],
    ['sandbox.memoryLimitMb must be >= 512', { sandbox: { ...B, memoryLimitMb: 8 } }],
    ['sandbox.timeoutMs must be >= 1000', { sandbox: { ...B, timeoutMs: 10 } }],
    ['mcp.maxWarningsPerHour must be >= 0', { mcp: { ...M, maxWarningsPerHour: -1 } }],
  ])('refuses %s', (expected, patch) => {
    expect(validateConfig({ ...DEFAULT_CONFIG, ...patch })).toContain(expected);
  });
});

describe('parseRepoConfigOverride', () => {
  const parse = (source: string): unknown =>
    parseRepoConfigOverride(source, '/repo/.interlock.json');

  it('reads the fields a repository may override', () => {
    expect(
      parse(
        JSON.stringify({
          ignore: ['dist/**'],
          ignoreBranches: ['release/*'],
          toolchain: { install: 'pnpm i', test: 'pnpm test' },
        }),
      ),
    ).toEqual({
      ignore: ['dist/**'],
      ignoreBranches: ['release/*'],
      toolchain: { install: 'pnpm i', test: 'pnpm test' },
    });
  });

  it('reads an empty object as no overrides', () => {
    expect(parse('{}')).toEqual({});
  });

  it.each([
    ['an empty toolchain', { toolchain: {} }],
    ['an empty ignore list', { ignore: [] }],
  ])('drops %s rather than keeping a second spelling of nothing', (_name, value) => {
    expect(parse(JSON.stringify(value))).toEqual({});
  });

  it('tolerates a leading byte-order mark', () => {
    // Not whitespace to JSON.parse, and some editors write one unasked.
    expect(parse(`\uFEFF{"ignore":["dist"]}`)).toEqual({ ignore: ['dist'] });
  });

  it.each([
    ['not JSON at all', 'nope', 'not valid JSON'],
    ['a JSON array', '[]', 'top level must be a JSON object'],
    ['JSON null', 'null', 'top level must be a JSON object'],
    ['a bare string', '"hello"', 'top level must be a JSON object'],
  ])('refuses %s', (_name, source, expected) => {
    expect(problemsFrom(source).join('; ')).toContain(expected);
  });

  it('refuses a key it does not recognise', () => {
    // A typo that is quietly ignored is indistinguishable from a setting that
    // was never applied, so the count and the accepted set are both reported.
    expect(problemsFrom(JSON.stringify({ ignoreBranch: ['x'] }))).toContain(
      'the file has 1 unknown key; expected only ignore, ignoreBranches, toolchain',
    );
    expect(problemsFrom(JSON.stringify({ toolchain: { lint: 'x' } }))).toContain(
      'toolchain has 1 unknown key; expected only install, typecheck, build, test',
    );
  });

  it.each([
    ['a value', { ignoreBranches: ['ok', 'sk-secret-token', 42] }],
    ['a key', { 'sk-secret-token': 1 }],
    ['a key inside toolchain', { toolchain: { 'sk-secret-token': 'x' } }],
  ])('names the shape expected, never %s the file chose', (_name, value) => {
    // The file is repository content and the error reaches agents, so nothing
    // written into it travels back out with the complaint. A key is chosen the
    // same way a value is: `{"<injected text>": 1}` is a valid JSON object.
    expect(problemsFrom(JSON.stringify(value)).join('; ')).not.toContain('sk-secret-token');
  });

  it('keeps the complaint smaller than the file that caused it', () => {
    // Echoing each unknown key produced an error twice the size of a file full
    // of them, and one key may be as long as the file allows.
    const many = Object.fromEntries(Array.from({ length: 4_000 }, (_, i) => [`k${String(i)}`, 1]));
    const oneEnormous = { ['A'.repeat(60_000)]: 1 };

    for (const value of [many, oneEnormous]) {
      const source = JSON.stringify(value);
      const problems = problemsFrom(source);
      expect(problems).toHaveLength(1);
      expect(problems.join('; ').length).toBeLessThan(source.length);
    }
  });

  it.each([
    ['a non-array list', { ignore: 'dist' }, 'ignore must be an array of strings'],
    ['an empty pattern', { ignore: [''] }, 'ignore[0] must not be empty'],
    ['a non-object toolchain', { toolchain: [] }, 'toolchain must be a JSON object'],
    ['an empty command', { toolchain: { test: '' } }, 'toolchain.test must be a non-empty string'],
  ])('refuses %s', (_name, value, expected) => {
    expect(problemsFrom(JSON.stringify(value))).toContain(expected);
  });

  it('refuses a pattern too long to be matched', () => {
    // The matcher caps length too and would answer false, which is a rule that
    // silently never fires. Refusing at the boundary is what makes it visible.
    const pattern = 'a'.repeat(MAX_IGNORE_PATTERN_LENGTH + 1);
    expect(problemsFrom(JSON.stringify({ ignoreBranches: [pattern] }))).toContain(
      `ignoreBranches[0] is longer than ${String(MAX_IGNORE_PATTERN_LENGTH)} characters`,
    );
  });

  it('refuses more patterns than it will match against every branch', () => {
    const many = Array.from({ length: MAX_IGNORE_PATTERNS + 1 }, (_, i) => `b${String(i)}`);
    expect(problemsFrom(JSON.stringify({ ignoreBranches: many })).join('; ')).toContain(
      `more than ${String(MAX_IGNORE_PATTERNS)}`,
    );
  });

  it('reports every problem at once', () => {
    const problems = problemsFrom(
      JSON.stringify({ nope: 1, ignore: 5, toolchain: { build: 7, wat: 'x' } }),
    );
    expect(problems).toHaveLength(4);
  });
});
