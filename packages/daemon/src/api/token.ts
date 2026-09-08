import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { InterlockError, tokenPath } from '@interlock/shared';
import type { Logger } from '@interlock/shared';
import { ensureDataDir } from '../data-dir.js';

/**
 * The bearer token guarding the localhost API.
 *
 * Any process running as this user can reach a loopback port, so the token is
 * the boundary rather than the bind — the bind only keeps the rest of the
 * network out. That makes the file's mode part of the boundary too.
 *
 * It is minted once and kept across restarts: agents and the MCP server are
 * configured with it, and a token that rotated on every start would break every
 * configured client for no gain.
 */

/**
 * 256 bits, base64url so it survives a header, an environment variable and a
 * JSON config without escaping.
 */
const TOKEN_BYTES = 32;

/** Owner-only. Anything wider means another local user could have read it. */
const TOKEN_FILE_MODE = 0o600;

/**
 * Flags for reading the token back.
 *
 * `O_NOFOLLOW` because everything after the open acts on what was opened: a
 * symlink here would have the mode check tighten, and the read read, whatever
 * it pointed at. `O_NONBLOCK` because opening a fifo without it waits for a
 * writer, which wedges the daemon before any check runs. Both are security
 * decisions and `O_RDONLY | undefined` is a plain following read, so a platform
 * without them is refused rather than quietly served.
 */
const OPEN_TOKEN = ((): number => {
  const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = constants;
  if (O_NOFOLLOW === undefined || O_NONBLOCK === undefined) {
    throw new InterlockError(
      'CONFIG_INVALID',
      'This platform does not support opening a file without following symlinks',
      { remedy: 'Run Interlock on Linux or macOS.', infra: true },
    );
  }
  return O_RDONLY | O_NONBLOCK | O_NOFOLLOW;
})();

/**
 * Read the token, minting one on first start.
 *
 * The file is opened exclusively, so two daemons racing at first start cannot
 * each mint one and disagree about which is valid — the loser reads what the
 * winner wrote.
 *
 * @throws InterlockError `CONFIG_INVALID` when the file exists but holds
 *         nothing a daemon wrote; see {@link read}.
 */
export function ensureToken(dataDir: string, logger: Logger): string {
  const path = tokenPath(dataDir);
  ensureDataDir(dirname(path), logger);

  const minted = mint(path);
  return minted ?? read(path, logger);
}

/**
 * Read back a token an earlier start minted, tightening its mode on the way.
 *
 * Every step acts on one descriptor rather than on the path again: checking the
 * mode of one file and then changing the mode of whatever the name refers to a
 * moment later is two different files if anything moved in between.
 *
 * @throws InterlockError `CONFIG_INVALID` for a file no daemon wrote — a
 *         symlink, or one holding nothing. Guessing past either silently
 *         decides what the API authenticates against.
 */
function read(path: string, logger: Logger): string {
  let handle: number;
  try {
    handle = openSync(path, OPEN_TOKEN);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? null;
    throw new InterlockError(
      'CONFIG_INVALID',
      code === 'ELOOP' ? 'The API token file is a symlink' : 'The API token file could not be read',
      {
        cause: error,
        details: { path, code },
        remedy: `Delete ${path} and start the daemon again to mint a new token.`,
      },
    );
  }

  try {
    // Tightened rather than rotated. A botched `chmod -R` and a token another
    // user actually read are indistinguishable from here, and only one of them
    // is worth invalidating every configured client for. Closing the window is
    // what this can do; saying so loudly is the rest.
    const mode = fstatSync(handle).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      fchmodSync(handle, TOKEN_FILE_MODE);
      logger.warn('the API token file was readable by other users; tightened it', {
        path,
        mode: mode.toString(8),
      });
    }

    const token = readFileSync(handle, 'utf8').trim();
    if (token === '') {
      throw new InterlockError('CONFIG_INVALID', 'The API token file is empty', {
        details: { path },
        remedy: `Delete ${path} and start the daemon again to mint a new token.`,
      });
    }
    return token;
  } finally {
    closeSync(handle);
  }
}

/**
 * Write a fresh token, or `null` when one is already there.
 *
 * `wx` is the exclusive create: the mode argument is applied by `open` itself,
 * so the file is never briefly world-readable the way a write-then-chmod leaves
 * it.
 */
function mint(path: string): string | null {
  let handle: number;
  try {
    handle = openSync(path, 'wx', TOKEN_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw new InterlockError('CONFIG_INVALID', 'The API token file could not be created', {
      cause: error,
      details: { path },
      remedy: 'Check that the Interlock data directory is writable by this user.',
    });
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  try {
    writeSync(handle, `${token}\n`);
  } finally {
    closeSync(handle);
  }
  return token;
}

/**
 * Whether a presented token is the expected one, in time that does not depend
 * on how much of it matched.
 *
 * Both sides are hashed first for two reasons: `timingSafeEqual` throws on a
 * length mismatch, and the length of the presented value is itself something an
 * attacker chooses and would otherwise learn about from.
 */
export function tokenMatches(expected: string, presented: string): boolean {
  return timingSafeEqual(digest(expected), digest(presented));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * The token out of an `Authorization` header, or `null`.
 *
 * The scheme is compared case-insensitively because RFC 7235 says it is, and a
 * client sending `bearer` is not an attacker.
 */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const space = header.indexOf(' ');
  if (space === -1) return null;
  if (header.slice(0, space).toLowerCase() !== 'bearer') return null;
  const token = header.slice(space + 1).trim();
  return token === '' ? null : token;
}
