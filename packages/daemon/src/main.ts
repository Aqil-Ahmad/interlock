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

  const shutdown = (signal: string): void => {
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
  logger.info('daemon started', { port: config.daemon.port, pid: process.pid });
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', msg: String(error) })}\n`);
  process.exit(1);
});
