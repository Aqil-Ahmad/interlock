import { createRequire } from 'node:module';

/**
 * What the type-check registry needs of the service's module without loading
 * it: the service imports `typescript`, which only its worker should load, so
 * that importing `@interlock/core` does not load the compiler.
 *
 * The service cannot import this in turn — its worker loads it by path, and
 * type stripping cannot follow a `.js` specifier back to a `.ts` file — so it
 * keeps its own default project, which a test holds to this one.
 */

/** The project a check reads when its request names none. */
export const DEFAULT_PROJECT = 'tsconfig.json';

/**
 * A module beside `base` by name: `.ts` when `base` is run from source, as
 * under test, and `.js` once built. A worker is started by path, and type
 * stripping cannot follow a `.js` specifier back to a `.ts` file.
 */
export function siblingModule(base: string, name: string): URL {
  return new URL(`./${name}.${base.endsWith('.ts') ? 'ts' : 'js'}`, base);
}

/**
 * The version of Interlock's own compiler, read from its manifest rather than
 * the module, so that asking costs no compiler load. A report is only as good
 * as the compiler that produced it, so anything cached on one is keyed on this.
 */
export const TYPESCRIPT_VERSION: string = (
  createRequire(import.meta.url)('typescript/package.json') as { readonly version: string }
).version;
