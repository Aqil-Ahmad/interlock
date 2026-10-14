#!/usr/bin/env node
/**
 * Daemon entry point (`interlockd`).
 *
 * Started by `interlock daemon start`; runnable directly for debugging.
 */
import {
  createLogger,
  dataDirFrom,
  isInterlockError,
  loadConfig,
  logPath,
} from '@interlock/shared';
import { createDaemon } from './daemon.js';
import { createFileSink } from './log-file.js';

/**
 * Write the log to the data dir's capped file rather than stderr.
 *
 * Asked for by whoever starts the daemon in the background — `interlock daemon
 * start` and the autostart item — and by nobody running it in a terminal, who
 * wants to watch it.
 */
const LOG_TO_FILE = '--log-to-file';

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
  // The logger may not exist yet — its level comes from the config, and the
  // config is the likeliest thing to have failed. Same shape as a log record,
  // with the code and the remedy carried rather than flattened into the
  // message: the remedy is the part a person can act on.
  const record = isInterlockError(error)
    ? { level: 'error', msg: error.message, code: error.code, remedy: error.remedy }
    : { level: 'error', msg: error instanceof Error ? error.message : String(error) };
  process.stderr.write(`${JSON.stringify(record)}\n`);
  process.exit(1);
});
