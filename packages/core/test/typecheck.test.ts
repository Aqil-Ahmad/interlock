import { execFile, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@interlock/shared';
import type { LogRecord } from '@interlock/shared';
import {
  createTypecheckRegistry,
  installIdentity,
  installRoots,
  listTree,
} from '../src/analyzers/typecheck.js';
import type {
  TreeListing,
  TypecheckOutcome,
  TypecheckRegistry,
  TypecheckReport,
  TypecheckRequest,
} from '../src/analyzers/typecheck.js';
import { createGitRunner } from '../src/git/repo-handle.js';
import type { PoolSlot } from '../src/git/worktree-pool.js';
import { byPlace, slotFixture, treeOf, tscDiagnostics } from './support/typecheck-fixtures.js';
import type { Files, Printed, SlotFixture } from './support/typecheck-fixtures.js';

/**
 * The type-check service, as the daemon runs it: in a worker, against trees
 * merged in a shadow and written into pool slots.
 *
 * `tsc` is the oracle wherever the two can be compared. Where the service
 * deliberately sees less than `tsc` would — a read outside the tree — the
 * test proves the read never happened, not merely that the answer differs.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const TSCONFIG = join(ROOT, 'tsconfig.check.json');
const HEAP_BOUND_CHECK = fileURLToPath(new URL('support/heap-bound-check.ts', import.meta.url));

/** A strict project with no ambient types, so a fixture needs no `node_modules`. */
const tsconfig = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    compilerOptions: {
      target: 'es2022',
      module: 'esnext',
      moduleResolution: 'bundler',
      lib: ['es2022'],
      types: [],
      strict: true,
      noUnusedLocals: true,
      ...extra,
    },
    include: ['src'],
  });

const checked = (outcome: TypecheckOutcome): Extract<TypecheckOutcome, { kind: 'checked' }> => {
  if (outcome.kind !== 'checked') throw new Error(`expected a check, got ${outcome.kind}`);
  return outcome;
};

/** The service's report, reduced to what `tsc` prints. */
const printed = (report: TypecheckReport): Printed[] =>
  [
    ...report.files.map((d) => ({ file: d.file, line: d.line, column: d.column, code: d.code })),
    ...report.config.map((d) => ({ file: d.file, line: null, column: null, code: d.code })),
  ].sort(byPlace);

/** `tsc`'s output with config-file positions dropped, which the service reports as offsets. */
const comparable = (diagnostics: readonly Printed[]): Printed[] =>
  diagnostics
    .map((d) => (d.file?.endsWith('.json') === true ? { ...d, line: null, column: null } : d))
    .sort(byPlace);

/** A check of what a slot holds, against a dependency checkout. */
const requestFor = async (
  slot: PoolSlot,
  dependencyRoot: string,
  extra: Partial<TypecheckRequest> = {},
): Promise<TypecheckRequest> => ({
  root: slot.path,
  dependencyRoot,
  tree: await treeOf(slot),
  ...extra,
});

/** Enough code that the checker polls its token many times over. */
const heavy = (): Record<string, string> => {
  const files: Record<string, string> = { 'tsconfig.json': tsconfig() };
  for (let i = 0; i < 200; i++) {
    files[`src/f${String(i)}.ts`] = Array.from(
      { length: 40 },
      (_, j) => `export const v${String(j)}: Record<string, number[]> = { a: [${String(j)}] };`,
    ).join('\n');
  }
  return files;
};

describe('type-check service', () => {
  let fixture: SlotFixture | undefined;
  let registry: TypecheckRegistry;

  beforeEach(() => {
    registry = createTypecheckRegistry();
  });

  afterEach(async () => {
    await registry.close();
    fixture?.dispose();
    fixture = undefined;
  });

  const open = async (base: Files, options?: Parameters<typeof slotFixture>[1]) => {
    fixture = await slotFixture(base, options);
    return fixture;
  };

  describe('diagnostics', () => {
    it('reports what tsc reports for the merged tree, and only the merged tree', async () => {
      const repo = await open({
        'tsconfig.json': tsconfig(),
        'src/money.ts': [
          'export function refund(amount: number): number {',
          '  return amount;',
          '}',
          '',
        ].join('\n'),
        'src/use.ts': ["import { refund } from './money';", 'export const r = refund(1);', ''].join(
          '\n',
        ),
      });
      await repo.inSlot(
        {
          // Each side compiles alone; together the call no longer fits.
          one: {
            'src/money.ts': [
              'export function refund(amount: number, reason: string): number {',
              '  return amount + reason.length;',
              '}',
              '',
            ].join('\n'),
          },
          two: {
            'src/use.ts': [
              "import { refund } from './money';",
              'export const r = refund(1);',
              "export const s: string = refund('2');",
              'const unused = 3;',
              '',
            ].join('\n'),
          },
        },
        async (slot) => {
          const outcome = checked(await registry.check(await requestFor(slot, repo.user)));
          const expected = tscDiagnostics(slot.path, 'tsconfig.json');

          expect(expected.length).toBeGreaterThanOrEqual(3);
          expect(printed(outcome.report)).toEqual(comparable(expected));
          expect(outcome.report.config).toEqual([]);
          expect(outcome.report.projects).toEqual(['tsconfig.json']);
          const call = outcome.report.files.find((d) => d.code === 2554);
          expect(call).toMatchObject({ file: 'src/use.ts', line: 2, category: 'error' });
          expect(call!.message).toContain('Expected 2 arguments');
          expect(call!.length).toBeGreaterThan(0);
        },
      );
    });

    it('stops at syntax errors, as tsc does, rather than reporting what follows from them', async () => {
      const repo = await open({ 'tsconfig.json': tsconfig(), 'src/a.ts': 'export const a = 1;\n' });
      await repo.inSlot(
        {
          one: { 'src/a.ts': 'export const a: number = "x";\nexport const b = (;\n' },
        },
        async (slot) => {
          const outcome = checked(await registry.check(await requestFor(slot, repo.user)));
          expect(printed(outcome.report)).toEqual(
            comparable(tscDiagnostics(slot.path, 'tsconfig.json')),
          );
          expect(outcome.report.files.map((d) => d.code)).not.toContain(2322);
        },
      );
    });

    it('reports declaration errors where tsc --noEmit does', async () => {
      const repo = await open({
        'tsconfig.json': tsconfig({ declaration: true, noUnusedLocals: false }),
        'src/a.ts': 'export const make = () => class {\n  x = 1;\n};\n',
      });
      await repo.inSlot(
        { one: { 'src/a.ts': 'export const make = () => class {\n  private x = 1;\n};\n' } },
        async (slot) => {
          const outcome = checked(await registry.check(await requestFor(slot, repo.user)));
          const expected = tscDiagnostics(slot.path, 'tsconfig.json');
          expect(expected.map((d) => d.code)).toEqual([4094]);
          expect(printed(outcome.report)).toEqual(comparable(expected));
        },
      );
    });

    it('checks a solution-style project through its references', async () => {
      const project = (name: string): Files => ({
        [`${name}/tsconfig.json`]: JSON.stringify({
          compilerOptions: {
            composite: true,
            target: 'es2022',
            lib: ['es2022'],
            types: [],
            strict: true,
            outDir: 'dist',
          },
          include: ['src'],
        }),
        [`${name}/src/index.ts`]: `export const ${name} = 1;\n`,
      });
      const repo = await open({
        'tsconfig.json': JSON.stringify({
          files: [],
          references: [{ path: 'one' }, { path: 'two' }],
        }),
        ...project('one'),
        ...project('two'),
      });
      await repo.inSlot(
        {
          one: { 'one/src/index.ts': 'export const one: string = 1;\n' },
          two: { 'two/src/index.ts': 'export const two = undefined.x;\n' },
        },
        async (slot) => {
          const outcome = checked(await registry.check(await requestFor(slot, repo.user)));
          // Run from the slot, each `tsc -p` names files as the service does.
          const expected = [
            ...tscDiagnostics(slot.path, 'one'),
            ...tscDiagnostics(slot.path, 'two'),
          ];
          expect(expected).toHaveLength(2);
          expect(printed(outcome.report)).toEqual(comparable(expected));
          expect(outcome.report.projects).toEqual([
            'one/tsconfig.json',
            'two/tsconfig.json',
            'tsconfig.json',
          ]);
        },
      );
    });

    it('reports a broken tsconfig as configuration, not as code', async () => {
      const repo = await open({ 'tsconfig.json': tsconfig(), 'src/a.ts': 'export const a = 1;\n' });
      await repo.inSlot(
        {
          one: {
            'tsconfig.json': JSON.stringify({
              compilerOptions: { strictest: true, lib: ['es2099'], types: [] },
              include: ['src'],
            }),
          },
        },
        async (slot) => {
          const outcome = checked(await registry.check(await requestFor(slot, repo.user)));
          expect(outcome.report.files).toEqual([]);
          const located = outcome.report.config.filter((d) => d.file !== null);
          expect(located.map((d) => [d.code, d.file])).toEqual([
            [5025, 'tsconfig.json'],
            [6046, 'tsconfig.json'],
          ]);
          // With no `lib` there are no global types: the environment, not the code.
          expect(
            new Set(outcome.report.config.filter((d) => d.file === null).map((d) => d.code)),
          ).toEqual(new Set([2318]));
          expect(printed(outcome.report)).toEqual(
            comparable(tscDiagnostics(slot.path, 'tsconfig.json')),
          );
        },
      );
    });

    it('reports a missing tsconfig as configuration, with no file', async () => {
      const repo = await open({ 'src/a.ts': 'export const a = 1;\n' });
      await repo.inSlot({}, async (slot) => {
        const outcome = checked(await registry.check(await requestFor(slot, repo.user)));
        expect(outcome.report.files).toEqual([]);
        expect(outcome.report.config).toMatchObject([{ code: 5083, file: null, start: null }]);
      });
    });

    it('type-checks a workspace package as the merge has it, not as the user has it', async () => {
      const base: Files = {
        'packages/lib/package.json': JSON.stringify({ name: '@fx/lib', types: 'src/index.ts' }),
        'packages/lib/src/index.ts':
          'export function greet(name: string): string {\n  return name;\n}\n',
        'packages/app/package.json': JSON.stringify({ name: '@fx/app' }),
        'packages/app/tsconfig.json': tsconfig(),
        'packages/app/src/main.ts':
          "import { greet } from '@fx/lib';\nexport const g = greet('a');\n",
      };
      const repo = await open(base);
      // pnpm's layout: the app's dependency is a link to the sibling package.
      repo.link('packages/app/node_modules/@fx/lib', '../../../lib');
      await repo.inSlot(
        {
          one: {
            'packages/lib/src/index.ts':
              'export function greet(name: string, loud: boolean): string {\n  return loud ? name : name;\n}\n',
          },
        },
        async (slot) => {
          const outcome = checked(
            await registry.check(
              await requestFor(slot, repo.user, { project: 'packages/app/tsconfig.json' }),
            ),
          );
          // The user's copy still takes one argument; only the merged one fails.
          expect(outcome.report.files.map((d) => [d.file, d.code])).toEqual([
            ['packages/app/src/main.ts', 2554],
          ]);
          expect(outcome.report.config).toEqual([]);
        },
      );
    });

    it('finds a file the merge added to a workspace package, through its link', async () => {
      const repo = await open({
        'packages/lib/package.json': JSON.stringify({ name: '@fx/lib' }),
        'packages/lib/index.ts': 'export const lib = 1;\n',
        'packages/app/tsconfig.json': tsconfig(),
        'packages/app/src/main.ts': 'export const app = 1;\n',
      });
      repo.link('packages/app/node_modules/@fx/lib', '../../../lib');
      await repo.inSlot(
        {
          // The user's checkout has no `extra.ts`: only the merged tree does.
          one: { 'packages/lib/extra.ts': 'export const extra: number = 1;\n' },
          two: {
            'packages/app/src/main.ts':
              "import { extra } from '@fx/lib/extra';\nexport const app: string = extra;\n",
          },
        },
        async (slot) => {
          const outcome = checked(
            await registry.check(
              await requestFor(slot, repo.user, { project: 'packages/app/tsconfig.json' }),
            ),
          );
          expect(outcome.report.files.map((d) => [d.file, d.code])).toEqual([
            ['packages/app/src/main.ts', 2322],
          ]);
        },
      );
    });

    it('resolves a dependency from the dependency checkout, reported under node_modules', async () => {
      const repo = await open({
        'tsconfig.json': tsconfig(),
        'src/a.ts': "import { dep } from 'dep';\nexport const a: string = dep;\n",
      });
      repo.install({
        'node_modules/dep/package.json': JSON.stringify({ name: 'dep', types: 'index.d.ts' }),
        'node_modules/dep/index.d.ts':
          'export declare const dep: number;\nexport const broken: = 1;\n',
      });
      await repo.inSlot({}, async (slot) => {
        expect(existsSync(join(slot.path, 'node_modules'))).toBe(false);
        const outcome = checked(await registry.check(await requestFor(slot, repo.user)));
        expect(outcome.report.files.map((d) => [d.file, d.code])).toEqual([
          ['node_modules/dep/index.d.ts', 1110],
        ]);
      });
    });

    it('never reads what the slot holds besides its tree', async () => {
      const repo = await open({ 'tsconfig.json': tsconfig(), 'src/a.ts': 'export const a = 1;\n' });
      await repo.inSlot({}, async (slot) => {
        // As `reset --hard` leaves an earlier tree's untracked output: there
        // on disk, where a compiler reading the directory finds it.
        writeFileSync(join(slot.path, 'src/stale.ts'), 'export const stale: number = "";\n');
        expect(tscDiagnostics(slot.path, 'tsconfig.json').map((d) => d.code)).toEqual([2322]);

        const outcome = checked(await registry.check(await requestFor(slot, repo.user)));
        expect(outcome.report).toMatchObject({ config: [], files: [] });
      });
    });
  });

  describe('this repository as a fixture', () => {
    const checkout = fileURLToPath(new URL('../../..', import.meta.url));
    /** This checkout's committed tree, read through git and never written. */
    const committed = (): Record<string, string> => {
      // What a type check reads: the packages' sources and configuration.
      const listed = execFileSync(
        'git',
        [
          '-C',
          checkout,
          'ls-files',
          '-z',
          '--',
          'tsconfig*.json',
          'packages/**/*.json',
          'packages/**/*.ts',
        ],
        { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 },
      )
        .split('\0')
        .filter((path) => path !== '');
      const files: Record<string, string> = {};
      for (const path of listed) {
        files[path] = execFileSync('git', ['-C', checkout, 'show', `HEAD:${path}`], {
          encoding: 'utf8',
          maxBuffer: 64 * 2 ** 20,
        });
      }
      return files;
    };

    it(
      'checks clean as tsc --build does, and finds an error a merge would add, warm',
      { timeout: 180_000 },
      async () => {
        const files = committed();
        const repo = await open(files);
        const [cold, warm] = await repo.inSlot({ key: 'self' }, async (slot) => {
          const request = await requestFor(slot, checkout);
          return [checked(await registry.check(request)), checked(await registry.check(request))];
        });
        // The same pair again, now merged with an edit to `shared`: the slot
        // is updated by delta and its service is the one that checked it.
        const changed = await repo.inSlot(
          {
            key: 'self',
            one: {
              'packages/shared/src/ids.ts': `${files['packages/shared/src/ids.ts']!}\nexport const broken: number = 'x';\n`,
            },
          },
          async (slot) => checked(await registry.check(await requestFor(slot, checkout))),
        );

        // `pnpm typecheck` runs `tsc --build` over this tree and passes.
        expect(cold.report).toMatchObject({ config: [], files: [] });
        expect(cold.report.projects).toContain('packages/daemon/tsconfig.json');
        expect([cold.warm, warm.warm, changed.warm]).toEqual([false, true, true]);
        expect(warm.report).toEqual(cold.report);
        // Measured at about 1% of the cold check, and 12% once every check
        // rebuilds its programs: a twentieth tells the two apart with room
        // for a loaded machine.
        expect(warm.durationMs).toBeLessThan(cold.durationMs / 20);
        expect(changed.durationMs).toBeLessThan(cold.durationMs);
        expect(changed.report.files.map((d) => [d.file, d.code])).toEqual([
          ['packages/shared/src/ids.ts', 2322],
        ]);
        // Nothing changed is nothing checked and no program built; an edit
        // checks what it affects.
        expect(cold.programsBuilt).toBe(cold.report.projects.length);
        expect(warm.programsBuilt).toBe(0);
        expect(warm.filesChecked).toBe(0);
        expect(changed.filesChecked).toBeGreaterThan(0);
        expect(changed.filesChecked).toBeLessThan(cold.filesChecked);
        expect(cold.heapBytes).toBeGreaterThan(0);
      },
    );
  });

  describe('lifetime', () => {
    const base: Files = { 'tsconfig.json': tsconfig(), 'src/a.ts': 'export const a = 1;\n' };

    it('stops a slot’s service when the pool evicts the slot', async () => {
      const repo = await open(base, {
        size: 1,
        onEvict: (eviction) => registry.release(eviction.path),
      });
      const first = await repo.inSlot({ key: 'first' }, async (slot) => {
        checked(await registry.check(await requestFor(slot, repo.user)));
        return slot.path;
      });
      expect(registry.live).toBe(1);

      const second = await repo.inSlot({ key: 'second' }, async (slot) => {
        // The eviction that made room for this slot stopped the other service.
        expect(registry.live).toBe(0);
        return checked(await registry.check(await requestFor(slot, repo.user)));
      });
      expect(second.warm).toBe(false);
      expect(registry.live).toBe(1);

      // The first pair comes back to a cold service.
      const again = await repo.inSlot({ key: 'first' }, async (slot) => {
        expect(slot.path).toBe(first);
        return checked(await registry.check(await requestFor(slot, repo.user)));
      });
      expect(again.warm).toBe(false);
    });

    it('keeps no more live services than its bound', async () => {
      await registry.close();
      registry = createTypecheckRegistry({ maxServices: 1 });
      const repo = await open(base);
      const one = await repo.inSlot({ key: 'one' }, async (slot) => {
        const request = await requestFor(slot, repo.user);
        checked(await registry.check(request));
        return request;
      });
      await repo.inSlot({ key: 'two' }, async (slot) => {
        checked(await registry.check(await requestFor(slot, repo.user)));
      });
      expect(registry.live).toBe(1);
      const back = checked(await registry.check(one));
      expect(back.warm).toBe(false);
      expect(registry.live).toBe(1);
    });

    it('starts again for a tree checked against other dependencies', async () => {
      const repo = await open(base);
      await repo.inSlot({}, async (slot) => {
        checked(await registry.check(await requestFor(slot, repo.user)));
        const other = checked(await registry.check(await requestFor(slot, slot.path)));
        expect(other.warm).toBe(false);
        expect(registry.live).toBe(1);
      });
    });

    it('refuses checks once closed', async () => {
      const repo = await open(base);
      await registry.close();
      await repo.inSlot({}, async (slot) => {
        expect(await registry.check(await requestFor(slot, repo.user))).toMatchObject({
          kind: 'infra-failure',
          reason: 'closed',
        });
      });
    });

    /** One check by the heap-bound script, in a process started with `nodeOptions`. */
    const boundedCheck = async (
      repo: SlotFixture,
      slot: PoolSlot,
      nodeOptions: string,
    ): Promise<{ outcome: TypecheckOutcome; live: number }> => {
      const listing = join(repo.dataDir, 'listing.json');
      writeFileSync(listing, JSON.stringify(await treeOf(slot)));
      const { stdout } = await promisify(execFile)(
        TSX,
        ['--tsconfig', TSCONFIG, HEAP_BOUND_CHECK, slot.path, repo.user, listing],
        { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: nodeOptions } },
      );
      return JSON.parse(stdout) as { outcome: TypecheckOutcome; live: number };
    };

    /**
     * A check twice past the smallest heap a worker is given, on every Node
     * the suite runs on: the DOM's declarations and 300 modules of typed
     * values, measured at 307 MiB on Node 24 and 268 MiB on Node 26. The
     * DOM's alone, 169 MiB on Node 24, is 116 MiB on Node 26 — under it.
     */
    const large: Files = {
      'tsconfig.json': tsconfig({ lib: ['esnext', 'dom'] }),
      ...Object.fromEntries(
        Array.from({ length: 300 }, (_, i) => [
          `src/f${String(i)}.ts`,
          Array.from({ length: 20 }, (_, j) => {
            const props = Array.from({ length: 10 }, (_, k) => k);
            return [
              `export interface T${String(j)} {`,
              ...props.map((k) => `  p${String(k)}: ${k % 2 === 0 ? 'string' : 'number'};`),
              '}',
              `export const v${String(j)}: T${String(j)} = { ${props
                .map((k) => `p${String(k)}: ${k % 2 === 0 ? `'${String(k)}'` : String(k)}`)
                .join(', ')} };`,
            ].join('\n');
          }).join('\n'),
        ]),
      ),
    };

    it('does not keep a service whose heap has grown past its bound', async () => {
      // The bound checked after a check is the one left when a process-wide
      // `--max-old-space-size` overrides the worker's own limit, so the check
      // runs in a process started with one, ample for any check.
      const repo = await open(large);
      await repo.inSlot({}, async (slot) => {
        const { outcome, live } = await boundedCheck(repo, slot, '--max-old-space-size=4096');
        // The answer stands; the service is not kept to give the next one.
        expect(checked(outcome).report).toMatchObject({ config: [], files: [] });
        expect(checked(outcome).heapBytes).toBeGreaterThan(128 * 2 ** 20);
        expect(live).toBe(0);
      });
    });

    it('ends a program past the worker’s own heap limit as out of memory, naming the limit', async () => {
      const repo = await open(large);
      await repo.inSlot({}, async (slot) => {
        const { outcome, live } = await boundedCheck(repo, slot, '');
        expect(outcome).toEqual({ kind: 'out-of-memory', maxHeapMb: 128 });
        expect(live).toBe(0);
      });
    });

    it('calls a check the compiler threw on a crash, and keeps nothing of its worker', async () => {
      const repo = await open(base);
      // Nested far enough that the parser runs out of stack.
      const deep = `export const deep = ${'['.repeat(100_000)}${']'.repeat(100_000)};\n`;
      await repo.inSlot({ one: { 'src/deep.ts': deep } }, async (slot) => {
        const outcome = await registry.check(await requestFor(slot, repo.user));
        expect(outcome).toMatchObject({ kind: 'crashed' });
        expect(outcome.kind === 'crashed' && outcome.message).toMatch(/call stack/u);
        expect(registry.live).toBe(0);
      });
    });

    it('fails checks in flight and queued as infrastructure when their tree is released', async () => {
      const repo = await open(base);
      await repo.inSlot({}, async (slot) => {
        const request = await requestFor(slot, repo.user);
        const check = registry.check({
          ...request,
          onStarted: () => void registry.release(slot.path),
        });
        const queued = registry.check(request);
        const released = { kind: 'infra-failure', reason: 'released' };
        expect(await check).toMatchObject(released);
        expect(await queued).toMatchObject(released);
        expect(registry.live).toBe(0);
        // Releasing what has no service is nothing.
        await registry.release(slot.path);
      });
    });

    /** A root that is not a path: the worker throws as it starts. */
    const broken: TypecheckRequest = {
      root: undefined as unknown as string,
      dependencyRoot: tmpdir(),
      tree: { oid: 'none', entries: [] },
    };

    it('fails the check as infrastructure when the worker dies, and keeps nothing of it', async () => {
      expect(await registry.check(broken)).toMatchObject({
        kind: 'infra-failure',
        reason: 'no-worker',
      });
      expect(registry.live).toBe(0);
    });

    it('fails a check queued behind a worker that died with why it died', async () => {
      const [first, queued] = await Promise.all([registry.check(broken), registry.check(broken)]);
      expect(queued).toEqual(first);
      expect(queued).toMatchObject({ kind: 'infra-failure', reason: 'no-worker' });
    });

    it('waits for a busy service rather than start one past its bound', async () => {
      await registry.close();
      registry = createTypecheckRegistry({ maxServices: 1 });
      const repo = await open(base);
      const one = await repo.inSlot({ key: 'one' }, (slot) => requestFor(slot, repo.user));
      const two = await repo.inSlot({ key: 'two' }, (slot) => requestFor(slot, repo.user));
      const order: string[] = [];
      let started!: () => void;
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      const first = registry.check({ ...one, onStarted: started }).then(() => order.push('one'));
      await running;
      const second = registry.check(two).then(() => order.push('two'));
      // So does a check of the busy tree against other dependencies.
      const third = registry
        .check({ ...one, dependencyRoot: two.root })
        .then(() => order.push('one again'));
      await Promise.all([first, second, third]);

      expect(order[0]).toBe('one');
      expect(registry.live).toBe(1);
    });

    it('refuses a bound below one service', () => {
      expect(() => createTypecheckRegistry({ maxServices: 0 })).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    });

    it('refuses a heap too small for a worker to start in, before starting one', () => {
      // V8 aborts the whole process, not the worker, for a heap far too small.
      for (const maxHeapMb of [1, 127, 1024.5]) {
        expect(() => createTypecheckRegistry({ maxHeapMb })).toThrow(
          expect.objectContaining({ code: 'CONFIG_INVALID' }),
        );
      }
    });
  });

  describe('deadline', () => {
    const records: LogRecord[] = [];
    const logger = createLogger('test', { level: 'debug', sink: (record) => records.push(record) });
    const startedServices = (): number =>
      records.filter((record) => record.msg === 'type-check service started').length;

    beforeEach(() => {
      records.length = 0;
    });

    it('stops a check at its deadline through the compiler, and keeps its service', async () => {
      await registry.close();
      registry = createTypecheckRegistry({ deadlineMs: 1, graceMs: 60_000 });
      const repo = await open(heavy());
      await repo.inSlot({}, async (slot) => {
        expect(await registry.check(await requestFor(slot, repo.user))).toEqual({
          kind: 'timeout',
          deadlineMs: 1,
        });
        // Stopped within its grace: the worker and what it built are kept.
        expect(registry.live).toBe(1);
      });
    });

    it('calls a check stopped at its deadline a timeout though it is superseded after', async () => {
      await registry.close();
      registry = createTypecheckRegistry({ deadlineMs: 1, graceMs: 60_000 });
      const repo = await open(heavy());
      await repo.inSlot({}, async (slot) => {
        const controller = new AbortController();
        const outcome = await registry.check(
          await requestFor(slot, repo.user, {
            signal: controller.signal,
            onStarted: () => controller.abort(),
          }),
        );
        expect(outcome).toEqual({ kind: 'timeout', deadlineMs: 1 });
      });
    });

    it('terminates a check still running past its grace, and starts the next afresh', async () => {
      await registry.close();
      registry = createTypecheckRegistry({ deadlineMs: 1, graceMs: 0, logger });
      const repo = await open(heavy());
      await repo.inSlot({}, async (slot) => {
        const request = await requestFor(slot, repo.user);
        const [first, queued] = await Promise.all([
          registry.check(request),
          registry.check(request),
        ]);
        expect(first).toEqual({ kind: 'timeout', deadlineMs: 1 });
        // Not the first one's outcome passed on: a service of its own, stopped in turn.
        expect(queued).toEqual({ kind: 'timeout', deadlineMs: 1 });
        expect(startedServices()).toBe(2);
        expect(registry.live).toBe(0);
      });
    });
  });

  describe('cancellation', () => {
    it('does not start a check whose run is already superseded', async () => {
      const controller = new AbortController();
      controller.abort();
      const outcome = await registry.check({
        root: tmpdir(),
        dependencyRoot: tmpdir(),
        tree: { oid: 'none', entries: [] },
        signal: controller.signal,
      });
      expect(outcome).toEqual({ kind: 'cancelled' });
      expect(registry.live).toBe(0);
    });

    it('does not send a queued check whose run was superseded while it waited', async () => {
      const repo = await open({ 'tsconfig.json': tsconfig(), 'src/a.ts': 'export const a = 1;\n' });
      await repo.inSlot({}, async (slot) => {
        const request = await requestFor(slot, repo.user);
        const controller = new AbortController();
        const first = registry.check({ ...request, onStarted: () => controller.abort() });
        const queued = registry.check({
          ...request,
          signal: controller.signal,
          onStarted: () => {
            throw new Error('a superseded check reached the worker');
          },
        });
        expect(checked(await first).warm).toBe(false);
        expect(await queued).toEqual({ kind: 'cancelled' });
      });
    });

    it('stops a check in progress through the compiler, and keeps the service', async () => {
      const repo = await open(heavy());
      await repo.inSlot({}, async (slot) => {
        const request = await requestFor(slot, repo.user);
        const controller = new AbortController();
        const outcome = await registry.check({
          ...request,
          signal: controller.signal,
          onStarted: () => controller.abort(),
        });
        expect(outcome).toEqual({ kind: 'cancelled' });
        expect(registry.live).toBe(1);

        const after = checked(await registry.check(request));
        expect(after.warm).toBe(true);
        expect(after.report).toMatchObject({ config: [], files: [] });
      });
    });
  });

  describe('nothing from the tree executes', () => {
    let outside: string;

    beforeEach(() => {
      outside = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-outside-')));
    });

    afterEach(() => {
      rmSync(outside, { recursive: true, force: true });
    });

    it('never loads a plugin a tsconfig in node_modules introduces through extends', async () => {
      const marker = join(outside, 'plugin-ran');
      const repo = await open({
        'tsconfig.json': JSON.stringify({ extends: 'evil-config/tsconfig.json', include: ['src'] }),
        'src/a.ts': 'export const a: number = "x";\n',
      });
      repo.install({
        'node_modules/evil-config/package.json': JSON.stringify({ name: 'evil-config' }),
        'node_modules/evil-config/tsconfig.json': JSON.stringify({
          compilerOptions: {
            strict: true,
            types: [],
            lib: ['es2022'],
            plugins: [{ name: 'evil-plugin' }],
          },
        }),
        'node_modules/evil-plugin/package.json': JSON.stringify({
          name: 'evil-plugin',
          main: 'index.js',
        }),
        'node_modules/evil-plugin/index.js': `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nmodule.exports = () => ({ create: (info) => info.languageService });\n`,
      });
      await repo.inSlot({}, async (slot) => {
        const outcome = checked(await registry.check(await requestFor(slot, repo.user)));
        // The chain was read — the error comes from its `lib` and `strict`.
        expect(outcome.report.files.map((d) => d.code)).toEqual([2322]);
      });
      expect(existsSync(marker)).toBe(false);
    });
  });

  describe('reads stay confined', () => {
    let outside: string;

    beforeEach(() => {
      outside = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-outside-')));
      mkdirSync(join(outside, 'types', 'leak'), { recursive: true });
      // FIFOs: opening one for reading blocks until a writer comes, so a read
      // of any of them hangs the check, and the test with it.
      for (const name of ['secret.ts', 'paths.ts', 'types/leak/index.d.ts', 'link-target.ts']) {
        execFileSync('mkfifo', [join(outside, name)]);
      }
    });

    afterEach(() => {
      rmSync(outside, { recursive: true, force: true });
    });

    /**
     * Merge `files` into the pair's slot once the slot's place relative to the
     * outside directory is known, as a merge would leave them, and check it.
     */
    const checkWith = async (
      repo: SlotFixture,
      files: (up: string) => Files,
    ): Promise<Extract<TypecheckOutcome, { kind: 'checked' }>> => {
      const place = await repo.inSlot({ key: 'confined' }, (slot) =>
        Promise.resolve(relative(slot.path, outside)),
      );
      return repo.inSlot({ key: 'confined', one: files(place) }, async (slot) =>
        checked(await registry.check(await requestFor(slot, repo.user))),
      );
    };

    it('reads nothing outside the tree that include, files or typeRoots name', async () => {
      const repo = await open({ 'src/a.ts': 'export const a = 1;\n' });
      const outcome = await checkWith(repo, (up) => ({
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            strict: true,
            lib: ['es2022'],
            typeRoots: [join(outside, 'types'), `${up}/types`],
            types: ['leak'],
          },
          include: ['src', `${up}/**/*`, `${outside}/**/*`],
          files: [join(outside, 'secret.ts'), `${up}/paths.ts`],
        }),
      }));
      // What it could not read, it reports as absent: both `files` entries,
      // and the type library only the outside type roots hold.
      expect(outcome.report.config.filter((d) => d.code === 6053)).toHaveLength(2);
      expect(outcome.report.config.map((d) => d.code)).toContain(2688);
      expect(outcome.report.files).toEqual([]);
    });

    it('resolves no module outside the tree that paths names', async () => {
      const repo = await open({ 'src/a.ts': 'export const a = 1;\n' });
      const outcome = await checkWith(repo, (up) => ({
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            strict: true,
            lib: ['es2022'],
            types: [],
            module: 'esnext',
            moduleResolution: 'bundler',
            paths: { leak: [join(outside, 'paths.ts')], near: [`${up}/paths.ts`] },
          },
          include: ['src'],
        }),
        'src/b.ts':
          "import { x } from 'leak';\nimport { y } from 'near';\nexport const b = [x, y];\n",
      }));
      expect(outcome.report.files.map((d) => [d.file, d.code])).toEqual([
        ['src/b.ts', 2307],
        ['src/b.ts', 2307],
      ]);
    });

    it('does not follow a link in the tree out of it', async () => {
      const repo = await open({ 'tsconfig.json': tsconfig(), 'src/a.ts': 'export const a = 1;\n' });
      const outcome = await checkWith(repo, () => ({
        'src/link.ts': { link: join(outside, 'link-target.ts') },
      }));
      expect(outcome.report).toMatchObject({ config: [], files: [] });
    });
  });

  describe('the tree and the install', () => {
    let scratch: string;

    beforeEach(() => {
      scratch = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-install-')));
    });

    afterEach(() => {
      rmSync(scratch, { recursive: true, force: true });
    });

    it('lists a tree’s files and links, and leaves out a submodule’s commit', async () => {
      const git = (...args: string[]): string =>
        execFileSync('git', ['-C', scratch, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
      git('init', '-q', '-b', 'main');
      git('config', 'user.name', 'Interlock Test');
      git('config', 'user.email', 'test@example.invalid');
      mkdirSync(join(scratch, 'src'));
      writeFileSync(join(scratch, 'src/a.ts'), 'export const a = 1;\n');
      symlinkSync('a.ts', join(scratch, 'src/alias.ts'));
      git('add', '-A');
      git('commit', '-qm', 'one');
      const head = git('rev-parse', 'HEAD');
      git('update-index', '--add', '--cacheinfo', `160000,${head},vendor/sub`);
      git('commit', '-qm', 'two');
      const tree = git('rev-parse', 'HEAD^{tree}');

      const repo = { kind: 'user', rootPath: scratch, gitDir: join(scratch, '.git') } as const;
      const listing = await listTree(createGitRunner(), repo, tree);
      expect(listing.oid).toBe(tree);
      expect(listing.entries).toEqual([
        { path: 'src/a.ts', oid: git('rev-parse', 'HEAD:src/a.ts'), symlink: false },
        { path: 'src/alias.ts', oid: git('rev-parse', 'HEAD:src/alias.ts'), symlink: true },
      ]);
      await expect(listTree(createGitRunner(), repo, 'HEAD')).rejects.toThrow();
    });

    it('names an install by its package manager’s records, and none without one', async () => {
      expect(await installIdentity(scratch)).toBeNull();
      mkdirSync(join(scratch, 'node_modules/.pnpm'), { recursive: true });
      writeFileSync(join(scratch, 'node_modules/.modules.yaml'), 'layoutVersion: 5\n');
      const one = await installIdentity(scratch);
      expect(one).toMatch(/^[0-9a-f]{64}$/u);
      expect(await installIdentity(scratch)).toBe(one);
      writeFileSync(join(scratch, 'node_modules/.pnpm/lock.yaml'), 'lockfileVersion: 9\n');
      const two = await installIdentity(scratch);
      expect(two).not.toBe(one);
      writeFileSync(join(scratch, 'node_modules/.pnpm/lock.yaml'), 'lockfileVersion: 10\n');
      expect(await installIdentity(scratch)).not.toBe(two);
    });

    it('reads the records of each install root the tree’s lockfiles name, inside the checkout', async () => {
      mkdirSync(join(scratch, 'platform/node_modules'), { recursive: true });
      writeFileSync(join(scratch, 'platform/node_modules/.modules.yaml'), 'layoutVersion: 5\n');
      // A workspace installed below the root: the root alone finds no install.
      expect(await installIdentity(scratch)).toBeNull();
      const listing = (paths: readonly string[]): TreeListing => ({
        oid: 'tree',
        entries: paths.map((path) => ({ path, oid: '0'.repeat(40), symlink: false })),
      });
      const roots = installRoots(
        listing(['README.md', 'platform/pnpm-lock.yaml', 'platform/node_modules/x/yarn.lock']),
      );
      expect(roots).toEqual(['', 'platform']);
      expect(await installIdentity(scratch, roots)).toMatch(/^[0-9a-f]{64}$/u);

      // A root that leads out of the checkout is none of its installs.
      const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-elsewhere-')));
      try {
        mkdirSync(join(elsewhere, 'node_modules'));
        writeFileSync(join(elsewhere, 'node_modules/.modules.yaml'), 'layoutVersion: 5\n');
        symlinkSync(elsewhere, join(scratch, 'away'));
        expect(await installIdentity(scratch, ['away'])).toBeNull();
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }

      // Too many to read, or a checkout that is gone: versioned by the disk,
      // whatever records the root holds.
      mkdirSync(join(scratch, 'node_modules'));
      writeFileSync(join(scratch, 'node_modules/.modules.yaml'), 'layoutVersion: 5\n');
      expect(await installIdentity(scratch)).not.toBeNull();
      const fixtures = Array.from({ length: 40 }, (_, i) => `fixtures/f${String(i)}/yarn.lock`);
      expect(installRoots(listing(fixtures))).toBeNull();
      expect(await installIdentity(scratch, null)).toBeNull();
      expect(await installIdentity(join(scratch, 'gone'))).toBeNull();
    });

    it('reads no record that is a link, a directory or a pipe', async () => {
      mkdirSync(join(scratch, 'node_modules/.pnpm'), { recursive: true });
      writeFileSync(join(scratch, 'elsewhere.yaml'), 'layoutVersion: 5\n');
      symlinkSync(join(scratch, 'elsewhere.yaml'), join(scratch, 'node_modules/.modules.yaml'));
      mkdirSync(join(scratch, 'node_modules/.package-lock.json'));
      // Opened without waiting for a writer, or this would hang.
      execFileSync('mkfifo', [join(scratch, 'node_modules/.pnpm/lock.yaml')]);
      expect(await installIdentity(scratch)).toBeNull();
    });

    it('discards a check during which the dependency checkout was reinstalled', async () => {
      const repo = await open({ 'tsconfig.json': tsconfig(), 'src/a.ts': 'export const a = 1;\n' });
      repo.install({ 'node_modules/.modules.yaml': 'layoutVersion: 5\n' });
      await repo.inSlot({}, async (slot) => {
        const outcome = await registry.check(
          await requestFor(slot, repo.user, {
            onStarted: () => {
              writeFileSync(join(repo.user, 'node_modules/.modules.yaml'), 'layoutVersion: 6\n');
            },
          }),
        );
        expect(outcome).toMatchObject({ kind: 'infra-failure', reason: 'install-changed' });
        // The service is kept: the next check versions the new install's files anew.
        expect(registry.live).toBe(1);
        checked(await registry.check(await requestFor(slot, repo.user)));
      });
    });
  });
});
