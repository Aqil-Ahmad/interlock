import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as WorkerThreads from 'node:worker_threads';
import type { WorkerOptions } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTypecheckRegistry } from '../src/analyzers/typecheck.js';

/**
 * What a type-check worker is started with. Recorded on the way into the real
 * `Worker`, which still starts and checks: the options are the thing under
 * test, and nothing inside a worker can report the environment it was not given.
 */

const started = vi.hoisted((): WorkerOptions[] => []);

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerThreads>();
  class Recorded extends actual.Worker {
    constructor(url: string | URL, options: WorkerOptions = {}) {
      started.push(options);
      super(url, options);
    }
  }
  return { ...actual, Worker: Recorded };
});

describe('type-check workers', () => {
  let root: string;

  beforeEach(() => {
    started.length = 0;
    root = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-worker-options-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('start with no environment and the configured heap limit', async () => {
    const registry = createTypecheckRegistry({ maxHeapMb: 512 });
    try {
      const outcome = await registry.check({
        root,
        dependencyRoot: root,
        tree: { oid: 'empty', entries: [] },
      });
      expect(outcome.kind).toBe('checked');
    } finally {
      await registry.close();
    }
    expect(started).toHaveLength(1);
    expect(started[0]!.env).toEqual({});
    expect(started[0]!.resourceLimits).toEqual({ maxOldGenerationSizeMb: 512 });
  });
});
