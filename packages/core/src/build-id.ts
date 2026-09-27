import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARED_MODULE_DIR } from '@interlock/shared';

/**
 * The modules a build is made of: compiled JavaScript, or TypeScript run as
 * it stands. Declarations and source maps describe code rather than being it,
 * and tests are not part of what runs.
 */
const MODULE = /\.(?:js|ts)$/u;
const NOT_A_MODULE = /\.(?:d\.ts|test\.ts|test\.js)$/u;

/**
 * An identity for the code under `root`: a digest of every module in it, by
 * path and content.
 *
 * Content rather than a version number, because the version is the same for
 * every build between releases, and those builds are where a classifier gets
 * fixed. A change of any kind — a comment included — is a new identity, which
 * is the conservative direction for anything keyed on it.
 */
export function buildIdOf(root: string): string {
  const digest = createHash('sha256');
  for (const path of modulesUnder(root)) {
    digest.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0');
  }
  return digest.digest('hex').slice(0, 16);
}

function modulesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...modulesUnder(path));
    else if (MODULE.test(entry.name) && !NOT_A_MODULE.test(entry.name)) found.push(path);
  }
  return found.sort();
}

/**
 * {@link buildIdOf} across several directories, each named by its place in
 * the list, so moving code from one to another is a change too.
 */
export function buildIdOfAll(roots: readonly string[]): string {
  const digest = createHash('sha256');
  for (const root of roots) digest.update(buildIdOf(root)).update('\0');
  return digest.digest('hex').slice(0, 16);
}

/** Where the code a verdict depends on is loaded from: this package, and `@interlock/shared`. */
export function analysisModuleDirs(): readonly string[] {
  return [fileURLToPath(new URL('.', import.meta.url)), SHARED_MODULE_DIR];
}

let analysis: string | undefined;

/**
 * The build of the code a cached verdict depends on, read once per process.
 *
 * A textual verdict is the merge, the classifier and the configuration the
 * shadow merges with — all in this package — and the redaction its excerpts
 * went through and the models its Findings are made of, in
 * `@interlock/shared`. A secret pattern added there changes nothing here, and
 * a verdict keyed on this package alone would keep serving excerpts redacted
 * under the old patterns. Keyed on both, as well as on an analyzer's
 * hand-bumped version, a change that forgets the bump still stops old verdicts
 * being served; the cost is one re-verification of every pair per build.
 */
export function analysisBuildId(): string {
  analysis ??= buildIdOfAll(analysisModuleDirs());
  return analysis;
}
