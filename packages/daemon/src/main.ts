#!/usr/bin/env node
/**
 * Daemon entry point (`interlockd`).
 *
 * Started by `interlock daemon start`; runnable directly for debugging.
 */
import { createLogger, resolveConfig } from '@interlock/shared';
import { createDaemon } from './daemon.js';

async function main(): Promise<void> {
  const config = resolveConfig();
  const logger = createLogger('daemon', { level: config.logLevel });
  const daemon = createDaemon({ config, logger });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    // A second signal while the first is draining must not start a second stop
    // or exit out from under the one in progress.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    void daemon.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error('shutdown failed', { error: String(error) });
        process.exit(1);
      },
    );
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await daemon.start();
  // The bound port, not the configured one: `daemon.port` may be `0`.
  logger.info('daemon started', { port: daemon.runtime?.port, pid: process.pid });
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', msg: String(error) })}\n`);
  process.exit(1);
});
