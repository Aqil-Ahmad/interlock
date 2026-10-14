import { parentPort, workerData } from 'node:worker_threads';
import type * as Service from './typecheck-service.js';
import type { Port, WorkerInit } from './typecheck-service.js';

/**
 * Entry point of a type-check worker thread: one service, one tree.
 *
 * The service is imported by a URL built from this file's own, so that the
 * worker started from `src` under test loads `src`, and the one started from
 * `dist` loads `dist`; a static import of `./typecheck-service.js` would name a
 * file `src` does not have.
 */
const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const service = (await import(
  new URL(`./typecheck-service.${extension}`, import.meta.url).href
)) as typeof Service;
service.serveTypecheck(parentPort as unknown as Port, workerData as WorkerInit);
