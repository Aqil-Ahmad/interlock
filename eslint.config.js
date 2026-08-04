// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint config.
 *
 * Beyond style, this encodes two architectural invariants:
 *   1. layering — `shared` depends on nothing; `core` never imports runtime packages;
 *   2. no `any` in the public surface of `shared` or `core`.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'eval/reports/**',
      'eval/agenticflict/data/**',
      // Outside the workspace and the build until it declares react/vite.
      'packages/dashboard/**',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Every linted file belongs to a real project: package sources to their
        // own tsconfig, and tests, scripts and the eval harness to
        // tsconfig.check.json. Without that last one they fall back to an
        // inferred project with no `@types/node`, and every `process` reference
        // lints as an error.
        project: [
          './packages/{shared,core,daemon,mcp-server,cli}/tsconfig.json',
          './tsconfig.check.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // --- Layering: shared is the leaf. It must not depend on any sibling. ---
  {
    files: ['packages/shared/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@interlock/*'],
              message:
                'packages/shared is the dependency leaf: it must not import any other Interlock package.',
            },
          ],
        },
      ],
    },
  },

  // --- Layering: core is pure domain logic; no long-running processes. ---
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@interlock/daemon',
                '@interlock/cli',
                '@interlock/mcp-server',
                '@interlock/dashboard',
              ],
              message:
                'packages/core must not depend on runtime packages. Invert the dependency: pass what you need in.',
            },
          ],
        },
      ],
    },
  },

  // Tests and scripts get a longer leash.
  {
    files: ['**/*.test.ts', '**/test/**/*.ts', 'scripts/**/*.ts', 'eval/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },

  // Config files are not part of any tsconfig project.
  {
    files: ['*.config.{js,ts}', '**/*.config.{js,ts}'],
    ...tseslint.configs.disableTypeChecked,
  },

  prettier,
);
