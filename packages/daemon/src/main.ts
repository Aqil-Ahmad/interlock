#!/usr/bin/env node
/**
 * Daemon entry point (`interlockd`).
 *
 * Started by `interlock daemon start`; runnable directly for debugging.
 */
import { createLogger, dataDirFrom, loadConfig, logPath } from '@interlock/shared';
import type { Logger } from '@interlock/shared';
import { createDaemon } from './daemon.js';
import { createFileSink, recordFatal } from './log-file.js';

/**
 * Write the log to the data dir's capped file rather than stderr.
 *
 * Asked for by whoever starts the daemon in the background — `interlock daemon
 * start` and the autostart item — and by nobody running it in a terminal, who
 * wants to watch it.
 */
const LOG_TO_FILE = '--log-to-file';

/** The logger once it writes to the file, for {@link recordFatal}. */
let started: Logger | null = null;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.find((arg) => arg !== LOG_TO_FILE);
  if (unknown !== undefined) throw new Error(`Unknown option: ${unknown}`);
  // The data dir comes from the environment, not the file: the file is in it.
  const config = loadConfig(dataDirFrom(process.env));
  const file = args.includes(LOG_TO_FILE) ? createFileSink(logPath(config.dataDir)) : null;
  const logger = createLogger('daemon', {
    level: config.logLevel,
    ...(file === null ? {} : { sink: file.sink }),
  });
  const daemon = createDaemon({ config, logger });
  if (file !== null) {
    started = logger;
    // In a terminal Node prints these itself, where the person running it is
    // looking. In the background they belong in the log.
    process.on('uncaughtException', (error) => {
      logger.error('uncaught exception', { error: error.stack ?? String(error) });
      process.exit(1);
    });
  }

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
  recordFatal(error, started);
  process.exit(1);
});
