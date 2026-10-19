import { readFileSync } from 'node:fs';
import { createTypecheckRegistry } from '../../src/analyzers/typecheck.js';
import type { TreeListing } from '../../src/analyzers/typecheck.js';

/**
 * One check of the tree named on the command line, against the dependency
 * checkout named after it and the listing in the file named last, by a
 * registry at the smallest heap limit it accepts, printed as JSON.
 *
 * A process of its own because what it exercises depends on flags fixed when
 * a process starts. Started with a process-wide `--max-old-space-size`, the
 * worker's own limit is overridden, and only the bound checked after a check
 * stops the service. Started with none, the worker's limit holds, and a
 * program past it ends the worker alone.
 */
const [root, dependencyRoot, listing] = process.argv.slice(2);
if (root === undefined || dependencyRoot === undefined || listing === undefined) {
  throw new Error('usage: heap-bound-check <tree> <dependency root> <listing file>');
}
const tree = JSON.parse(readFileSync(listing, 'utf8')) as TreeListing;

const registry = createTypecheckRegistry({ maxHeapMb: 128 });
try {
  const outcome = await registry.check({ root, dependencyRoot, tree });
  process.stdout.write(JSON.stringify({ outcome, live: registry.live }));
} finally {
  await registry.close();
}
