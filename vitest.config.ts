import { defineConfig } from 'vitest/config';

/**
 * Single root test runner for the whole monorepo.
 *
 * Layers:
 *  - unit        — `*.test.ts` next to the source it covers; pure logic, no I/O
 *  - integration — files under a package's `test/` dir; real git repos in temp dirs
 *  - e2e         — `packages/cli/test/e2e`; daemon + CLI driven together
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
      // No threshold while most of `core` is declared but unwritten: a gate
      // would measure how much surface exists, not how well it is tested.
    },
  },
});
