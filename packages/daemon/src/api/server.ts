import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { INTERLOCK_PROTOCOL_VERSION, InterlockError, isInterlockError } from '@interlock/shared';
import type { InterlockConfig, Logger, RepoId } from '@interlock/shared';
import type { Store } from '../store/index.js';
import { bearerToken, ensureToken, tokenMatches } from './token.js';

/**
 * The localhost HTTP API consumed by the CLI, the dashboard and the MCP server.
 *
 * Two properties hold it together and both are tested rather than asserted in
 * prose: it binds `127.0.0.1` and nothing else, and every request carries the
 * bearer token — including one for a path that does not exist, so a caller
 * without a token cannot learn which paths do.
 */

export interface Bound {
  /**
   * The interface the listener is on, read back off it.
   *
   * Returned rather than assumed so the loopback-only promise is something a
   * test can assert against the kernel's answer instead of against the config.
   */
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

export interface ApiServer {
  /** Binds and returns what the listener actually got, never what was asked for. */
  start(): Promise<Bound>;
  stop(): Promise<void>;
}

export interface ApiOptions {
  readonly config: InterlockConfig;
  readonly store: Store;
  readonly logger: Logger;
}

/**
 * How long a listener may take to shut down before it is closed on top of
 * whatever is still connected.
 *
 * `close` drops idle keep-alive sockets on its own but waits indefinitely for a
 * connection that is mid-request — including one that opened, sent half a
 * request line and stopped. Without a bound, a client like that keeps the
 * daemon alive for as long as it holds the socket.
 */
const CLOSE_GRACE_MS = 2_000;

/** A request that never finishes its headers holds a socket the drain waits on. */
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** Hostnames a loopback listener may legitimately be addressed by. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost']);

export function createApiServer(options: ApiOptions): ApiServer {
  const log = options.logger.child('api');
  const { config, store } = options;
  const startedAt = new Date().toISOString();

  let server: Server | null = null;
  let token: string | null = null;

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    void respond(request, response).catch((error: unknown) => {
      // Reaching here means `respond` failed outside its own try, which is a bug
      // rather than a request that went wrong; the socket still has to end.
      log.error('request handling failed', { error: String(error) });
      if (!response.headersSent) response.writeHead(500).end();
      else response.end();
    });
  };

  const respond = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // Nothing here reads a body, and an unread one keeps the socket busy past
    // the response, which is what the drain then waits on.
    request.resume();

    if (!sameOrigin(request)) {
      // A page in a browser can post to a loopback port, and it reaches it by a
      // name that resolves to 127.0.0.1. The token stops it being useful; this
      // stops it being reached. No CORS header is ever sent, so a browser cannot
      // read the answer either way.
      send(response, 403, { error: { code: 'UNAUTHORIZED', message: 'Host not permitted' } });
      return;
    }

    if (token === null || !authorized(request, token)) {
      // Before routing, so a 404 never tells an unauthenticated caller which
      // routes exist.
      response.setHeader('WWW-Authenticate', 'Bearer');
      send(response, 401, {
        error: { code: 'UNAUTHORIZED', message: 'A bearer token is required' },
      });
      return;
    }

    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      send(response, 405, {
        error: {
          code: 'API_REQUEST_INVALID',
          message: `${String(request.method)} is not allowed`,
        },
      });
      return;
    }

    try {
      await route(request, response);
    } catch (error) {
      fail(response, error, log);
    }
  };

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const segments = pathSegments(request.url ?? '/');
    if (segments === null) {
      // A percent-escape that does not decode is a client typing mistake. Left
      // to `decodeURIComponent`, the `URIError` reaches the catch-all and is
      // answered as an internal error, with a matching line in the log.
      //
      // Raised rather than sent, unlike the 404 and the 405 below: those are
      // protocol outcomes with a status of their own, while this is an error,
      // and routing it through `statusFor` is what keeps that mapping something
      // the suite reaches.
      throw new InterlockError('API_REQUEST_INVALID', 'The request path could not be decoded', {
        remedy: 'Check the percent-escapes in the path.',
      });
    }

    if (matches(segments, ['api', 'health'])) {
      send(response, 200, {
        status: 'ok',
        protocolVersion: INTERLOCK_PROTOCOL_VERSION,
        pid: process.pid,
        startedAt,
      });
      return;
    }

    if (matches(segments, ['api', 'repos'])) {
      send(response, 200, { repos: await store.listRepos() });
      return;
    }

    if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'repos') {
      const [, , id, tail] = segments;
      if (tail === 'branches') {
        // Checked rather than assumed: `listBranchRefs` answers an empty list
        // for a repository that does not exist, which reads as "no branches"
        // instead of "no such repository".
        const repos = await store.listRepos();
        if (!repos.some((repo) => repo.id === id)) {
          throw new InterlockError('REPO_NOT_FOUND', 'No such repository', {
            details: { repoId: id },
            remedy: 'List repositories at /api/repos.',
          });
        }
        send(response, 200, { branches: await store.listBranchRefs(id as RepoId) });
        return;
      }
    }

    // Not `REPO_NOT_FOUND`: a client matching on that would report a repository
    // that does not exist when what it actually asked for was a path this
    // daemon does not serve.
    send(response, 404, { error: { code: 'API_REQUEST_INVALID', message: 'No such route' } });
  };

  return {
    start(): Promise<Bound> {
      if (server !== null) {
        return Promise.reject(
          new InterlockError('CONFIG_INVALID', 'The API server is already started'),
        );
      }

      const minted = ensureToken(config.dataDir, log);
      token = minted;
      const listener = createServer(handle);
      listener.headersTimeout = HEADERS_TIMEOUT_MS;
      listener.requestTimeout = REQUEST_TIMEOUT_MS;
      server = listener;

      return new Promise((resolve, reject) => {
        let bound = false;
        // Kept for the life of the listener rather than removed once it binds.
        // An `error` on an emitter with nothing listening is rethrown, so a
        // failure after the bind — an accept that fails, a descriptor that goes
        // away — would take the process down instead of being reported.
        listener.on('error', (error: Error) => {
          if (bound) {
            log.error('the API listener failed', { error: error.message });
            return;
          }
          server = null;
          reject(bindFailure(error, config));
        });
        // The host is passed explicitly and is a literal type in the config, so
        // there is no spelling of this that listens on another interface.
        listener.listen(config.daemon.port, config.daemon.host, () => {
          const address = listener.address();
          if (address === null || typeof address === 'string') {
            server = null;
            reject(bindFailure(new Error('the listener reported no address'), config));
            return;
          }
          bound = true;
          log.info('API listening', { host: address.address, port: address.port });
          resolve({ host: address.address, port: address.port, token: minted });
        });
      });
    },

    async stop(): Promise<void> {
      const listener = server;
      if (listener === null) return;
      server = null;
      token = null;

      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(deadline);
          resolve();
        };
        const deadline = setTimeout(() => {
          // Whatever is still connected is not going to finish on its own, and
          // `close` on its own would wait for it.
          listener.closeAllConnections();
        }, CLOSE_GRACE_MS);
        deadline.unref();

        listener.close(done);
      });
    },
  };
}

/** Loopback bind failures are worth naming: a taken port is the common one. */
function bindFailure(error: unknown, config: InterlockConfig): InterlockError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const port = config.daemon.port;
  if (code === 'EADDRINUSE') {
    return new InterlockError('CONFIG_INVALID', `Port ${String(port)} is already in use`, {
      cause: error,
      details: { port },
      remedy: 'Another daemon is probably running. Stop it, or set daemon.port to a free port.',
    });
  }
  return new InterlockError('CONFIG_INVALID', 'The API listener could not bind', {
    cause: error,
    details: { host: config.daemon.host, port },
    remedy: 'Check that nothing else holds the port and that loopback is available.',
  });
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const presented = bearerToken(request.headers.authorization);
  return presented !== null && tokenMatches(expected, presented);
}

/**
 * Whether the request addressed this listener by a loopback name.
 *
 * A missing `Host` is refused rather than allowed: every HTTP/1.1 client sends
 * one, and treating its absence as acceptable is the same hole with an extra
 * step.
 */
function sameOrigin(request: IncomingMessage): boolean {
  const header = request.headers.host;
  if (header === undefined) return false;
  // IPv6 literals are bracketed; the listener is IPv4 loopback, so one here is
  // not a host it was reached by.
  if (header.startsWith('[')) return false;
  const colon = header.lastIndexOf(':');
  // Lowercased because a host name is case-insensitive: `LOCALHOST` is the same
  // name, and refusing it would be a client that works everywhere else failing
  // here. The port is deliberately not checked — whatever a request claims, it
  // arrived on the port this listener holds.
  const name = (colon === -1 ? header : header.slice(0, colon)).toLowerCase();
  return LOOPBACK_HOSTS.has(name);
}

/**
 * Path segments, with the query string and empty segments dropped, or `null`
 * for a path that does not decode.
 *
 * Split before decoding, which is the order that matters: decoding first turns
 * a `%2F` inside one segment into a separator and hands the caller a path it
 * never sent, which is the classic traversal confusion. Doing it this way means
 * an encoded slash stays inside the segment it was written in.
 */
function pathSegments(url: string): string[] | null {
  const query = url.indexOf('?');
  const path = query === -1 ? url : url.slice(0, query);
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '') continue;
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  return segments;
}

function matches(segments: readonly string[], expected: readonly string[]): boolean {
  return segments.length === expected.length && segments.every((s, i) => s === expected[i]);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // The API answers about a developer's source; a cache is one more copy of
    // it, and `nosniff` keeps a browser from rendering the answer as anything
    // but data.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

/** Map a failure onto a status, without letting an unexpected one out verbatim. */
function fail(response: ServerResponse, error: unknown, log: Logger): void {
  if (isInterlockError(error)) {
    send(response, statusFor(error), { error: error.toJSON() });
    return;
  }
  // An error this code did not construct may carry a stack, a path or a query,
  // and the caller learns nothing useful from any of it.
  log.error('request failed', { error: error instanceof Error ? error.message : String(error) });
  send(response, 500, { error: { code: 'INTERNAL', message: 'Internal error' } });
}

function statusFor(error: InterlockError): number {
  switch (error.code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'REPO_NOT_FOUND':
      return 404;
    case 'CONFIG_INVALID':
    case 'API_REQUEST_INVALID':
      return 400;
    case 'NOT_IMPLEMENTED':
      return 501;
    default:
      return error.infra ? 503 : 500;
  }
}
