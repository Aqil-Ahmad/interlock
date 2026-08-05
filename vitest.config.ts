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
        extends: false,
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
      exclude: ['**/*.test.ts', '**/index.ts', '**/*.d.ts'],
    },
  },
});
