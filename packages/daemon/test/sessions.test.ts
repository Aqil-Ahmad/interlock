import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, ulid } from '@interlock/shared';
import type { BranchRef, BranchRefId, InterlockEvent, Repo, RepoId } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/bus/index.js';
import {
  createSessionRegistry,
  parseSessionRegistration,
  processExists,
  renderHookScripts,
} from '../src/hooks/index.js';
import type { SessionRegistration, SessionRegistry } from '../src/hooks/index.js';
import { openStore } from '../src/store/index.js';
import type { Store } from '../src/store/index.js';
import { rejection } from './support/rejection.js';

/**
 * The registry against a real store, because what it decides — which worktree
 * a hook ran in, whether a session is the same one or a new one, whether it is
 * still alive — is a comparison between what the hook said and what is written
 * down. Pids and the clock are the two process boundaries, and both are
 * injected so a test decides who is alive and what time it is.
 */

const STALE_MS = 10_000;

describe('agent sessions', () => {
  let store: Store;
  let bus: EventBus;
  let events: InterlockEvent[];
  let registry: SessionRegistry;
  let repo: Repo;
  let main: BranchRef;
  let feature: BranchRef;
  let alive: Set<number>;
  let clock: number;

  const registration = (overrides: Partial<SessionRegistration> = {}): SessionRegistration => ({
    event: 'start',
    kind: 'claude-code',
    externalSessionId: 'sess-1',
    cwd: '/work/repo/feature/src',
    pid: 100,
    branch: null,
    ...overrides,
  });

  const branch = (name: string, worktreePath: string | null): BranchRef => ({
    id: ulid<BranchRefId>(),
    repoId: repo.id,
    ref: `refs/heads/${name}`,
    name,
    headSha: 'a'.repeat(40),
    worktreePath,
    dirty: null,
    sessionId: null,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const of = (type: InterlockEvent['type']): InterlockEvent[] =>
    events.filter((event) => event.type === type);

  beforeEach(async () => {
    store = await openStore({ path: ':memory:' });
    events = [];
    const logger = createLogger('test', { level: 'error', sink: () => undefined });
    bus = new EventBus({ logger });
    bus.onAny((event) => {
      events.push(event);
    });
    alive = new Set([100, 200]);
    clock = Date.parse('2026-01-01T12:00:00.000Z');
    registry = createSessionRegistry({
      store,
      bus,
      logger,
      staleAfterMs: STALE_MS,
      isAlive: (pid) => alive.has(pid),
      now: () => clock,
    });

    const id = ulid<RepoId>();
    repo = await store.upsertRepo({
      id,
      rootPath: '/work/repo',
      defaultBranch: 'main',
      shadowPath: `/data/shadows/${id}`,
      config: {},
      discoveredAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
    });
    // Names chosen so that alphabetical order — which is how the store lists
    // them — is the wrong answer for every match below: the shallowest
    // worktree sorts first, and the deepest last.
    main = await store.upsertBranchRef(branch('aaa-main', '/work/repo'));
    feature = await store.upsertBranchRef(branch('zzz-feature', '/work/repo/feature'));
    // A worktree whose path is a prefix of another's by string but not by
    // segment, so the match has to be segment-aware.
    await store.upsertBranchRef(branch('mmm-other', '/work/repo/feature-two'));
  });

  afterEach(async () => {
    await store.close();
  });

  describe('registering', () => {
    it('attributes a hook to the deepest worktree its cwd is inside', async () => {
      const session = await registry.register(registration({ cwd: '/work/repo/feature/src' }));
      expect(session.repoId).toBe(repo.id);
      expect(session.branchRefId).toBe(feature.id);
      expect(session.attribution).toBe('inferred');
    });

    it('matches worktrees by segment, not by string prefix', async () => {
      // `/work/repo/feature` is a string prefix of `/work/repo/feature-three`
      // and nothing else about it: a hook there belongs to the main worktree.
      const session = await registry.register(registration({ cwd: '/work/repo/feature-three' }));
      expect(session.branchRefId).toBe(main.id);
    });

    it('matches a cwd through a symlink to the worktree the store knows', async () => {
      // The store holds what git reports, which is canonical; on macOS the
      // temp dir is reached through `/var`, a symlink to `/private/var`, and
      // an agent reports whichever it was launched in. Same directory, and it
      // must not compare as a different one.
      const scratch = mkdtempSync(join(tmpdir(), 'interlock-hook-'));
      try {
        const real = realpathSync(scratch);
        const alias = join(scratch, 'alias');
        symlinkSync(real, alias);
        await store.upsertBranchRef(branch('linked', join(real, 'wt')));
        const { mkdirSync } = await import('node:fs');
        mkdirSync(join(real, 'wt'));

        const session = await registry.register(
          registration({ externalSessionId: 'via-alias', cwd: join(alias, 'wt') }),
        );
        const named = (await store.listBranchRefs(repo.id)).find(
          (b) => b.id === session.branchRefId,
        );
        expect(named?.name).toBe('linked');
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });

    it('refuses a cwd outside every watched worktree', async () => {
      const error = await rejection(registry.register(registration({ cwd: '/elsewhere' })));
      expect(error.code).toBe('REPO_NOT_FOUND');
      expect(await store.listSessions(repo.id)).toStrictEqual([]);
    });

    it('records a branch the hook named as reported, and one it did not as inferred', async () => {
      const reported = await registry.register(registration({ branch: 'aaa-main' }));
      expect(reported.branchRefId).toBe(main.id);
      expect(reported.attribution).toBe('reported');

      const guessed = await registry.register(
        registration({ externalSessionId: 'sess-2', branch: null }),
      );
      expect(guessed.attribution).toBe('inferred');
    });

    it('falls back to inference when the named branch does not exist', async () => {
      const session = await registry.register(registration({ branch: 'no-such-branch' }));
      expect(session.branchRefId).toBe(feature.id);
      expect(session.attribution).toBe('inferred');
    });

    it('is the same session across start, activity and end', async () => {
      const started = await registry.register(registration({ event: 'start' }));
      clock += 1_000;
      const active = await registry.register(registration({ event: 'activity' }));
      clock += 1_000;
      const ended = await registry.register(registration({ event: 'end' }));

      expect(active.id).toBe(started.id);
      expect(ended.id).toBe(started.id);
      expect(started.startedAt).toBe(ended.startedAt);
      expect(ended.lastActiveAt).not.toBe(started.lastActiveAt);
      expect(ended.endedAt).not.toBeNull();
      expect(await store.listSessions(repo.id)).toHaveLength(1);
      expect(of('session.registered')).toHaveLength(1);
      expect(of('session.ended')).toHaveLength(1);
    });

    it('registers on whichever event arrives first', async () => {
      // A `start` that fired before the sweep listed the worktree is lost; the
      // first activity that finds it must be enough.
      const session = await registry.register(registration({ event: 'activity' }));
      expect(session.endedAt).toBeNull();
      expect(of('session.registered')).toHaveLength(1);
    });

    it('does not resurrect an ended session when its id comes back', async () => {
      const first = await registry.register(registration({ event: 'start' }));
      await registry.register(registration({ event: 'end' }));

      const again = await registry.register(registration({ event: 'start' }));
      expect(again.id).not.toBe(first.id);
      const rows = await store.listSessions(repo.id);
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.id === first.id)?.endedAt).not.toBeNull();
    });

    it('makes the branch report its owner through the store', async () => {
      const session = await registry.register(registration());
      const branches = await store.listBranchRefs(repo.id);
      expect(branches.find((b) => b.id === feature.id)?.sessionId).toBe(session.id);
      expect(branches.find((b) => b.id === main.id)?.sessionId).toBeNull();
    });
  });

  describe('liveness', () => {
    it('drops a session whose process is gone, at the next read', async () => {
      const session = await registry.register(registration({ pid: 100 }));
      alive.delete(100);

      expect(await registry.listLive(repo.id)).toStrictEqual([]);
      // Ended in the store too, so the branch's owner is not a dead agent.
      const rows = await store.listSessions(repo.id);
      expect(rows.find((row) => row.id === session.id)?.endedAt).not.toBeNull();
      expect(of('session.ended')).toHaveLength(1);
      expect(
        (await store.listBranchRefs(repo.id)).find((b) => b.id === feature.id)?.sessionId,
      ).toBeNull();
    });

    it('drops a session whose heartbeat is stale, however alive its process', async () => {
      await registry.register(registration({ pid: 100 }));
      clock += STALE_MS;
      expect(await registry.listLive(repo.id)).toStrictEqual([]);
    });

    it('keeps a session that is alive and recent', async () => {
      const session = await registry.register(registration({ pid: 100 }));
      clock += STALE_MS - 1;
      expect((await registry.listLive(repo.id)).map((s) => s.id)).toStrictEqual([session.id]);
    });

    it('does not let a reused pid keep a dead session alive', async () => {
      // The process died and its pid went to something else: the pid check
      // passes and only the heartbeat says otherwise.
      await registry.register(registration({ pid: 100 }));
      clock += STALE_MS;
      expect(alive.has(100)).toBe(true);
      expect(await registry.listLive(repo.id)).toStrictEqual([]);
    });

    it('does not resurrect an ended session for a pid that is alive again', async () => {
      const session = await registry.register(registration({ pid: 100 }));
      alive.delete(100);
      await registry.listLive(repo.id);
      alive.add(100);

      expect(await registry.listLive(repo.id)).toStrictEqual([]);
      expect(
        (await store.listSessions(repo.id)).find((r) => r.id === session.id)?.endedAt,
      ).not.toBeNull();
    });

    it('lives and dies by the heartbeat alone when no pid was recorded', async () => {
      const session = await registry.register(registration({ pid: 100 }));
      await store.upsertSession({ ...session, pid: null });
      alive.clear();
      expect((await registry.listLive(repo.id)).map((s) => s.id)).toStrictEqual([session.id]);
      clock += STALE_MS;
      expect(await registry.listLive(repo.id)).toStrictEqual([]);
    });

    it('reaps across every repository and counts what it ended', async () => {
      await registry.register(registration({ externalSessionId: 'a', pid: 100 }));
      await registry.register(registration({ externalSessionId: 'b', pid: 200 }));
      alive.delete(200);
      expect(await registry.reap()).toBe(1);
      expect(await registry.reap()).toBe(0);
    });
  });

  describe('the payload', () => {
    const problemsOf = (body: unknown): string[] => {
      try {
        parseSessionRegistration(body);
      } catch (error) {
        return (error as { details: { problems: string[] } }).details.problems;
      }
      throw new Error('expected the payload to be refused');
    };

    it('accepts the shape interlock hook sends', () => {
      expect(parseSessionRegistration(registration())).toStrictEqual(registration());
      expect(parseSessionRegistration({ ...registration(), branch: undefined })).toMatchObject({
        branch: null,
      });
    });

    it('refuses anything that is not an object', () => {
      for (const body of [null, 'x', 5, [], undefined]) {
        expect(() => parseSessionRegistration(body)).toThrowError(/JSON object/u);
      }
    });

    it('refuses an unknown key and names it', () => {
      const problems = problemsOf({ ...registration(), extra: 1 });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('`extra`');
    });

    it('refuses every wrong type at once', () => {
      const problems = problemsOf({
        event: 'begin',
        kind: 'skynet',
        externalSessionId: '',
        cwd: 'relative/path',
        pid: -1,
        branch: '',
      });
      expect(problems).toHaveLength(6);
    });

    it('bounds the strings an agent chooses', () => {
      expect(problemsOf({ ...registration(), externalSessionId: 'x'.repeat(257) })).toHaveLength(1);
      expect(problemsOf({ ...registration(), cwd: `/${'x'.repeat(4_096)}` })).toHaveLength(1);
      expect(problemsOf({ ...registration(), branch: 'x'.repeat(257) })).toHaveLength(1);
    });

    it('refuses a pid that is not a positive integer', () => {
      for (const pid of [0, 1.5, '100', NaN]) {
        expect(problemsOf({ ...registration(), pid })).toStrictEqual([
          'pid must be a positive integer',
        ]);
      }
    });
  });
});

describe('processExists', () => {
  // The one function here that asks the operating system, and the one every
  // other test replaces. Two answers it must give, and the third is the subtle
  // half: a process that belongs to someone else refuses the signal with
  // `EPERM`, and is still a process.
  it('sees this process', () => {
    expect(processExists(process.pid)).toBe(true);
  });

  it('does not see a pid nothing holds', () => {
    expect(processExists(2_147_483_647)).toBe(false);
  });

  it('counts a process it may not signal as existing', () => {
    // pid 1 is always there and, for anyone but root, always refuses.
    expect(processExists(1)).toBe(true);
  });
});

describe('renderHookScripts', () => {
  it('names the command and nothing a repository must not hold', () => {
    const files = renderHookScripts('claude-code');
    const text = files['.claude/settings.json'] ?? '';
    const settings = JSON.parse(text) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks).sort()).toStrictEqual([
      'PostToolUse',
      'SessionEnd',
      'SessionStart',
      'UserPromptSubmit',
    ]);
    expect(text).toContain('interlock hook start --kind claude-code --pid $PPID');
    expect(text).toContain('interlock hook end --kind claude-code --pid $PPID');
    // The fragment lives in the repository, which the agents read and commit.
    expect(text).not.toMatch(/token/iu);
    expect(text).not.toMatch(/127\.0\.0\.1|localhost|:\d{4,5}/u);
  });

  it('refuses an agent whose format it does not know', () => {
    expect(() => renderHookScripts('codex')).toThrowError(/No hook format/u);
  });
});
