import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { GitRunner } from '@interlock/core';
import { InterlockError, isInterlockError } from '@interlock/shared';
import type { Logger } from '@interlock/shared';
import { DATA_DIR_LOCK_FILENAME, holdDataDir, refuseDataDirInRepos } from './data-dir.js';

/**
 * The kill switch: delete everything Interlock stored, and nothing else.
 *
 * A deletion bug here is unrecoverable, so the order is refuse, then hold,
 * then delete. Every refusal is decided before the first unlink, from the
 * directory as it stands, and the walk itself never leaves it: links are
 * removed rather than followed, and a directory on another device is a
 * refusal rather than something to descend into. A shadow borrows its
 * repository's objects through an `alternates` file and a pool slot names its
 * git dir in a `.git` file; both are text, and deleting them deletes the text.
 */

export interface PurgeOptions {
  /**
   * The watched repositories, from the config the daemon reads.
   *
   * Asked for only once the directory has passed every other check: a config
   * that does not load is a refusal, and in a directory that is not
   * Interlock's it would be refused for the wrong reason.
   */
  readonly repos: () => readonly string[];
  /** Defaults to the real one. */
  readonly runner?: GitRunner;
  /** The user's home directory, which is never a data dir however it is named. */
  readonly home: string;
  readonly logger: Logger;
}

/** What a purge found, or would find. */
export interface PurgeReport {
  /** The directory as resolved, which is what was deleted. */
  readonly dataDir: string;
  /** False when there was nothing to delete. */
  readonly existed: boolean;
  /** Disk the directory occupied: allocated blocks, not apparent sizes. */
  readonly bytes: number;
}

/**
 * What Interlock writes at the top of its data dir, and nothing else.
 *
 * A directory holding anything outside this list is not one Interlock made —
 * most likely `INTERLOCK_DATA_DIR` pointed somewhere shared — and purging it
 * would delete someone's files along with the lock. Kept as a list rather
 * than read off each writer, because the purge suite runs a real daemon with a
 * real shadow and pool and purges what it left, which fails the day a writer
 * adds a name this list lacks.
 */
const KNOWN_ENTRIES: ReadonlySet<string> = new Set([
  DATA_DIR_LOCK_FILENAME,
  'interlock.db',
  // SQLite's own, beside the database while it is open or after a crash.
  'interlock.db-wal',
  'interlock.db-shm',
  'interlock.db-journal',
  'token',
  'daemon.json',
  'daemon.log',
  'daemon.log.1',
  'config.json',
  'shadows',
  'worktrees',
]);

/** Staging files a crash can leave: the runtime file's by pid, the token's by random suffix. */
const KNOWN_STAGING = [/^daemon\.json\.\d+\.tmp$/u, /^token\.[0-9a-f]+\.tmp$/u];

/** Entries that must be directories when present, or the walk would treat a file as a tree. */
const KNOWN_DIRECTORIES: ReadonlySet<string> = new Set(['shadows', 'worktrees']);

function refused(
  dataDir: string,
  message: string,
  remedy: string,
  details: Record<string, unknown> = {},
): InterlockError {
  return new InterlockError('PURGE_REFUSED', message, {
    details: { dataDir, ...details },
    remedy,
  });
}

/** Whether `inner` is `outer` or sits below it, on whole path segments. */
function within(inner: string, outer: string): boolean {
  const path = relative(outer, inner);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/**
 * Decide whether `dataDir` may be purged, and measure it.
 *
 * Nothing is written or deleted. Answers `existed: false` for a directory that
 * is not there, which is a purge with nothing to do rather than a refusal.
 *
 * @throws InterlockError `PURGE_REFUSED` naming why, before anything is touched.
 */
export async function inspectPurge(dataDir: string, options: PurgeOptions): Promise<PurgeReport> {
  if (!isAbsolute(dataDir)) {
    throw refused(
      dataDir,
      'The data directory is not an absolute path',
      'Set INTERLOCK_DATA_DIR to a full path.',
    );
  }

  let stats: Stats;
  try {
    stats = lstatSync(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { dataDir, existed: false, bytes: 0 };
    }
    throw error;
  }
  // Refused rather than resolved: deleting through a link deletes wherever it
  // points, and the link itself would be left behind naming nothing.
  if (stats.isSymbolicLink()) {
    throw refused(
      dataDir,
      'The data directory is a symbolic link',
      'Point INTERLOCK_DATA_DIR at the directory the link names, and purge that.',
    );
  }
  if (!stats.isDirectory()) {
    throw refused(
      dataDir,
      'The data directory is not a directory',
      'Pass the directory the daemon keeps its state in.',
    );
  }

  // Resolved, so `/`, the home directory or a repository reached through a
  // symlinked parent is recognised under any of its names.
  const real = realpathSync(dataDir);
  const home = realpathSync(options.home);
  if (dirname(real) === real || within(home, real)) {
    throw refused(
      real,
      'The data directory is the root, the home directory, or above it',
      'Set INTERLOCK_DATA_DIR to the directory Interlock keeps its own state in, such as ~/.interlock.',
    );
  }

  const entries = readdirSync(real);
  const lock = entries.includes(DATA_DIR_LOCK_FILENAME)
    ? lstatSync(join(real, DATA_DIR_LOCK_FILENAME))
    : null;
  // Written on every start, so a directory without it has never had a daemon
  // run in it, whatever else it holds.
  if (!lock?.isFile()) {
    throw refused(
      real,
      'The data directory does not look like Interlock’s',
      `${real} has no ${DATA_DIR_LOCK_FILENAME}, which every daemon writes when it starts. Check INTERLOCK_DATA_DIR.`,
    );
  }
  const foreign = entries.filter(
    (name) => !KNOWN_ENTRIES.has(name) && !KNOWN_STAGING.some((pattern) => pattern.test(name)),
  );
  if (foreign.length > 0) {
    throw refused(
      real,
      'The data directory holds files Interlock did not write',
      `Move ${foreign.map((name) => JSON.stringify(name)).join(', ')} out of ${real}, or check INTERLOCK_DATA_DIR.`,
      { foreign },
    );
  }
  for (const name of entries) {
    if (KNOWN_DIRECTORIES.has(name) && !lstatSync(join(real, name)).isDirectory()) {
      throw refused(
        real,
        'The data directory does not look like Interlock’s',
        `${join(real, name)} is not a directory. Check INTERLOCK_DATA_DIR.`,
      );
    }
  }

  let repos: readonly string[];
  try {
    repos = options.repos();
  } catch (error) {
    // Without the list there is no telling whether this is inside one.
    throw new InterlockError('PURGE_REFUSED', 'The watched repositories could not be read', {
      cause: error,
      details: { dataDir: real },
      remedy: `Fix or remove ${join(real, 'config.json')}, then purge again.${isInterlockError(error) && error.remedy !== undefined ? ` ${error.remedy}` : ''}`,
    });
  }
  try {
    await refuseDataDirInRepos(real, repos, options.runner);
  } catch (error) {
    if (!isInterlockError(error) || error.code !== 'CONFIG_INVALID') throw error;
    const repo =
      typeof error.details.repo === 'string' ? error.details.repo : 'a watched repository';
    // Interlock refuses to start in such a directory, so it did not make it;
    // whatever is there belongs with the repository.
    throw refused(
      real,
      'The data directory is inside a watched repository',
      `Interlock does not purge a directory inside ${repo}. Remove it by hand if it is yours to remove.`,
      { repo },
    );
  }

  return { dataDir: real, existed: true, bytes: walk(real, stats.dev, false) };
}

/**
 * Purge the data dir: refuse, hold, delete, release.
 *
 * The hold is taken after the refusals and kept until the directory is gone,
 * so a daemon starting mid-purge is turned away rather than writing into a
 * tree being deleted under it — and one still running makes this throw before
 * anything is removed. The lock file goes last, unlinked while still held.
 *
 * @throws InterlockError `PURGE_REFUSED` before anything is deleted, or
 *         `CONFIG_INVALID` when a daemon holds the directory.
 */
export async function purgeDataDir(dataDir: string, options: PurgeOptions): Promise<PurgeReport> {
  const report = await inspectPurge(dataDir, options);
  if (!report.existed) return report;
  const real = report.dataDir;
  const device = lstatSync(real).dev;

  const hold = holdDataDir(real, options.logger);
  let bytes = 0;
  try {
    for (const name of readdirSync(real)) {
      if (name === DATA_DIR_LOCK_FILENAME) continue;
      bytes += walk(join(real, name), device, true);
    }
    bytes += walk(join(real, DATA_DIR_LOCK_FILENAME), device, true);
    bytes += blocks(lstatSync(real));
    rmdirSync(real);
  } finally {
    hold.release();
  }
  options.logger.info('purged the data directory', { dataDir: real, bytes });
  return { dataDir: real, existed: true, bytes };
}

/** Allocated bytes where the platform reports blocks, the length where it does not. */
function blocks(stats: Stats): number {
  return Number.isFinite(stats.blocks) ? stats.blocks * 512 : stats.size;
}

/**
 * Measure, and with `remove` delete, one entry and everything under it.
 *
 * `lstat`, never `stat`: a symbolic link is an entry of its own, removed as
 * one, whatever it names. A directory on another device is a mount someone
 * made inside the data dir, and nothing Interlock wrote.
 */
function walk(path: string, device: number, remove: boolean): number {
  const stats = lstatSync(path);
  if (!stats.isDirectory()) {
    if (remove) unlinkSync(path);
    return blocks(stats);
  }
  if (stats.dev !== device) {
    throw new InterlockError(
      'PURGE_REFUSED',
      'The data directory has another file system mounted inside it',
      {
        details: { path },
        remedy: `Unmount ${path} and purge again.`,
      },
    );
  }
  let total = blocks(stats);
  for (const name of readdirSync(path)) total += walk(join(path, name), device, remove);
  if (remove) rmdirSync(path);
  return total;
}
