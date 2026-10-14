import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTypecheckRegistry } from '../src/analyzers/typecheck.js';
import type {
  TypecheckOutcome,
  TypecheckRegistry,
  TypecheckReport,
} from '../src/analyzers/typecheck.js';
import type { WorkerRequest } from '../src/analyzers/typecheck-service.js';
import { byPlace, slotFixture, tscDiagnostics } from './support/typecheck-fixtures.js';
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
          const outcome = checked(
            await registry.check({ root: slot.path, dependencyRoot: repo.user }),
          );
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
          const outcome = checked(
            await registry.check({ root: slot.path, dependencyRoot: repo.user }),
          );
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
          const outcome = checked(
            await registry.check({ root: slot.path, dependencyRoot: repo.user }),
          );
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
          const outcome = checked(
            await registry.check({ root: slot.path, dependencyRoot: repo.user }),
          );
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
          const outcome = checked(
            await registry.check({ root: slot.path, dependencyRoot: repo.user }),
          );
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
        const outcome = checked(
          await registry.check({ root: slot.path, dependencyRoot: repo.user }),
        );
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
            await registry.check({
              root: slot.path,
              dependencyRoot: repo.user,
              project: 'packages/app/tsconfig.json',
            }),
          );
          // The user's copy still takes one argument; only the merged one fails.
          expect(outcome.report.files.map((d) => [d.file, d.code])).toEqual([
            ['packages/app/src/main.ts', 2554],
          ]);
          expect(outcome.report.config).toEqual([]);
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
        const outcome = checked(
          await registry.check({ root: slot.path, dependencyRoot: repo.user }),
        );
        expect(outcome.report.files.map((d) => [d.file, d.code])).toEqual([
          ['node_modules/dep/index.d.ts', 1110],
        ]);
      });
    });
  });

  describe('this repository as a fixture', () => {
    const checkout = fileURLToPath(new URL('../../..', import.meta.url));
    /** This checkout's committed tree, read through git and never written. */
    const committed = (): Files => {
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
        const repo = await open(committed());
        const [cold, warm, changed] = await repo.inSlot({}, async (slot) => {
          // Only the first check follows the fill; the rest see the tree as it left it.
          const request = { root: slot.path, dependencyRoot: checkout, fill: 'delta' } as const;
          const first = checked(await registry.check({ ...request, fill: slot.fill }));
          const second = checked(await registry.check(request));
          writeFileSync(
            join(slot.path, 'packages/shared/src/ids.ts'),
            `${execFileSync('git', ['-C', checkout, 'show', 'HEAD:packages/shared/src/ids.ts'], {
              encoding: 'utf8',
            })}\nexport const broken: number = 'x';\n`,
          );
          const third = checked(await registry.check(request));

          return [first, second, third];
        });

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
        checked(await registry.check({ root: slot.path, dependencyRoot: repo.user }));
        return slot.path;
      });
      expect(registry.live).toBe(1);

      const second = await repo.inSlot({ key: 'second' }, async (slot) => {
        // The eviction that made room for this slot stopped the other service.
        expect(registry.live).toBe(0);
        return checked(await registry.check({ root: slot.path, dependencyRoot: repo.user }));
      });
      expect(second.warm).toBe(false);
      expect(registry.live).toBe(1);

      // The first pair comes back to a cold service.
      const again = await repo.inSlot({ key: 'first' }, async (slot) => {
        expect(slot.path).toBe(first);
        return checked(await registry.check({ root: slot.path, dependencyRoot: repo.user }));
      });
      expect(again.warm).toBe(false);
    });

    it('keeps no more live services than its bound', async () => {
      await registry.close();
      registry = createTypecheckRegistry({ maxServices: 1 });
      const repo = await open(base);
      const one = await repo.inSlot({ key: 'one' }, async (slot) => {
        checked(await registry.check({ root: slot.path, dependencyRoot: repo.user }));
        return slot.path;
      });
      await repo.inSlot({ key: 'two' }, async (slot) => {
        checked(await registry.check({ root: slot.path, dependencyRoot: repo.user }));
      });
      expect(registry.live).toBe(1);
      const back = checked(await registry.check({ root: one, dependencyRoot: repo.user }));
      expect(back.warm).toBe(false);
      expect(registry.live).toBe(1);
    });

    it('starts again for a tree checked against other dependencies', async () => {
      const repo = await open(base);
      await repo.inSlot({}, async (slot) => {
        checked(await registry.check({ root: slot.path, dependencyRoot: repo.user }));
        const other = checked(await registry.check({ root: slot.path, dependencyRoot: slot.path }));
        expect(other.warm).toBe(false);
        expect(registry.live).toBe(1);
      });
    });

    it('invalidates every file after a cold fill', async () => {
      const repo = await open(base);
      await repo.inSlot({}, async (slot) => {
        const request = { root: slot.path, dependencyRoot: repo.user };
        checked(await registry.check(request));
        // Rewritten with the same size and times as before: only `cold` says so.
        writeFileSync(join(slot.path, 'src/a.ts'), 'export const a = "";\nconst b = 2;\n');
        const cold = checked(await registry.check({ ...request, fill: 'cold' }));
        expect(cold.warm).toBe(true);
        expect(cold.report.files.map((d) => d.code)).toEqual([6133]);
      });
    });

    it('tells the worker of a cold fill whose own check was cancelled before it was sent', async () => {
      const repo = await open(base);
      await repo.inSlot({}, async (slot) => {
        const request = { root: slot.path, dependencyRoot: repo.user };
        checked(await registry.check(request));
        const superseded = new AbortController();
        superseded.abort();
        expect(
          await registry.check({ ...request, fill: 'cold', signal: superseded.signal }),
        ).toEqual({ kind: 'cancelled' });
        // What reaches the worker, since a rewrite on this file system changes
        // a file's version anyway and the report alone cannot tell.
        const sent = vi.spyOn(Worker.prototype, 'postMessage');
        try {
          checked(await registry.check(request));
          expect(sent.mock.calls.map(([message]) => message as WorkerRequest)).toEqual([
            expect.objectContaining({ type: 'check', cold: true }),
          ]);
          checked(await registry.check(request));
          expect(sent.mock.calls.at(-1)?.[0]).toMatchObject({ cold: false });
        } finally {
          sent.mockRestore();
        }
      });
    });

    it('refuses checks once closed', async () => {
      const repo = await open(base);
      await registry.close();
      await expect(
        registry.check({ root: repo.user, dependencyRoot: repo.user }),
      ).rejects.toMatchObject({ code: 'ANALYZER_INFRA_FAILURE', infra: true });
    });

    it('does not keep a service whose heap has grown past its bound', async () => {
      // The bound checked after a check is the one left when a process-wide
      // `--max-old-space-size` overrides the worker's own limit, so the check
      // runs in a process started with one, ample for any check. Without it,
      // as on a runner with no `NODE_OPTIONS`, the worker's limit holds, and a
      // bound below what any service needs ends the whole test process.
      const repo = await open(base);
      await repo.inSlot({}, async (slot) => {
        const { stdout } = await promisify(execFile)(
          TSX,
          ['--tsconfig', TSCONFIG, HEAP_BOUND_CHECK, slot.path, repo.user],
          {
            encoding: 'utf8',
            env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
          },
        );
        const { outcome, live } = JSON.parse(stdout) as {
          outcome: TypecheckOutcome;
          live: number;
        };
        // The answer stands; the service is not kept to give the next one.
        expect(checked(outcome).report).toMatchObject({ config: [], files: [] });
        expect(live).toBe(0);
      });
    });

    it('fails checks in flight and queued as infrastructure when their tree is released', async () => {
      const repo = await open(base);
      await repo.inSlot({}, async (slot) => {
        const check = registry.check({
          root: slot.path,
          dependencyRoot: repo.user,
          onStarted: () => void registry.release(slot.path),
        });
        const queued = registry.check({ root: slot.path, dependencyRoot: repo.user });
        await expect(check).rejects.toMatchObject({ code: 'ANALYZER_INFRA_FAILURE', infra: true });
        await expect(queued).rejects.toMatchObject({ code: 'ANALYZER_INFRA_FAILURE', infra: true });
        expect(registry.live).toBe(0);
        // Releasing what has no service is nothing.
        await registry.release(slot.path);
      });
    });

    it('fails the check as infrastructure when the worker dies, and keeps nothing of it', async () => {
      // A root that is not a path: the worker throws as it starts.
      await expect(
        registry.check({ root: undefined as unknown as string, dependencyRoot: tmpdir() }),
      ).rejects.toMatchObject({ code: 'ANALYZER_INFRA_FAILURE', infra: true });
      expect(registry.live).toBe(0);
    });

    it('fails a check queued behind a worker that died with why it died', async () => {
      const broken = { root: undefined as unknown as string, dependencyRoot: tmpdir() };
      const [first, queued] = await Promise.allSettled([
        registry.check(broken),
        registry.check(broken),
      ]);
      expect(first.status).toBe('rejected');
      expect(queued.status).toBe('rejected');
      const reason = (settled: PromiseSettledResult<unknown>): unknown =>
        settled.status === 'rejected' ? (settled.reason as Error).message : null;
      expect(reason(queued)).toBe(reason(first));
      expect(reason(queued)).not.toMatch(/released/u);
    });

    it('waits for a busy service rather than start one past its bound', async () => {
      await registry.close();
      registry = createTypecheckRegistry({ maxServices: 1 });
      const repo = await open(base);
      const one = await repo.inSlot({ key: 'one' }, (slot) => Promise.resolve(slot.path));
      const two = await repo.inSlot({ key: 'two' }, (slot) => Promise.resolve(slot.path));
      const order: string[] = [];
      let started!: () => void;
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      const first = registry
        .check({ root: one, dependencyRoot: repo.user, onStarted: started })
        .then(() => order.push('one'));
      await running;
      const second = registry
        .check({ root: two, dependencyRoot: repo.user })
        .then(() => order.push('two'));
      // So does a check of the busy tree against other dependencies.
      const third = registry
        .check({ root: one, dependencyRoot: two })
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
  });

  describe('cancellation', () => {
    it('does not start a check whose run is already superseded', async () => {
      const controller = new AbortController();
      controller.abort();
      const outcome = await registry.check({
        root: tmpdir(),
        dependencyRoot: tmpdir(),
        signal: controller.signal,
      });
      expect(outcome).toEqual({ kind: 'cancelled' });
      expect(registry.live).toBe(0);
    });

    it('does not send a queued check whose run was superseded while it waited', async () => {
      const repo = await open({ 'tsconfig.json': tsconfig(), 'src/a.ts': 'export const a = 1;\n' });
      await repo.inSlot({}, async (slot) => {
        const controller = new AbortController();
        const first = registry.check({
          root: slot.path,
          dependencyRoot: repo.user,
          onStarted: () => controller.abort(),
        });
        const queued = registry.check({
          root: slot.path,
          dependencyRoot: repo.user,
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
      const files: Record<string, string> = { 'tsconfig.json': tsconfig() };
      // Enough code that the checker polls the token many times over.
      for (let i = 0; i < 200; i++) {
        files[`src/f${String(i)}.ts`] = Array.from(
          { length: 40 },
          (_, j) => `export const v${String(j)}: Record<string, number[]> = { a: [${String(j)}] };`,
        ).join('\n');
      }
      const repo = await open(files);
      await repo.inSlot({}, async (slot) => {
        const controller = new AbortController();
        const outcome = await registry.check({
          root: slot.path,
          dependencyRoot: repo.user,
          signal: controller.signal,
          onStarted: () => controller.abort(),
        });
        expect(outcome).toEqual({ kind: 'cancelled' });
        expect(registry.live).toBe(1);

        const after = checked(await registry.check({ root: slot.path, dependencyRoot: repo.user }));
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
        const outcome = checked(
          await registry.check({ root: slot.path, dependencyRoot: repo.user }),
        );
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

    it('reads nothing outside the tree that include, files or typeRoots name', async () => {
      const repo = await open({ 'src/a.ts': 'export const a = 1;\n' });
      await repo.inSlot({}, async (slot) => {
        // Written into the slot as a merge would leave it, once the slot's
        // place relative to the outside directory is known.
        const up = relative(slot.path, outside);
        writeFileSync(
          join(slot.path, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: {
              strict: true,
              lib: ['es2022'],
              typeRoots: [join(outside, 'types'), `${up}/types`],
              types: ['leak'],
            },
            include: ['src', `${up}/**/*`, `${outside}/**/*`],
            files: [join(outside, 'secret.ts'), `${up}/paths.ts`],
          }),
        );
        const outcome = checked(
          await registry.check({ root: slot.path, dependencyRoot: repo.user }),
        );
        // What it could not read, it reports as absent: both `files` entries,
        // and the type library only the outside type roots hold.
        expect(outcome.report.config.filter((d) => d.code === 6053)).toHaveLength(2);
        expect(outcome.report.config.map((d) => d.code)).toContain(2688);
        expect(outcome.report.files).toEqual([]);
      });
    });

    it('resolves no module outside the tree that paths names', async () => {
      const repo = await open({ 'src/a.ts': 'export const a = 1;\n' });
      await repo.inSlot({}, async (slot) => {
        const up = relative(slot.path, outside);
        writeFileSync(
          join(slot.path, 'tsconfig.json'),
          JSON.stringify({
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
        );
        writeFileSync(
          join(slot.path, 'src/b.ts'),
          "import { x } from 'leak';\nimport { y } from 'near';\nexport const b = [x, y];\n",
        );
        const outcome = checked(
          await registry.check({ root: slot.path, dependencyRoot: repo.user }),
        );
        expect(outcome.report.files.map((d) => [d.file, d.code])).toEqual([
          ['src/b.ts', 2307],
          ['src/b.ts', 2307],
        ]);
      });
    });

    it('does not follow a link in the tree out of it', async () => {
      const repo = await open({ 'tsconfig.json': tsconfig(), 'src/a.ts': 'export const a = 1;\n' });
      await repo.inSlot({}, async (slot) => {
        execFileSync('ln', ['-s', join(outside, 'link-target.ts'), join(slot.path, 'src/link.ts')]);
        const outcome = checked(
          await registry.check({ root: slot.path, dependencyRoot: repo.user }),
        );
        expect(outcome.report).toMatchObject({ config: [], files: [] });
      });
    });
  });
});
