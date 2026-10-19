import { execFileSync } from 'node:child_process';
import { InterlockError } from '@interlock/shared';
import type { Logger } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBaselineDiffer } from '../src/analyzers/baseline.js';
import type { BaselineDiffer, BaselineOutcome, BaselineTree } from '../src/analyzers/baseline.js';
import { createTypecheckRegistry } from '../src/analyzers/typecheck.js';
import type {
  TypecheckOutcome,
  TypecheckRegistry,
  TypecheckRequest,
} from '../src/analyzers/typecheck.js';
import { createGitRunner } from '../src/git/repo-handle.js';
import type { GitRunner } from '../src/git/repo-handle.js';
import { PROJECT, SEMANTIC_CASES, baselineFixture } from './support/semantic-fixtures.js';
import type { BaselineFixture, Files } from './support/semantic-fixtures.js';

/**
 * The baseline differ against real trees: committed, merged in a shadow, and
 * checked by the type-check service in the pair's pool slot, every tree of the
 * four cycled through it.
 */

const lines = (...content: string[]): string => `${content.join('\n')}\n`;

const compared = (outcome: BaselineOutcome): Extract<BaselineOutcome, { kind: 'compared' }> => {
  if (outcome.kind !== 'compared') {
    throw new Error(`expected a comparison, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
};

/** What a merge-induced diagnostic is, reduced to what a test names. */
const named = (outcome: BaselineOutcome): { file: string; code: number; line: number }[] =>
  compared(outcome).induced.files.map((d) => ({ file: d.file, code: d.code, line: d.line }));

/** A function taking a number, and a file to call it from wrongly. */
const check = lines('export function check(value: number): number {', '  return value;', '}');

describe('baseline differ', () => {
  let fixture: BaselineFixture | undefined;
  let registry: TypecheckRegistry;
  let checks: string[];
  let listings: string[];
  let differ: BaselineDiffer;

  /** The registry the differ is given, counting checks by the slot's HEAD tree at the time. */
  const counting = (inner: TypecheckRegistry): TypecheckRegistry => ({
    check: (request: TypecheckRequest) => {
      checks.push(
        execFileSync('git', ['-C', request.root, 'rev-parse', 'HEAD^{tree}'], {
          encoding: 'utf8',
        }).trim(),
      );
      listings.push(request.tree.oid);
      return inner.check(request);
    },
    release: (root) => inner.release(root),
    close: () => inner.close(),
    get live() {
      return inner.live;
    },
  });

  beforeEach(() => {
    registry = createTypecheckRegistry();
    checks = [];
    listings = [];
    differ = createBaselineDiffer({ runner: createGitRunner(), registry: counting(registry) });
  });

  afterEach(async () => {
    await registry.close();
    fixture?.dispose();
    fixture = undefined;
  });

  const open = async (base: Files): Promise<BaselineFixture> => {
    fixture = await baselineFixture(base);
    return fixture;
  };

  describe('the semantic pairs', () => {
    for (const semantic of SEMANTIC_CASES) {
      it(`${semantic.id}: ${semantic.expected === null ? 'nothing' : 'exactly one diagnostic'} merge-induced`, async () => {
        const repo = await open(semantic.base);
        const outcome = await repo.compare(differ, { one: semantic.one, two: semantic.two });
        const found = compared(outcome).induced;
        expect(found.config).toEqual([]);
        if (semantic.expected === null) {
          expect(found.files).toEqual([]);
        } else {
          expect(found.files).toHaveLength(1);
          expect(found.files[0]).toMatchObject(semantic.expected);
        }
        expect(compared(outcome).checked).toEqual(['base', 'a', 'b', 'merge']);
      });
    }
  });

  describe('pre-existing errors', () => {
    it('reports nothing for a merge that adds no error to an already broken main, and still reports one that does', async () => {
      const repo = await open({
        ...PROJECT,
        'src/check.ts': check,
        'src/broken.ts': lines(
          'import { check } from "./check";',
          '',
          'export const wrong: number = "not a number";',
          'export const twice = check("again");',
        ),
        'src/money.ts': lines(
          'export function refund(amount: number): number {',
          '  return amount;',
          '}',
        ),
      });

      const quiet = await repo.compare(differ, {
        key: 'quiet',
        one: { write: { 'src/one.ts': 'export const one = 1;\n' } },
        two: { write: { 'src/two.ts': 'export const two = 2;\n' } },
      });
      expect(named(quiet)).toEqual([]);

      const loud = await repo.compare(differ, {
        key: 'loud',
        one: {
          write: {
            'src/money.ts': lines(
              'export function refund(amount: number, reason: string): number {',
              '  return amount + reason.length;',
              '}',
            ),
          },
        },
        two: {
          write: {
            'src/use.ts': lines('import { refund } from "./money";', 'export const r = refund(1);'),
          },
        },
      });
      expect(named(loud)).toEqual([{ file: 'src/use.ts', code: 2554, line: 2 }]);
    });

    it('does not count an error one side has alone, even where the merge moved its line', async () => {
      const repo = await open({
        ...PROJECT,
        'src/check.ts': check,
        'src/calls.ts': lines(
          'import { check } from "./check";',
          '',
          'export const first = check(1);',
          '',
          '',
          '',
          'export const last = check(2);',
        ),
      });
      const outcome = await repo.compare(differ, {
        // A breaks a call at the bottom of the file; B adds lines at the top,
        // so the merge carries A's error lower than A does.
        one: {
          write: {
            'src/calls.ts': lines(
              'import { check } from "./check";',
              '',
              'export const first = check(1);',
              '',
              '',
              '',
              'export const last = check("2");',
            ),
          },
        },
        two: {
          write: {
            'src/calls.ts': lines(
              'import { check } from "./check";',
              'export const zeroth = check(0);',
              'export const half = check(0.5);',
              '',
              'export const first = check(1);',
              '',
              '',
              '',
              'export const last = check(2);',
            ),
          },
        },
      });
      expect(named(outcome)).toEqual([]);
    });

    it('recognises an error of the base whose line moved in the merge', async () => {
      const repo = await open({
        ...PROJECT,
        'src/check.ts': check,
        'src/calls.ts': lines(
          'import { check } from "./check";',
          '',
          'export const first = check("1");',
          '',
          '',
          '',
          'export const last = check(2);',
        ),
      });
      const outcome = await repo.compare(differ, {
        one: {
          write: {
            'src/calls.ts': lines(
              'import { check } from "./check";',
              '// one line above the error',
              '// and another',
              '',
              'export const first = check("1");',
              '',
              '',
              '',
              'export const last = check(2);',
            ),
          },
        },
        two: {
          write: {
            'src/calls.ts': lines(
              'import { check } from "./check";',
              '',
              'export const first = check("1");',
              '',
              '',
              '',
              'export const last = check(2);',
              'export const more = check(3);',
            ),
          },
        },
      });
      expect(named(outcome)).toEqual([]);
    });

    it('counts copies: two in the merge against one before it leaves one merge-induced', async () => {
      const call = (name: string, type: string): string =>
        `export function ${name}(input: ${type}): number {\n  return check(input);\n}\n`;
      const repo = await open({
        ...PROJECT,
        'src/check.ts': check,
        'src/types.ts': 'export type Text = number;\n',
        // One copy everywhere: a string passed where a number goes.
        'src/calls.ts': `import { check } from "./check";\nimport type { Text } from "./types";\n\n${call('first', 'string')}`,
      });
      const outcome = await repo.compare(differ, {
        // A makes `Text` a string; B adds a call taking a `Text`. Neither has
        // the second copy; the merge does, with the first's identity exactly.
        one: { write: { 'src/types.ts': 'export type Text = string;\n' } },
        two: {
          write: {
            'src/calls.ts': `import { check } from "./check";\nimport type { Text } from "./types";\n\n${call('first', 'string')}\n${call('second', 'Text')}`,
          },
        },
      });
      const found = named(outcome);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ file: 'src/calls.ts', code: 2345 });
      // The copy past the count is the one reported: the merge's second.
      expect(found[0]!.line).toBe(9);
    });

    it('follows a file renamed on one side back to its old name in the trees that have it', async () => {
      const filler = Array.from({ length: 12 }, (_, i) => `export const filler${i} = ${i};`);
      const old = lines(
        'import { check } from "./check";',
        ...filler,
        'export const wrong = check("a");',
      );
      const repo = await open({ ...PROJECT, 'src/check.ts': check, 'src/old.ts': old });
      const outcome = await repo.compare(differ, {
        // A renames the file untouched; B rewrites most of it, keeping the
        // call broken in its own way. The merge has B's error under A's name,
        // which only B explains, under the old name — and the merge is too
        // unlike the base for the diff between them to call it a rename, so
        // only A's own diff joins the two names.
        one: { remove: ['src/old.ts'], write: { 'src/new.ts': old } },
        two: {
          write: {
            'src/old.ts': lines(
              'import { check } from "./check";',
              ...filler.map((line) => line.replace(/= (\d+);/u, '= "$1".length;')),
              'export const wrong = check("b");',
            ),
          },
        },
      });
      expect(named(outcome)).toEqual([]);
    });
  });

  describe('configuration', () => {
    it('returns a configuration error only the merge has apart from the files', async () => {
      const repo = await open({
        ...PROJECT,
        'tsconfig.json': JSON.stringify({
          extends: './base.json',
          compilerOptions: { strict: true, noEmit: true },
          include: ['src'],
        }),
        'base.json': JSON.stringify({
          compilerOptions: { target: 'es2022', module: 'esnext', moduleResolution: 'bundler' },
        }),
        'src/a.ts': 'export const a = 1;\n',
      });
      // A's option and B's option each stand alone, and contradict together.
      const outcome = await repo.compare(differ, {
        one: {
          write: {
            'base.json': JSON.stringify({
              compilerOptions: {
                target: 'es2022',
                module: 'esnext',
                moduleResolution: 'bundler',
                sourceMap: true,
              },
            }),
          },
        },
        two: {
          write: {
            'tsconfig.json': JSON.stringify({
              extends: './base.json',
              compilerOptions: { strict: true, noEmit: true, inlineSourceMap: true },
              include: ['src'],
            }),
          },
        },
      });
      // Measured before choosing: the pair is only a fixture if the merge's
      // configuration fails where neither side's does.
      const found = compared(outcome).induced;
      expect(found.files).toEqual([]);
      expect(found.config.length).toBeGreaterThan(0);
      expect(found.config.every((d) => d.category === 'error')).toBe(true);
    });
  });

  describe('trees that cannot be checked', () => {
    it('is unavailable when the base cannot be judged, never an empty comparison', async () => {
      const repo = await open({
        ...PROJECT,
        'tsconfig.json': JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, target: 'not-a-target' },
          include: ['src'],
        }),
        'src/a.ts': 'export const a = 1;\n',
      });
      const outcome = await repo.compare(differ, {
        one: { write: { 'src/one.ts': 'export const one: number = "x";\n' } },
      });
      expect(outcome).toMatchObject({ kind: 'unavailable', tree: 'base' });
      // Refused as soon as the base was seen: nothing else was checked.
      expect(checks).toHaveLength(1);

      // And again from the cache, with a side moved on: still nothing checked.
      checks = [];
      const again = await repo.compare(differ, {
        one: { write: { 'src/one.ts': 'export const one: number = "y";\n' } },
      });
      expect(again).toMatchObject({ kind: 'unavailable', tree: 'base' });
      expect(checks).toEqual([]);
    });

    it('is unavailable when a side cannot be checked against the installed dependencies', async () => {
      const repo = await open({ ...PROJECT, 'src/a.ts': 'export const a = 1;\n' });
      // Installed from A, which changed the manifest: the base and B differ from it.
      const outcome = await repo.compare(differ, {
        one: {
          write: {
            'package.json':
              '{\n  "name": "fixture",\n  "private": true,\n  "type": "module",\n  "version": "1.0.0"\n}\n',
          },
        },
        dependencies: 'one',
      });
      expect(outcome).toMatchObject({ kind: 'unavailable', tree: 'base' });
      expect(checks).toEqual([]);
    });

    it('is unavailable when the type checker dies, and the slot is back on the merge', async () => {
      const repo = await open({ ...PROJECT, 'src/a.ts': 'export const a = 1;\n' });
      let calls = 0;
      const dying: TypecheckRegistry = {
        ...registry,
        check: (request) => {
          calls += 1;
          // As the registry answers a check whose worker exits under it.
          if (calls === 2) {
            return Promise.resolve({
              kind: 'crashed',
              message: 'the worker exited with code 1',
            });
          }
          return registry.check(request);
        },
        release: (root) => registry.release(root),
        close: () => registry.close(),
        live: 0,
      };
      const differ = createBaselineDiffer({ runner: createGitRunner(), registry: dying });
      let head = '';
      let expected = '';
      const outcome = await repo.compare(
        differ,
        { one: { write: { 'src/one.ts': 'export const one = 1;\n' } } },
        {
          inside: (slot) => {
            head = execFileSync('git', ['-C', slot.path, 'rev-parse', 'HEAD'], {
              encoding: 'utf8',
            }).trim();
            expected = slot.commitSha;
          },
        },
      );
      expect(outcome).toMatchObject({ kind: 'unavailable', tree: 'a' });
      expect(head).toBe(expected);
      // A tree that failed is not remembered as checked.
      expect(differ.cached).toBe(1);
    });

    it('stops where it stands when cancelled, and the slot is back on the merge', async () => {
      const repo = await open({ ...PROJECT, 'src/a.ts': 'export const a = 1;\n' });
      const controller = new AbortController();
      let calls = 0;
      const cancelling: TypecheckRegistry = {
        ...registry,
        check: (request) => {
          calls += 1;
          if (calls === 2) controller.abort();
          return registry.check(request);
        },
        release: (root) => registry.release(root),
        close: () => registry.close(),
        live: 0,
      };
      const differ = createBaselineDiffer({ runner: createGitRunner(), registry: cancelling });
      let head = '';
      let expected = '';
      const outcome = await repo.compare(
        differ,
        { one: { write: { 'src/one.ts': 'export const one = 1;\n' } } },
        {
          signal: controller.signal,
          inside: (slot) => {
            head = execFileSync('git', ['-C', slot.path, 'rev-parse', 'HEAD'], {
              encoding: 'utf8',
            }).trim();
            expected = slot.commitSha;
          },
        },
      );
      expect(outcome).toEqual({ kind: 'cancelled' });
      expect(head).toBe(expected);
    });
  });

  describe('a check that ends without a report', () => {
    const outcomes: [string, TypecheckOutcome, RegExp][] = [
      ['a timeout', { kind: 'timeout', deadlineMs: 180_000 }, /180000 ms/u],
      ['an exhausted heap', { kind: 'out-of-memory', maxHeapMb: 3072 }, /3072 MiB/u],
      [
        'an install that moved under it',
        { kind: 'infra-failure', reason: 'install-changed', message: 'reinstalled' },
        /install-changed/u,
      ],
    ];
    for (const [name, ended, reason] of outcomes) {
      it(`is unavailable for ${name}, and the slot is back on the merge`, async () => {
        const repo = await open({ ...PROJECT, 'src/a.ts': 'export const a = 1;\n' });
        const ending: TypecheckRegistry = {
          ...registry,
          check: () => Promise.resolve(ended),
          release: (root) => registry.release(root),
          close: () => registry.close(),
          live: 0,
        };
        const differ = createBaselineDiffer({ runner: createGitRunner(), registry: ending });
        let head = '';
        let expected = '';
        const outcome = await repo.compare(
          differ,
          { one: { write: { 'src/one.ts': 'export const one = 1;\n' } } },
          {
            inside: (slot) => {
              head = execFileSync('git', ['-C', slot.path, 'rev-parse', 'HEAD'], {
                encoding: 'utf8',
              }).trim();
              expected = slot.commitSha;
            },
          },
        );
        expect(outcome).toMatchObject({ kind: 'unavailable', tree: 'base' });
        if (outcome.kind === 'unavailable') expect(outcome.reason).toMatch(reason);
        expect(head).toBe(expected);
        expect(differ.cached).toBe(0);
      });
    }
  });

  describe('the cache', () => {
    it('checks again only the side that changed, and the merge', async () => {
      const repo = await open({
        ...PROJECT,
        'src/check.ts': check,
        'src/a.ts': 'export const a = 1;\n',
      });
      const one = { write: { 'src/one.ts': 'export const one = 1;\n' } };

      const first = compared(
        await repo.compare(differ, {
          key: 'pair',
          one,
          two: { write: { 'src/two.ts': 'export const two = 2;\n' } },
        }),
      );
      expect(first.checked).toEqual(['base', 'a', 'b', 'merge']);
      expect(checks).toHaveLength(4);

      checks = [];
      const second = compared(
        await repo.compare(differ, {
          key: 'pair',
          one,
          two: {
            write: {
              'src/two.ts': 'import { check } from "./check";\nexport const two = check("2");\n',
            },
          },
        }),
      );
      expect(second.checked).toEqual<BaselineTree[]>(['b', 'merge']);
      expect(checks).toHaveLength(2);
      // B's own error is B's, not the merge's.
      expect(second.induced.files).toEqual([]);
    });

    it('answers an unchanged pair without a check', async () => {
      const repo = await open({ ...PROJECT, 'src/a.ts': 'export const a = 1;\n' });
      const pair = { one: { write: { 'src/one.ts': 'export const one = 1;\n' } } };
      await repo.compare(differ, pair);
      checks = [];
      const again = compared(await repo.compare(differ, pair));
      expect(again.checked).toEqual([]);
      expect(checks).toEqual([]);
    });

    it('holds no more reports than its bound', async () => {
      const repo = await open({ ...PROJECT, 'src/a.ts': 'export const a = 1;\n' });
      const bounded = createBaselineDiffer({
        runner: createGitRunner(),
        registry: counting(registry),
        cacheSize: 2,
      });
      await repo.compare(bounded, {
        one: { write: { 'src/one.ts': 'export const one = 1;\n' } },
        two: { write: { 'src/two.ts': 'export const two = 2;\n' } },
      });
      expect(bounded.cached).toBe(2);
      expect(() =>
        createBaselineDiffer({ runner: createGitRunner(), registry, cacheSize: 0 }),
      ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    });
  });

  describe('the slot', () => {
    it('sends each check the listing of the tree the slot holds', async () => {
      const repo = await open({ ...PROJECT, 'src/a.ts': 'export const a = 1;\n' });
      await repo.compare(differ, {
        one: { write: { 'src/one.ts': 'export const one = 1;\n' } },
        two: { write: { 'src/two.ts': 'export const two = 2;\n' } },
      });
      expect(new Set(checks).size).toBe(4);
      expect(listings).toEqual(checks);
    });

    it('answers when the slot cannot be put back on the merge, which its next fill corrects', async () => {
      const repo = await open({ ...PROJECT, 'src/a.ts': 'export const a = 1;\n' });
      const runner = createGitRunner();
      let resets = 0;
      const failingRestore: GitRunner = {
        run: (repo, args, options) => {
          if (args[0] === 'reset') {
            resets += 1;
            // The first reset moves to the base; the second would move back.
            if (resets === 2) {
              return Promise.resolve({ stdout: '', stderr: 'fatal: no', exitCode: 128 });
            }
          }
          return runner.run(repo, args, options);
        },
      };
      const warnings: string[] = [];
      const logger = recording(warnings);
      const dying: TypecheckRegistry = {
        ...registry,
        check: () =>
          Promise.reject(
            new InterlockError('GIT_COMMAND_FAILED', 'The shadow could not be read', {
              infra: true,
            }),
          ),
        release: (root) => registry.release(root),
        close: () => registry.close(),
        live: 0,
      };
      const differ = createBaselineDiffer({ runner: failingRestore, registry: dying, logger });
      const outcome = await repo.compare(differ, {
        one: { write: { 'src/one.ts': 'export const one = 1;\n' } },
      });
      expect(outcome).toMatchObject({ kind: 'unavailable', tree: 'base' });
      expect(warnings).toContain('pool slot not returned to its merge');
    });

    it('raises an error that is not the environment’s rather than call it unavailable', async () => {
      const repo = await open({ ...PROJECT, 'src/a.ts': 'export const a = 1;\n' });
      const broken: TypecheckRegistry = {
        ...registry,
        check: () => Promise.reject(new Error('a bug, not an outage')),
        release: (root) => registry.release(root),
        close: () => registry.close(),
        live: 0,
      };
      const differ = createBaselineDiffer({ runner: createGitRunner(), registry: broken });
      await expect(
        repo.compare(differ, { one: { write: { 'src/one.ts': 'export const one = 1;\n' } } }),
      ).rejects.toThrow('a bug, not an outage');
    });
  });
});

/** A logger keeping each warning's message. */
function recording(warnings: string[]): Logger {
  const logger: Logger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => {
      warnings.push(message);
    },
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}
