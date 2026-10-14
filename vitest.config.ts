import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Single root test runner for the whole monorepo.
 *
 * Layers:
 *  - unit        — `*.test.ts` next to the source it covers; pure logic, no I/O
 *  - integration — files under a package's `test/` dir; real git repos in temp dirs
 *  - e2e         — `packages/cli/test/e2e`; daemon + CLI driven together
 */

const src = (pkg: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

/**
 * Resolve workspace packages to source rather than `dist`.
 *
 * Their `exports` maps point at built output, so without this a test run needs a
 * prior `pnpm build` and silently measures coverage against stale artifacts.
 * Mirrors the `paths` in tsconfig.check.json.
 */
const alias = {
  '@interlock/shared': src('shared'),
  '@interlock/core': src('core'),
  '@interlock/daemon': src('daemon'),
  '@interlock/mcp-server': src('mcp-server'),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'packages/{shared,core,daemon,mcp-server,cli}/src/**/*.test.ts',
            'packages/{shared,core,daemon,mcp-server,cli}/test/**/*.test.ts',
            // Outside the workspace, so nothing else would notice the runner or
            // the scorer breaking until a report was due.
            'eval/**/*.test.ts',
          ],
          // Integration tests spin up real git repos; give them room.
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      // The dashboard is outside the workspace, so nothing installs, builds or
      // tests it. Counting it puts a package the pipeline never touches into
      // the denominator, where every file added to it walks the floor down.
      exclude: ['**/*.test.ts', '**/index.ts', '**/*.d.ts', 'packages/dashboard/**'],
      /**
       * Floors against regression, not targets. Raised when a milestone lands,
       * never lowered when a change misses.
       *
       * The global floor alone let one package decay while the others carried
       * the average, so each package also has its own, set at its measured
       * coverage rounded down to a whole percent.
       *
       * No global `functions` floor. A declared-but-unwritten function throws
       * `notImplemented` and is never called, so wherever stubs are counted the
       * number tracks how much of the plan is unbuilt rather than how well the
       * built code is tested. A package gets a `functions` floor once stubs no
       * longer make up its uncovered functions; the unwritten CLI commands sit
       * in an `index.ts`, which is excluded above, so they do not count.
       */
      thresholds: {
        statements: 82,
        branches: 82,
        lines: 85,
        'packages/shared/src/**': { statements: 96, branches: 92, lines: 97, functions: 94 },
        'packages/core/src/**': { statements: 98, branches: 94, lines: 99, functions: 98 },
        'packages/daemon/src/**': { statements: 95, branches: 89, lines: 96, functions: 96 },
        'packages/cli/src/**': { statements: 89, branches: 84, lines: 90, functions: 79 },
        // No `functions` floor: every tool is still a stub, so the number would
        // follow the tools being written rather than tested.
        'packages/mcp-server/src/**': { statements: 100, branches: 100, lines: 100 },
      },
    },
  },
});
