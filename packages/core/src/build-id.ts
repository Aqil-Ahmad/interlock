import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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

let core: string | undefined;

/**
 * This package's own {@link buildIdOf}, read once per process.
 *
 * A cached verdict depends on the merge, the classifier and the configuration
 * the shadow merges with — all of it here — as well as on git. Keyed on this
 * as well as on an analyzer's hand-bumped version, a change that forgets the
 * bump still stops old verdicts being served; the cost is one re-verification
 * of every pair per build.
 */
export function coreBuildId(): string {
  core ??= buildIdOf(fileURLToPath(new URL('.', import.meta.url)));
  return core;
}
