import { createTypecheckRegistry } from '../../src/analyzers/typecheck.js';

/**
 * One check of the tree named on the command line, against the dependency
 * checkout named after it, by a registry whose heap bound is below what any
 * service needs, printed as JSON.
 *
 * A process of its own because the bound it exercises is the one enforced
 * after a check, which only matters once a process-wide
 * `--max-old-space-size` has overridden the worker's own limit; that flag is
 * fixed when a process starts. Without it the worker's limit holds, and V8
 * ends the whole process rather than the worker when an isolate cannot even
 * deserialize its snapshot under it.
 */
const [root, dependencyRoot] = process.argv.slice(2);
if (root === undefined || dependencyRoot === undefined) {
  throw new Error('usage: heap-bound-check <tree> <dependency root>');
}

const registry = createTypecheckRegistry({ maxHeapMb: 1 });
try {
  const outcome = await registry.check({ root, dependencyRoot });
  process.stdout.write(JSON.stringify({ outcome, live: registry.live }));
} finally {
  await registry.close();
}
