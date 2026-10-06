import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { Agent, request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InterlockError, createLogger, resolveConfig, tokenPath, ulid } from '@interlock/shared';
import type {
  BranchRefId,
  Finding,
  FindingId,
  InterlockConfig,
  LogRecord,
  RepoId,
} from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer, ensureToken } from '../src/api/index.js';
import type { CheckRequest, Checks } from '../src/check.js';
import { createDismissals } from '../src/dismiss.js';
import type { DismissRequest, Dismissals } from '../src/dismiss.js';
import type { ApiServer, Bound } from '../src/api/index.js';
import { EventBus } from '../src/bus/index.js';
import { createSessionRegistry } from '../src/hooks/index.js';
import type { SessionRegistry } from '../src/hooks/index.js';
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
const ROUTES = [
  '/api/health',
  '/api/repos',
  '/api/repos/x/branches',
  '/api/repos/x/check',
  '/api/budget',
  '/api/findings/x/dismiss',
  '/api/nope',
] as const;

describe('localhost API', () => {
  let dataDir: string;
  let config: InterlockConfig;
  let store: Store;
  let api: ApiServer;
  let bound: Bound;
  let sessions: SessionRegistry;
  let logs: LogRecord[];
  let agent: Agent;
  /** What the check route runs, or null for a daemon still starting. */
  let checks: Checks | null;
  let asked: { repoId: RepoId; request: CheckRequest; signal: AbortSignal }[];
  /** What the dismiss route runs: the real dismissals unless a test stands one in. */
  let dismiss: Dismissals['dismiss'];

  /**
   * Driven through `node:http` rather than `fetch`, because `Host` is a
   * forbidden header there and the request this has to make is one that lies
   * about it.
   */
  const call = (
    path: string,
    init: {
      token?: string | null;
      method?: string;
      host?: string;
      body?: unknown;
      raw?: string;
      /** Send `Content-Length`; without it the body is chunked and undeclared. */
      declareLength?: boolean;
    } = {},
  ): Promise<{ status: number; headers: IncomingHttpHeaders; body: unknown }> => {
    const headers: Record<string, string> = {};
    if (init.token !== null && init.token !== undefined) {
      headers.Authorization = `Bearer ${init.token}`;
    }
    if (init.host !== undefined) headers.Host = init.host;
    const payload = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    if (payload !== undefined && init.declareLength === true) {
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }

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
      // A body past the cap is destroyed mid-send, which the client sees as a
      // reset rather than a response; that is a refusal too. Only while a body
      // is being sent — a reset on a plain GET is a failure the test asked for.
      outgoing.on('error', (error: NodeJS.ErrnoException) =>
        payload !== undefined && (error.code === 'ECONNRESET' || error.code === 'EPIPE')
          ? resolve({ status: 0, headers: {}, body: null })
          : reject(error),
      );
      // `end(payload)` sets `Content-Length` on its own, so a body that must
      // arrive undeclared — chunked — is written first and ended after.
      if (payload !== undefined && init.declareLength === false) {
        outgoing.write(payload);
        outgoing.end();
      } else {
        outgoing.end(payload);
      }
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
    const logger = createLogger('test', { level: 'trace', sink: (record) => logs.push(record) });
    const bus = new EventBus({ logger });
    sessions = createSessionRegistry({ store, bus, logger, staleAfterMs: 60_000 });
    asked = [];
    const real = createDismissals({ store, bus, logger });
    dismiss = (id, request) => real.dismiss(id, request);
    checks = {
      run: (repoId, request, signal) => {
        asked.push({ repoId, request, signal });
        return Promise.resolve({
          repoId,
          a: { id: ulid<BranchRefId>(), name: request.a },
          b: { id: ulid<BranchRefId>(), name: request.b ?? 'main' },
          mergeBaseSha: 'a'.repeat(40),
          clean: true,
          findings: [],
          dismissed: [],
        });
      },
    };
    api = createApiServer({
      config,
      store,
      sessions,
      checks: () => checks,
      dismissals: { dismiss: (id, request) => dismiss(id, request) },
      logger,
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

  it('accepts the Host header in any case, because a host name is not case-sensitive', async () => {
    const response = await call('/api/health', {
      token: bound.token,
      host: `LOCALHOST:${String(bound.port)}`,
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
      expect(authorized.body).toMatchObject({ error: { code: 'API_REQUEST_INVALID' } });
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
    const response = await call('/api/nope', { token: bound.token });
    expect(response.status).toBe(404);
    // Not `REPO_NOT_FOUND`, which a client would report as a missing
    // repository, and not `UNAUTHORIZED`, which would send someone to check a
    // token that was fine.
    expect(response.body).toMatchObject({ error: { code: 'API_REQUEST_INVALID' } });
  });

  it('never answers UNAUTHORIZED for a request whose token was accepted', async () => {
    // The code is what a client reacts to; the message is not. Every one of
    // these got past the token, so none of them may name it as the problem.
    const past = [
      await call('/api/health', { token: bound.token, method: 'POST' }),
      await call('/api/nope', { token: bound.token }),
      await call('/api/%', { token: bound.token }),
      await call(`/api/repos/${ulid<RepoId>()}/branches`, { token: bound.token }),
    ];
    for (const response of past) {
      expect(response.body).not.toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    }
  });

  it('answers a path it cannot decode as a client mistake, not a server fault', async () => {
    // `decodeURIComponent('%')` raises, and left to the catch-all that is a 500
    // with an error-level log line for what is only a malformed request.
    const response = await call('/api/%', { token: bound.token });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'API_REQUEST_INVALID' } });
    expect(logs.filter((record) => record.level === 'error')).toStrictEqual([]);
  });

  it('serves three POST routes, the session hook, a check and a dismissal, and nothing else', async () => {
    // Everything else stays GET-only, so nothing becomes writable by accident.
    expect((await call('/api/repos', { token: bound.token, method: 'POST' })).status).toBe(405);
    expect((await call('/api/budget', { token: bound.token, method: 'POST' })).status).toBe(405);
    for (const path of ['/api/sessions', '/api/repos/x/check', `/api/findings/${ulid()}/dismiss`]) {
      const get = await call(path, { token: bound.token });
      expect(get.status).toBe(405);
      expect(get.headers.allow).toBe('POST');
    }
    expect(asked).toEqual([]);
  });

  describe('the check route', () => {
    const post = (body: unknown, raw?: string) =>
      call('/api/repos/01JBQ0000000000000000REPO/check', {
        token: bound.token,
        method: 'POST',
        ...(raw === undefined ? { body } : { raw }),
      });

    it('runs the named pair for the repository in the path, and answers with its state', async () => {
      const response = await post({ a: 'one', b: 'two', timeoutMs: 5_000 });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        check: { a: { name: 'one' }, b: { name: 'two' }, clean: true, findings: [] },
      });
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({
        repoId: '01JBQ0000000000000000REPO',
        request: { a: 'one', b: 'two', timeoutMs: 5_000 },
      });
    });

    it('takes one name, for a check against the default branch, and a default deadline', async () => {
      expect((await post({ a: 'one' })).status).toBe(200);
      expect(asked[0]!.request).toEqual({ a: 'one', b: null, timeoutMs: 60_000 });
    });

    it('needs the token like every route, before reading the body', async () => {
      const response = await call('/api/repos/x/check', {
        token: null,
        method: 'POST',
        body: { a: 'one' },
      });
      expect(response.status).toBe(401);
      expect(asked).toEqual([]);
    });

    it.each([
      [{}, 'a must be a branch name'],
      [{ a: '' }, 'a must be a branch name'],
      [{ a: 1 }, 'a must be a branch name'],
      [{ a: 'one', b: 2 }, 'b must be a branch name'],
      [{ a: 'x'.repeat(1_025) }, 'longer than 1024'],
      [{ a: 'one', timeoutMs: 500 }, 'timeoutMs must be'],
      [{ a: 'one', timeoutMs: 1.5e3 + 0.5 }, 'timeoutMs must be'],
      [{ a: 'one', timeoutMs: 600_001 }, 'timeoutMs must be'],
      [{ a: 'one', cwd: '/' }, 'unknown field "cwd"'],
      [[], 'must be a JSON object'],
    ])('refuses %j, and runs nothing', async (body, problem) => {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: { code: 'API_REQUEST_INVALID' } });
      const { problems } = (response.body as { error: { details: { problems: string[] } } }).error
        .details;
      expect(problems.join('; ')).toContain(problem);
      expect(asked).toEqual([]);
    });

    it("refuses a body past its cap, which is far below the hook route's", async () => {
      const response = await post(undefined, JSON.stringify({ a: 'x'.repeat(5_000) }));
      expect([0, 400]).toContain(response.status);
      expect(asked).toEqual([]);
    });

    it('answers a daemon still starting as unavailable, not as a missing route', async () => {
      checks = null;
      const response = await post({ a: 'one' });
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ error: { code: 'DAEMON_UNREACHABLE' } });
    });

    it.each([
      ['BRANCH_NOT_FOUND', false, 404],
      ['BRANCHES_UNRELATED', false, 409],
      ['CHECK_TIMEOUT', true, 503],
    ] as const)('answers %s with %i', async (code, infra, status) => {
      checks = { run: () => Promise.reject(new InterlockError(code, 'no', { infra })) };
      const response = await post({ a: 'one' });
      expect(response.status).toBe(status);
      expect(response.body).toMatchObject({ error: { code } });
    });

    it('stops waiting when the caller hangs up', async () => {
      let aborted: () => void = () => undefined;
      const stopped = new Promise<void>((resolve) => {
        aborted = resolve;
      });
      checks = {
        run: (_repoId, _request, signal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              aborted();
              reject(new InterlockError('API_REQUEST_INVALID', 'gone', { infra: true }));
            });
          }),
      };
      const outgoing = request({
        agent: false,
        host: '127.0.0.1',
        port: bound.port,
        path: '/api/repos/x/check',
        method: 'POST',
        headers: { Authorization: `Bearer ${bound.token}`, 'Content-Type': 'application/json' },
      });
      outgoing.on('error', () => undefined);
      outgoing.end(JSON.stringify({ a: 'one' }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      outgoing.destroy();

      await stopped;
    });
  });

  describe('the dismiss route', () => {
    let dismissed: { id: string; request: DismissRequest }[];
    const id = ulid<FindingId>();
    const post = (body: unknown, raw?: string, path = `/api/findings/${id}/dismiss`) =>
      call(path, {
        token: bound.token,
        method: 'POST',
        ...(raw === undefined ? { body } : { raw }),
      });

    /** Stand in for the dismissals, recording what reached them. */
    const recording = (): void => {
      dismissed = [];
      dismiss = (findingId, request) => {
        dismissed.push({ id: findingId, request });
        return Promise.resolve({ id: findingId } as unknown as Finding);
      };
    };

    it('dismisses the Finding in the path with the reason and note in the body', async () => {
      recording();
      const response = await post({ reason: 'wrong', note: 'rerere' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ finding: { id } });
      expect(dismissed).toEqual([{ id, request: { reason: 'wrong', note: 'rerere' } }]);
    });

    it('answers a Finding the store does not hold with 404', async () => {
      const response = await post({ reason: 'wrong' });
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ error: { code: 'FINDING_NOT_FOUND' } });
    });

    it('answers a Finding it cannot dismiss with 409', async () => {
      dismiss = () => Promise.reject(new InterlockError('FINDING_NOT_DISMISSABLE', 'resolved'));
      const response = await post({ reason: 'known' });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ error: { code: 'FINDING_NOT_DISMISSABLE' } });
    });

    it('needs the token like every route, before reading the body', async () => {
      recording();
      const response = await call(`/api/findings/${id}/dismiss`, {
        token: null,
        method: 'POST',
        body: { reason: 'wrong' },
      });
      expect(response.status).toBe(401);
      expect(dismissed).toEqual([]);
    });

    it('refuses a path segment that is not a Finding id, and dismisses nothing', async () => {
      recording();
      for (const segment of ['nope', id.slice(0, 12), '..']) {
        const response = await post(
          { reason: 'wrong' },
          undefined,
          `/api/findings/${segment}/dismiss`,
        );
        expect(response.status, segment).toBe(400);
      }
      expect(dismissed).toEqual([]);
    });

    it.each([
      [{}, 'reason must be one of wrong, known'],
      [{ reason: 'false-positive' }, 'reason must be one of wrong, known'],
      [{ reason: 'wrong', note: '' }, 'note must be non-empty text'],
      [{ reason: 'wrong', note: 'x'.repeat(501) }, 'longer than 500'],
      [{ reason: 'wrong', by: 'me' }, 'unknown field "by"'],
      [[], 'must be a JSON object'],
    ])('refuses %j, and dismisses nothing', async (body, problem) => {
      recording();
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: { code: 'API_REQUEST_INVALID' } });
      const { problems } = (response.body as { error: { details: { problems: string[] } } }).error
        .details;
      expect(problems.join('; ')).toContain(problem);
      expect(dismissed).toEqual([]);
    });

    it('takes the longest note however JSON spells it, and refuses a body past its cap', async () => {
      recording();
      // Every character escaped, six bytes each: the most a valid note can be.
      const escaped = JSON.stringify({ reason: 'wrong', note: '\u0001'.repeat(500) });
      expect(Buffer.byteLength(escaped)).toBeGreaterThan(3_000);
      expect((await post(undefined, escaped)).status).toBe(200);

      const response = await post(
        undefined,
        JSON.stringify({ reason: 'wrong', note: 'x'.repeat(5_000) }),
      );
      expect([0, 400]).toContain(response.status);
      expect(dismissed).toHaveLength(1);
    });
  });

  it('serves the false-positive budget, with nothing counted as no data and delivered unmeasured', async () => {
    const response = await call('/api/budget', { token: bound.token });

    expect(response.status).toBe(200);
    const { windows } = (response.body as { budget: { windows: Record<string, unknown>[] } })
      .budget;
    expect(windows.map((window) => window.hours)).toEqual([24, 168]);
    for (const window of windows) {
      expect(window).toMatchObject({ raised: 0, rate: null, delivered: null, rules: [] });
    }
  });

  it('registers a session from a hook payload and lists it back', async () => {
    const repoId = ulid<RepoId>();
    const now = new Date().toISOString();
    const repo = await store.upsertRepo({
      id: repoId,
      rootPath: '/work/repo',
      defaultBranch: 'main',
      shadowPath: join(dataDir, 'shadows', repoId),
      config: {},
      discoveredAt: now,
      lastSeenAt: now,
    });
    await store.upsertBranchRef({
      id: ulid<BranchRefId>(),
      repoId: repo.id,
      ref: 'refs/heads/main',
      name: 'main',
      headSha: 'a'.repeat(40),
      worktreePath: '/work/repo',
      dirty: null,
      sessionId: null,
      firstSeenAt: now,
      updatedAt: now,
    });

    const posted = await call('/api/sessions', {
      token: bound.token,
      method: 'POST',
      body: {
        event: 'start',
        kind: 'claude-code',
        externalSessionId: 'sess-1',
        cwd: '/work/repo/src',
        pid: process.pid,
        branch: null,
      },
    });
    expect(posted.status).toBe(200);
    expect(posted.body).toMatchObject({
      session: { kind: 'claude-code', attribution: 'inferred' },
    });

    const listed = await call(`/api/repos/${repo.id}/sessions`, { token: bound.token });
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ sessions: [{ externalSessionId: 'sess-1' }] });
  });

  it('refuses a malformed hook payload with a code, and keeps serving', async () => {
    const bad = await call('/api/sessions', {
      token: bound.token,
      method: 'POST',
      body: { event: 'start', kind: 'skynet', extra: true },
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: { code: 'API_REQUEST_INVALID' } });
    expect((bad.body as { error: { message: string } }).error.message).toContain('`extra`');

    const notJson = await call('/api/sessions', { token: bound.token, method: 'POST', raw: '{' });
    expect(notJson.status).toBe(400);

    // Still up, and nothing written.
    expect((await call('/api/health', { token: bound.token })).status).toBe(200);
    expect(logs.filter((record) => record.level === 'error')).toStrictEqual([]);
  });

  it('refuses a body it is told will be over the cap, with an answer', async () => {
    // An honest client declares its size and gets a 400 it can read; only one
    // that says nothing, or lies, is cut off mid-upload.
    const declared = await call('/api/sessions', {
      token: bound.token,
      method: 'POST',
      raw: JSON.stringify({ cwd: 'x'.repeat(20_000) }),
      declareLength: true,
    });
    expect(declared.status).toBe(400);
    expect(declared.body).toMatchObject({ error: { code: 'API_REQUEST_INVALID' } });
    expect((declared.body as { error: { message: string } }).error.message).toContain('too large');
  });

  it('refuses a body over the cap before reading it all', async () => {
    const huge = await call('/api/sessions', {
      token: bound.token,
      method: 'POST',
      raw: JSON.stringify({ cwd: 'x'.repeat(20_000) }),
      declareLength: false,
    });
    // A reset, not a 400: the connection is dropped mid-upload, before the
    // body is whole. A 400 would mean it was read to the end and refused by
    // the schema instead — which the schema would do, for a different reason.
    expect(huge.status).toBe(0);
    expect((await call('/api/health', { token: bound.token })).status).toBe(200);
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

  it('mints a token owner-readable only, leaving nothing behind', () => {
    const token = ensureToken(dataDir, logger());
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(statSync(tokenPath(dataDir)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dataDir)).toStrictEqual(['token']);
  });

  it('never publishes a token file before it holds a token', () => {
    // Two daemons starting at once: one wins the exclusive publish and the
    // other reads what it wrote. Created at its final name and filled in
    // afterwards, the loser reads the gap — an empty file — and refuses to
    // start over a token that was merely still being written.
    ensureToken(dataDir, logger());
    const published = readFileSync(tokenPath(dataDir), 'utf8');

    // Every state the file is ever visible in, which is one.
    expect(published.trim()).not.toBe('');
    expect(ensureToken(dataDir, logger())).toBe(published.trim());
    expect(readdirSync(dataDir)).toStrictEqual(['token']);
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

  it('reports a data directory it did not create and finds readable by others', () => {
    // The store warns about the same directory on the same terms. Whichever of
    // the two runs first is the one that decides whether the user is told, so
    // silence in either is silence.
    const loose = join(dataDir, 'loose');
    mkdirSync(loose, { mode: 0o755 });

    ensureToken(loose, logger());
    expect(statSync(loose).mode & 0o777).toBe(0o755);
    expect(logs.map((record) => record.msg)).toContain(
      'the directory holding Interlock state is readable beyond its owner',
    );
  });

  it('sets the mode on a data directory it creates', () => {
    const fresh = join(dataDir, 'fresh', 'nested');
    ensureToken(fresh, logger());
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
  });

  it('refuses a token file that is a symlink rather than reading through it', () => {
    // Everything after the open acts on what was opened, so following one here
    // would tighten the mode of, and read, whatever it points at.
    const elsewhere = join(dataDir, 'elsewhere');
    writeFileSync(elsewhere, 'not-the-token\n', { mode: 0o600 });
    symlinkSync(elsewhere, tokenPath(dataDir));

    const log = logger();
    expect(() => ensureToken(dataDir, log)).toThrowError(/symlink/u);
  });

  it('refuses an empty token file rather than authenticating against nothing', () => {
    // A file that exists and holds nothing: no daemon wrote it, and reading it
    // as a valid token would authenticate an empty Authorization header.
    writeFileSync(tokenPath(dataDir), '  \n', { mode: 0o600 });

    const log = logger();
    expect(() => ensureToken(dataDir, log)).toThrowError(/empty/u);
  });
});
