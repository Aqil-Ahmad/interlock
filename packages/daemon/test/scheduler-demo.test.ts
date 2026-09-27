import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, silentLogger, tokenPath } from '@interlock/shared';
import type { EventRecord, Finding, SpanEvidence } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDaemon } from '../src/daemon.js';
import type { Daemon } from '../src/daemon.js';
import { openStore } from '../src/store/index.js';

/**
 * The milestone's demo, automated: two agent sessions edit the same function
 * on two branches, neither commits, and the daemon raises a textual Finding
 * inside the 60-second budget.
 *
 * Nothing is shortened for the test: the scheduler debounces at its default,
 * and the watcher's timer is the daemon's own, so the edits are noticed the
 * way they would be on a developer's machine — by the filesystem watch.
 */
describe('two live sessions editing the same function', () => {
  let base: string;
  let dataDir: string;
  let root: string;
  let daemon: Daemon;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' });

  const post = (path: string, body: unknown): Promise<number> =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const outgoing = request(
        {
          host: '127.0.0.1',
          port: daemon.runtime!.port,
          path,
          method: 'POST',
          headers: {
            authorization: `Bearer ${readFileSync(tokenPath(dataDir), 'utf8').trim()}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (response) => {
          response.resume();
          response.on('end', () => {
            resolve(response.statusCode ?? 0);
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.end(payload);
    });

  /** A second connection: the daemon holds its own, and the log is append-only. */
  const read = async <T>(query: (store: Awaited<ReturnType<typeof openStore>>) => Promise<T>) => {
    const store = await openStore({ path: join(dataDir, 'interlock.db') });
    try {
      return await query(store);
    } finally {
      await store.close();
    }
  };

  const events = (): Promise<EventRecord[]> =>
    read(async (store) => {
      const records: EventRecord[] = [];
      for await (const record of store.readEvents()) records.push(record);
      return records;
    });

  const source = (body: string): string =>
    ['export function total(items) {', `  return ${body};`, '}', ''].join('\n');

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-demo-')));
    dataDir = join(base, 'data');
    root = join(base, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
    git(root, 'config', 'user.name', 'Interlock Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'maintenance.auto', 'false');
    git(root, 'config', 'gc.auto', '0');
    writeFileSync(join(root, 'total.ts'), source('items.length'));
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    git(root, 'worktree', 'add', '-q', '-b', 'agent-a', join(base, 'a'));
    git(root, 'worktree', 'add', '-q', '-b', 'agent-b', join(base, 'b'));

    daemon = createDaemon({
      config: resolveConfig({ dataDir, repos: [root], daemon: { port: 0 } }),
      logger: silentLogger,
    });
  });

  afterEach(async () => {
    await daemon.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('raises a textual Finding within 60 seconds, traceable to the edit', async () => {
    await daemon.start();
    for (const [name, cwd] of [
      ['agent-a', join(base, 'a')],
      ['agent-b', join(base, 'b')],
    ] as const) {
      const status = await post('/api/sessions', {
        event: 'start',
        kind: 'claude-code',
        externalSessionId: name,
        cwd,
        pid: process.pid,
      });
      expect(status).toBe(200);
    }

    const editedAt = Date.now();
    writeFileSync(join(base, 'a', 'total.ts'), source('items.reduce((n, i) => n + i.price, 0)'));
    writeFileSync(join(base, 'b', 'total.ts'), source('items.filter(Boolean).length'));

    let raised: EventRecord | undefined;
    while (raised === undefined) {
      if (Date.now() - editedAt > 60_000) throw new Error('no Finding within 60 seconds');
      raised = (await events()).find((record) => record.type === 'finding.raised');
      if (raised === undefined) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const elapsed = Date.now() - editedAt;
    expect(elapsed).toBeLessThan(60_000);

    const payload = raised.payload as Extract<EventRecord['payload'], { type: 'finding.raised' }>;
    const finding = await read((store) => store.getFinding(payload.findingId));
    expect(finding).toMatchObject<Partial<Finding>>({
      kind: 'textual',
      rule: 'overlapping-edit',
      status: 'open',
    });
    const spans = finding!.evidence.filter((e): e is SpanEvidence => e.type === 'span');
    expect(spans.map((span) => [span.path, span.startLine])).toEqual([
      ['total.ts', 2],
      ['total.ts', 2],
    ]);

    // From the Finding back to what the watcher saw: every step names its cause.
    const log = await events();
    const byId = new Map(log.map((record) => [record.id, record]));
    const chain: string[] = [];
    for (let at: EventRecord | undefined = raised; at !== undefined;) {
      chain.push(at.type);
      at = at.causedBy === null ? undefined : byId.get(at.causedBy);
    }
    expect(chain.slice(0, 5)).toEqual([
      'finding.raised',
      'run.analyzer-completed',
      'run.merge-completed',
      'run.started',
      'pair.scheduled',
    ]);
    expect(chain[5]).toMatch(/^branch\./u);
  }, 90_000);
});
