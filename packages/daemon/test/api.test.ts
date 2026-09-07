import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { Agent, request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, resolveConfig, tokenPath, ulid } from '@interlock/shared';
import type { InterlockConfig, LogRecord, RepoId } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer, ensureToken } from '../src/api/index.js';
import type { ApiServer, Bound } from '../src/api/index.js';
import { openStore } from '../src/store/index.js';
import type { Store } from '../src/store/index.js';
import { rejection } from './support/rejection.js';

/**
 * The API against a real listener, because every property worth asserting is
 * one the kernel or the HTTP layer decides: which interface it bound, what a
 * request without a header gets back, and whether an unknown path answers
 * differently from a known one.
 */

/** Paths that exist, plus one that does not — every one of them needs a token. */
const ROUTES = ['/api/health', '/api/repos', '/api/repos/x/branches', '/api/nope'] as const;

describe('localhost API', () => {
  let dataDir: string;
  let config: InterlockConfig;
  let store: Store;
  let api: ApiServer;
  let bound: Bound;
  let logs: LogRecord[];
  let agent: Agent;

  /**
   * Driven through `node:http` rather than `fetch`, because `Host` is a
   * forbidden header there and the request this has to make is one that lies
   * about it.
   */
  const call = (
    path: string,
    init: { token?: string | null; method?: string; host?: string } = {},
  ): Promise<{ status: number; headers: IncomingHttpHeaders; body: unknown }> => {
    const headers: Record<string, string> = {};
    if (init.token !== null && init.token !== undefined) {
      headers.Authorization = `Bearer ${init.token}`;
    }
    if (init.host !== undefined) headers.Host = init.host;

    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          agent,
          host: '127.0.0.1',
          port: bound.port,
          path,
          method: init.method ?? 'GET',
          headers,
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            text += chunk;
          });
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: text === '' ? null : (JSON.parse(text) as unknown),
            });
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
  };

  beforeEach(async () => {
    dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-api-')));
    config = resolveConfig({ dataDir, daemon: { port: 0 } });
    logs = [];
    // Kept alive deliberately: an idle pooled socket is what a `close` waiting
    // for every connection would hang on.
    agent = new Agent({ keepAlive: true });
    store = await openStore({ path: ':memory:' });
    api = createApiServer({
      config,
      store,
      logger: createLogger('test', { level: 'trace', sink: (record) => logs.push(record) }),
    });
    bound = await api.start();
  });

  afterEach(async () => {
    await api.stop();
    agent.destroy();
    await store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('binds loopback and nothing else', () => {
    // Read back off the listener rather than echoed from the config, so this
    // asserts what the kernel did.
    expect(bound.host).toBe('127.0.0.1');
    expect(bound.port).toBeGreaterThan(0);
  });

  it('answers every route, and one that does not exist, with 401 when unauthenticated', async () => {
    for (const route of ROUTES) {
      const response = await call(route, { token: null });
      expect(response.status, route).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
    }
  });

  it('does not reveal which routes exist to a caller without a token', async () => {
    const known = await call('/api/health', { token: null });
    const unknown = await call('/api/nope', { token: null });
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toStrictEqual(known.body);
  });

  it('refuses a wrong token of the same length and of a different length', async () => {
    const sameLength = `${bound.token.slice(0, -1)}${bound.token.endsWith('a') ? 'b' : 'a'}`;
    expect((await call('/api/health', { token: sameLength })).status).toBe(401);
    // A 500 here would mean the comparison threw on the length mismatch, which
    // answers "wrong length" rather than "wrong token".
    expect((await call('/api/health', { token: 'short' })).status).toBe(401);
    expect((await call('/api/health', { token: `${bound.token}extra` })).status).toBe(401);
  });

  it('serves health with the token', async () => {
    const response = await call('/api/health', { token: bound.token });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', pid: process.pid });
  });

  it('serves repositories and their branches', async () => {
    const repoId = ulid<RepoId>();
    const now = new Date().toISOString();
    const repo = await store.upsertRepo({
      id: repoId,
      rootPath: '/tmp/example',
      defaultBranch: 'main',
      shadowPath: join(dataDir, 'shadows', repoId),
      config: {},
      discoveredAt: now,
      lastSeenAt: now,
    });

    const repos = await call('/api/repos', { token: bound.token });
    expect(repos.status).toBe(200);
    expect(repos.body).toMatchObject({ repos: [{ rootPath: '/tmp/example' }] });

    const branches = await call(`/api/repos/${repo.id}/branches`, { token: bound.token });
    expect(branches.status).toBe(200);
    expect(branches.body).toStrictEqual({ branches: [] });
  });

  it('says a repository is missing rather than answering that it has no branches', async () => {
    const response = await call(`/api/repos/${ulid<RepoId>()}/branches`, { token: bound.token });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: 'REPO_NOT_FOUND' } });
  });

  it('refuses a request addressed by a name that is not loopback', async () => {
    // How a page in a browser reaches a loopback port: a hostname the attacker
    // controls, resolving to 127.0.0.1.
    const response = await call('/api/health', { token: bound.token, host: 'evil.example.com' });
    expect(response.status).toBe(403);
  });

  it('accepts localhost as well as the literal address', async () => {
    const response = await call('/api/health', {
      token: bound.token,
      host: `localhost:${String(bound.port)}`,
    });
    expect(response.status).toBe(200);
  });

  it('sends no CORS header, so a browser cannot read an answer it provoked', async () => {
    const response = await call('/api/health', { token: bound.token });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses every method it does not serve, after the token rather than before it', async () => {
    expect((await call('/api/health', { token: null, method: 'POST' })).status).toBe(401);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const authorized = await call('/api/health', { token: bound.token, method });
      expect(authorized.status, method).toBe(405);
      expect(authorized.headers.allow).toBe('GET');
    }
  });

  it('refuses a request that sends no Host header at all', async () => {
    // HTTP/1.0, because the parser answers a 1.1 request missing `Host` with a
    // 400 of its own and the handler never sees it — while a 1.0 request with no
    // `Host` reaches it with the header undefined. Treating that as acceptable
    // is the same hole the check closes, with an extra step.
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(bound.port, '127.0.0.1', () => {
        socket.write(`GET /api/health HTTP/1.0\r\nAuthorization: Bearer ${bound.token}\r\n\r\n`);
      });
      let text = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        text += chunk;
        if (text.includes('\r\n\r\n')) {
          socket.destroy();
          resolve(text);
        }
      });
      socket.on('error', reject);
    });
    expect(raw.startsWith('HTTP/1.1 403')).toBe(true);
  });

  it('answers an unknown path with 404 once the token is right', async () => {
    expect((await call('/api/nope', { token: bound.token })).status).toBe(404);
  });

  it('refuses to start twice on one instance', async () => {
    const error = await rejection(api.start());
    expect(error.code).toBe('CONFIG_INVALID');
  });

  it('stops without waiting for an idle keep-alive connection', async () => {
    await call('/api/health', { token: bound.token });

    const started = Date.now();
    await api.stop();
    // Timed, because a `close` that waits still resolves eventually: Node drops
    // an idle socket at `keepAliveTimeout`, five seconds later. The property is
    // that shutting down does not sit through it.
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(call('/api/health', { token: bound.token })).rejects.toThrow();
  });

  it('stops on a deadline when a client is mid-request and never finishes', async () => {
    const stuck = connect(bound.port, '127.0.0.1');
    // The server destroys it on the deadline, which reaches the client as a reset.
    stuck.on('error', () => undefined);
    await new Promise((resolve) => stuck.on('connect', resolve));

    // One complete request first, so the second one is provably half-read by the
    // time the shutdown starts: a connection the server has not looked at yet is
    // idle, and `close` drops those without help.
    stuck.write(
      `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${bound.token}\r\n\r\n`,
    );
    await new Promise((resolve) => stuck.once('data', resolve));
    stuck.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    await new Promise((resolve) => setTimeout(resolve, 150));

    const started = Date.now();
    await api.stop();
    // Without the deadline this waits for the header timeout instead, which is
    // ten seconds — it does finish, so the assertion has to be on the wait.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('is safe to stop twice', async () => {
    await api.stop();
    await expect(api.stop()).resolves.toBeUndefined();
  });
});

describe('the API token file', () => {
  let dataDir: string;
  let logs: LogRecord[];

  const logger = (): ReturnType<typeof createLogger> =>
    createLogger('test', { level: 'trace', sink: (record) => logs.push(record) });

  beforeEach(() => {
    dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-token-')));
    logs = [];
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('mints a token owner-readable only', () => {
    const token = ensureToken(dataDir, logger());
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(statSync(tokenPath(dataDir)).mode & 0o777).toBe(0o600);
  });

  it('keeps the token across starts, because clients are configured with it', () => {
    const first = ensureToken(dataDir, logger());
    expect(ensureToken(dataDir, logger())).toBe(first);
  });

  it('does not return the trailing newline it writes', () => {
    const token = ensureToken(dataDir, logger());
    expect(readFileSync(tokenPath(dataDir), 'utf8')).toBe(`${token}\n`);
    expect(token).not.toContain('\n');
  });

  it('tightens a token file another user could read, and says so', () => {
    ensureToken(dataDir, logger());
    chmodSync(tokenPath(dataDir), 0o644);

    logs = [];
    ensureToken(dataDir, logger());
    expect(statSync(tokenPath(dataDir)).mode & 0o777).toBe(0o600);
    expect(logs.some((record) => record.level === 'warn')).toBe(true);
  });

  it('refuses an empty token file rather than authenticating against nothing', () => {
    // A file that exists and holds nothing: no daemon wrote it, and reading it
    // as a valid token would authenticate an empty Authorization header.
    writeFileSync(tokenPath(dataDir), '  \n', { mode: 0o600 });

    const log = logger();
    expect(() => ensureToken(dataDir, log)).toThrowError(/empty/u);
  });
});
