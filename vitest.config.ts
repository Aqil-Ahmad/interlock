import { defineConfig } from 'vitest/config';

/**
 * Single root test runner for the whole monorepo.
 *
 * Layers:
 *  - unit        — `*.test.ts` next to the source it covers; pure logic, no I/O
 *  - integration — files under a package's `test/` dir; real git repos in temp dirs
 *  - e2e         — `packages/cli/test/e2e`; daemon + CLI driven together
 *
 * `packages/dashboard` is out of the workspace until M6 and so is not a project
 * here; add it back alongside its jsdom/testing-library dependencies.
 */
export default defineConfig({
  test: {
    projects: [
      {
        extends: false,
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
      exclude: ['**/*.test.ts', '**/index.ts', '**/*.d.ts'],
      // No threshold yet: most of `core` is still declared-but-unwritten, so a
      // gate here would measure how much surface exists rather than how well it
      // is tested. Turn on `packages/core/src/**` at 80% once the textual
      // analyzer lands end-to-end (M2), then raise it, never lower it.
    },
  },
});
