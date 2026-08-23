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
       * A floor against regression, not a target. Set just under what the tree
       * measures so ordinary work never trips it, and raised when a milestone
       * lands rather than lowered when a change misses.
       *
       * No `functions` floor. A declared-but-unwritten function throws
       * `notImplemented` and is never called, and that pattern is required
       * here — nineteen of the thirty-nine uncovered functions are stubs, so
       * the number tracks how much of the plan is unbuilt rather than how well
       * the built code is tested, and following the rule would walk it into the
       * floor. The three below move together with real code: a stub file
       * contributes one statement, an untested real module contributes many.
       */
      thresholds: {
        statements: 82,
        branches: 82,
        lines: 85,
      },
    },
  },
});
