import { readFileSync } from 'node:fs';
import {
  INTERLOCK_PROTOCOL_VERSION,
  InterlockError,
  isInterlockErrorCode,
  runtimePath,
  tokenPath,
} from '@interlock/shared';
import type { BranchRef, Repo } from '@interlock/shared';

/**
 * The CLI's half of the localhost API.
 *
 * Everything the command needs to know about where the daemon is lives in two
 * files under the data dir: the port it bound, which is knowable nowhere else
 * when the configured port is `0`, and the token it authenticates with. Both
 * paths come from `shared` — the CLI depends on `shared` and never on `daemon`,
 * and the two would otherwise have to agree by memory.
 *
 * Four failures are distinct here and only one of them is "not running". A
 * remedy that says "start the daemon" to someone whose daemon is running and
 * refusing their token sends them in the wrong direction, and they have no way
 * to tell it is wrong.
 */

export interface DaemonClient {
  /** Repositories the daemon is watching. */
  repos(): Promise<Repo[]>;
  /** Branches in one repository, with their dirty state and touched files. */
  branches(repoId: Repo['id']): Promise<BranchRef[]>;
}

/**
 * A request that hangs costs the user a terminal that never comes back.
 *
 * Generous rather than tight: the daemon answers these routes out of SQLite, so
 * anything near this is a daemon in trouble rather than a slow one.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** What a daemon publishes about itself, as far as this client reads it. */
interface RuntimeFile {
  readonly port: number;
}

/** What `GET /api/health` answers. */
interface Health {
  readonly protocolVersion: number;
}

/**
 * Locate the running daemon and confirm this build can talk to it.
 *
 * The probe is one request rather than three checks, because connectivity,
 * authentication and the protocol version are answered by the same round trip
 * and separating them would mean guessing at which of the three failed.
 *
 * @throws InterlockError `DAEMON_UNREACHABLE` when no daemon has started
 *         against this data dir, or the file names a port nothing holds;
 *         `UNAUTHORIZED` when the token is missing or refused;
 *         `API_REQUEST_INVALID` when the daemon speaks another protocol.
 */
export async function connectDaemon(dataDir: string): Promise<DaemonClient> {
  const port = readRuntime(dataDir);
  const token = readToken(dataDir);
  const origin = `http://127.0.0.1:${String(port)}`;

  const request = async <T>(path: string): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(`${origin}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // A refused connection is the ordinary case rather than an edge one: a
      // daemon that crashed leaves its runtime file behind, so the file saying
      // where to look is not the same as something being there.
      throw notRunning(dataDir, port, error);
    }

    if (response.status === 401) {
      throw new InterlockError('UNAUTHORIZED', 'The daemon refused this token', {
        details: { port },
        // Deliberately not "start the daemon" — it is running. The file and the
        // process disagree about the token, which only a restart resolves.
        remedy: 'Stop the daemon and start it again to mint a token both sides share.',
      });
    }
    if (!response.ok) throw await failure(response, path);
    return (await response.json()) as T;
  };

  const health = await request<Health>('/api/health');
  if (health.protocolVersion !== INTERLOCK_PROTOCOL_VERSION) {
    // Half an upgrade: one side moved and the other did not. Guessing past it
    // means reading a payload whose shape is decided by the other version.
    throw new InterlockError('API_REQUEST_INVALID', 'The daemon speaks a different protocol', {
      details: { daemon: health.protocolVersion, cli: INTERLOCK_PROTOCOL_VERSION },
      remedy: `The daemon speaks protocol ${String(health.protocolVersion)} and this command speaks ${String(INTERLOCK_PROTOCOL_VERSION)}. Restart the daemon from the same build.`,
    });
  }

  return {
    async repos(): Promise<Repo[]> {
      return (await request<{ repos: Repo[] }>('/api/repos')).repos;
    },
    async branches(repoId: Repo['id']): Promise<BranchRef[]> {
      const encoded = encodeURIComponent(repoId);
      return (await request<{ branches: BranchRef[] }>(`/api/repos/${encoded}/branches`)).branches;
    },
  };
}

/** The port the daemon published, from a file it rewrites on every start. */
function readRuntime(dataDir: string): number {
  const path = runtimePath(dataDir);
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    throw notStarted(dataDir, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    // Written by rename, so a daemon never publishes half a file — which makes
    // this a file something else wrote, and reading a port out of it would be
    // asking whatever that was where to send a token.
    throw new InterlockError('DAEMON_UNREACHABLE', 'The daemon runtime file is not valid JSON', {
      cause: error,
      details: { path },
      remedy: `Delete ${path} and start the daemon with \`interlockd\`.`,
    });
  }

  const port = (parsed as Partial<RuntimeFile> | null)?.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new InterlockError('DAEMON_UNREACHABLE', 'The daemon runtime file names no valid port', {
      details: { path },
      remedy: `Delete ${path} and start the daemon with \`interlockd\`.`,
    });
  }
  return port;
}

/**
 * The token the daemon minted.
 *
 * Read after the runtime file, and the order decides what the remedy says: a
 * runtime file that exists means a daemon started here, so a token that is
 * missing or unreadable is not a daemon that was never started. Telling someone
 * to start one that is already running sends them somewhere they cannot tell is
 * wrong.
 */
function readToken(dataDir: string): string {
  const path = tokenPath(dataDir);
  const remedy = `Check that ${path} is readable by this user. If the daemon is running, stop it and start it again to mint a new token.`;

  let token: string;
  try {
    token = readFileSync(path, 'utf8').trim();
  } catch (error) {
    throw new InterlockError('UNAUTHORIZED', 'The API token file could not be read', {
      cause: error,
      details: { path },
      remedy,
    });
  }
  if (token === '') {
    throw new InterlockError('UNAUTHORIZED', 'The API token file is empty', {
      details: { path },
      remedy,
    });
  }
  return token;
}

/**
 * No runtime file — which is usually a daemon nobody started, and sometimes a
 * data dir that is not one.
 *
 * `ENOTDIR` says the path names a file, and telling someone to start a daemon
 * against it would have them do that and see the same message again.
 */
function notStarted(dataDir: string, cause: unknown): InterlockError {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOTDIR') {
    return new InterlockError('CONFIG_INVALID', 'The data directory is not a directory', {
      cause,
      details: { dataDir },
      remedy: `${dataDir} is a file. Pass --data-dir the directory the daemon keeps its state in.`,
    });
  }
  return new InterlockError('DAEMON_UNREACHABLE', 'No daemon is running for this data directory', {
    cause,
    details: { dataDir },
    remedy: 'Start it with `interlockd`, or pass --data-dir if it is running elsewhere.',
  });
}

function notRunning(dataDir: string, port: number, cause: unknown): InterlockError {
  return new InterlockError('DAEMON_UNREACHABLE', 'Nothing is listening on the daemon port', {
    cause,
    details: { dataDir, port },
    remedy:
      'The daemon is not running, or it stopped without cleaning up. Start it with `interlockd`.',
  });
}

/**
 * Rebuild the daemon's own error, so what it said survives the wire.
 *
 * The API answers a failure with the shape `InterlockError.toJSON` produces,
 * and all three parts of it matter. The `remedy` is the only part a user can
 * act on. The `code` is what a script reacts to, and re-minting every failure
 * as one code loses the distinction the daemon drew — a repository that
 * disappeared between listing it and asking about it is `REPO_NOT_FOUND` there
 * and must not read as a malformed request here.
 *
 * The code is checked rather than trusted: it arrives from another process, and
 * one this build does not know is not a code to hand to a caller matching on
 * them.
 */
async function failure(response: Response, path: string): Promise<InterlockError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // An error with no body, or one that is not JSON. The status is then all
    // there is, and it is still a failure rather than something to read past.
    body = null;
  }

  const error = (body as { error?: { code?: unknown; message?: unknown; remedy?: unknown } } | null)
    ?.error;
  const message = typeof error?.message === 'string' ? error.message : response.statusText;
  const remedy = typeof error?.remedy === 'string' ? error.remedy : undefined;
  const code = isInterlockErrorCode(error?.code) ? error.code : 'API_REQUEST_INVALID';

  return new InterlockError(code, `The daemon refused the request: ${message}`, {
    details: { path, status: response.status },
    ...(remedy === undefined ? {} : { remedy }),
  });
}
