import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';

/**
 * A watch the kernel accepted and that never reports anything: the filesystem
 * signal taken away entirely, so whatever still arrives came by another route.
 */
export function silentWatch(): FSWatcher {
  const handle = Object.assign(new EventEmitter(), {
    close: (): void => undefined,
    ref: () => handle,
    unref: () => handle,
  });
  return handle;
}
