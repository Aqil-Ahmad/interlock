import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import {
  AGENT_KINDS,
  InterlockError,
  MAX_SESSION_ID_LENGTH,
  MAX_SESSION_PATH_LENGTH,
  ulid,
} from '@interlock/shared';
import type {
  AgentKind,
  AgentSession,
  AgentSessionId,
  BranchRef,
  Logger,
  Repo,
  RepoId,
} from '@interlock/shared';
import type { EventBus } from '../bus/index.js';
import type { Store } from '../store/index.js';

/**
 * Agent session registration: how Interlock learns who is editing what.
 *
 * Agent hooks post here on start, on activity and on end. Detection is
 * best-effort — without hooks the watcher still sees the branch, it just cannot
 * attribute it, and everything except agent-targeted advice keeps working.
 *
 * A session is a claim the agent makes about itself, never proof. The payload
 * comes from a process Interlock does not control, so every field is checked
 * and an unknown one is refused; the working directory is matched against
 * worktrees the store already knows rather than asked of git, since a hook
 * fires on every tool call; and a session's branch records whether the hook
 * named it or it was inferred from where the hook ran.
 *
 * The session ↔ branch mapping is a durable record, not a cache.
 */

export const SESSION_EVENTS = ['start', 'activity', 'end'] as const;
export type SessionEvent = (typeof SESSION_EVENTS)[number];

export interface SessionRegistration {
  readonly event: SessionEvent;
  readonly kind: AgentKind;
  readonly externalSessionId: string;
  readonly cwd: string;
  /** The agent's process, for liveness. */
  readonly pid: number;
  /** Named by the hook when it knows; inferred from `cwd` when it does not. */
  readonly branch: string | null;
}

export interface SessionRegistryOptions {
  readonly store: Store;
  readonly bus: EventBus;
  readonly logger: Logger;
  /** A heartbeat older than this means the session is gone, whatever its pid says. */
  readonly staleAfterMs: number;
  /** Injectable so a test can decide which pids are alive. */
  readonly isAlive?: (pid: number) => boolean;
  readonly now?: () => number;
}

export interface SessionRegistry {
  /**
   * Record a hook event, creating the session on first sight.
   *
   * Every event creates or updates: a `start` that arrived before the sweep
   * listed the worktree is not the only chance, and the first event that finds
   * its worktree is the one that registers.
   *
   * @throws InterlockError `REPO_NOT_FOUND` when `cwd` is inside no watched
   *         worktree — a session for a repository nobody watches has nothing to
   *         attribute.
   */
  register(registration: SessionRegistration): Promise<AgentSession>;
  /** Live sessions in one repository, reaping the dead on the way. */
  listLive(repoId: RepoId): Promise<AgentSession[]>;
  /** Reap every repository. Returns how many sessions were ended. */
  reap(): Promise<number>;
}

/** Fields a registration may carry, and nothing else. */
const REGISTRATION_KEYS = ['event', 'kind', 'externalSessionId', 'cwd', 'pid', 'branch'] as const;

/**
 * Check a hook payload against the schema.
 *
 * Refuses an unknown key for the reason the config parser does — a typo that
 * quietly does nothing is indistinguishable from a field that was never sent —
 * and with more force, since this comes from a process that is not Interlock.
 *
 * @throws InterlockError `API_REQUEST_INVALID` listing every problem at once.
 */
export function parseSessionRegistration(body: unknown): SessionRegistration {
  const problems: string[] = [];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid(['payload must be a JSON object']);
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(REGISTRATION_KEYS as readonly string[]).includes(key)) {
      problems.push(`unknown key \`${key}\`; expected only ${REGISTRATION_KEYS.join(', ')}`);
    }
  }

  const event = record.event;
  if (!(SESSION_EVENTS as readonly unknown[]).includes(event)) {
    problems.push(`event must be one of ${SESSION_EVENTS.join(', ')}`);
  }
  const kind = record.kind;
  if (!(AGENT_KINDS as readonly unknown[]).includes(kind)) {
    problems.push(`kind must be one of ${AGENT_KINDS.join(', ')}`);
  }
  const externalSessionId = record.externalSessionId;
  if (typeof externalSessionId !== 'string' || externalSessionId === '') {
    problems.push('externalSessionId must be a non-empty string');
  } else if (externalSessionId.length > MAX_SESSION_ID_LENGTH) {
    problems.push(`externalSessionId is longer than ${String(MAX_SESSION_ID_LENGTH)} characters`);
  }
  const cwd = record.cwd;
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
    // Relative to what? The hook's process, which is not this one.
    problems.push('cwd must be an absolute path');
  } else if (cwd.length > MAX_SESSION_PATH_LENGTH) {
    problems.push(`cwd is longer than ${String(MAX_SESSION_PATH_LENGTH)} characters`);
  }
  const pid = record.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    problems.push('pid must be a positive integer');
  }
  const branch = record.branch ?? null;
  if (branch !== null && (typeof branch !== 'string' || branch === '')) {
    problems.push('branch must be a non-empty string when present');
  } else if (typeof branch === 'string' && branch.length > MAX_SESSION_ID_LENGTH) {
    problems.push(`branch is longer than ${String(MAX_SESSION_ID_LENGTH)} characters`);
  }

  if (problems.length > 0) throw invalid(problems);
  return {
    event: event as SessionEvent,
    kind: kind as AgentKind,
    externalSessionId: externalSessionId as string,
    cwd: cwd as string,
    pid: pid as number,
    branch: branch as string | null,
  };
}

function invalid(problems: string[]): InterlockError {
  return new InterlockError('API_REQUEST_INVALID', `Invalid session hook: ${problems.join('; ')}`, {
    details: { problems },
    remedy: 'Send the payload `interlock hook` sends; the hook is not meant to be hand-written.',
  });
}

/**
 * Whether a process exists.
 *
 * Signal 0 delivers nothing and answers only whether the pid is there. `ESRCH`
 * is no such process; `EPERM` is a process that belongs to someone else, which
 * is still a process, though not one an agent of this user should have. Both
 * the daemon and the agent run as the user, so the second does not arise.
 */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

interface Worktree {
  readonly repo: Repo;
  readonly branch: BranchRef;
}

export function createSessionRegistry(options: SessionRegistryOptions): SessionRegistry {
  const log = options.logger.child('sessions');
  const { store, bus, staleAfterMs } = options;
  const isAlive = options.isAlive ?? processExists;
  const now = options.now ?? Date.now;

  /**
   * The worktree a directory is inside, longest match first.
   *
   * Segment-aware: `/work/repo` is not a prefix of `/work/repo-two`. Matched
   * against what the store knows rather than asked of git, because a hook
   * fires on every tool call and a `rev-parse` per call is the watcher's whole
   * idle budget spent on attribution.
   */
  const worktreeOf = async (reported: string): Promise<Worktree | null> => {
    // Canonical before comparing, as the runner and the watcher already do:
    // the store holds what git reports, and on macOS `/var/…` is a symlink to
    // `/private/var/…`, so the same directory compares as a different one and
    // the session is silently never registered. A path that does not exist
    // stays as it is and matches nothing, which is the right answer for it.
    let cwd = reported;
    try {
      cwd = realpathSync(reported);
    } catch {
      // Left as reported.
    }
    let best: Worktree | null = null;
    for (const repo of await store.listRepos()) {
      for (const branch of await store.listBranchRefs(repo.id)) {
        const root = branch.worktreePath;
        if (root === null) continue;
        if (cwd !== root && !cwd.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) continue;
        if (best === null || root.length > (best.branch.worktreePath?.length ?? 0)) {
          best = { repo, branch };
        }
      }
    }
    return best;
  };

  /** For a session that has not ended; the sweep never asks about one that has. */
  const isLive = (session: AgentSession, at: number): boolean => {
    if (at - Date.parse(session.lastActiveAt) >= staleAfterMs) return false;
    return session.pid === null || isAlive(session.pid);
  };

  const end = async (session: AgentSession, at: number): Promise<void> => {
    await store.upsertSession({ ...session, endedAt: new Date(at).toISOString() });
    await bus.publish({
      type: 'session.ended',
      repoId: session.repoId,
      at: new Date(at).toISOString(),
      sessionId: session.id,
    });
  };

  /** Live sessions, with the dead ones ended in passing. */
  const sweep = async (repoId: RepoId): Promise<{ live: AgentSession[]; ended: number }> => {
    const at = now();
    const live: AgentSession[] = [];
    let ended = 0;
    for (const session of await store.listSessions(repoId)) {
      if (session.endedAt !== null) continue;
      if (isLive(session, at)) {
        live.push(session);
        continue;
      }
      // Written, not merely filtered: the store derives a branch's owner from
      // sessions that have not ended, and it knows nothing about pids.
      await end(session, at);
      ended += 1;
    }
    return { live, ended };
  };

  return {
    async register(registration: SessionRegistration): Promise<AgentSession> {
      const found = await worktreeOf(registration.cwd);
      if (found === null) {
        throw new InterlockError('REPO_NOT_FOUND', 'The hook ran outside every watched worktree', {
          details: { cwd: registration.cwd },
          remedy:
            'Add the repository to the daemon configuration, or run the agent inside a worktree it watches.',
        });
      }
      const { repo } = found;

      // The branch the hook named, when it named one and it exists; otherwise
      // the branch checked out where the hook ran, which is a guess rather
      // than a report and is recorded as one.
      let branchRefId = found.branch.id;
      let attribution: AgentSession['attribution'] = 'inferred';
      if (registration.branch !== null) {
        const named = (await store.listBranchRefs(repo.id)).find(
          (branch) => branch.name === registration.branch,
        );
        branchRefId = named?.id ?? found.branch.id;
        attribution = named === undefined ? 'inferred' : 'reported';
      }

      const at = now();
      const stamp = new Date(at).toISOString();
      // The same session again is the one that has not ended. An ended row
      // with this id is history, and a later hook from it is a new session:
      // nothing resurrects a session, whatever pid it turns up with.
      const existing = (await store.listSessions(repo.id)).find(
        (session) =>
          session.endedAt === null &&
          session.kind === registration.kind &&
          session.externalSessionId === registration.externalSessionId,
      );

      const session: AgentSession = {
        id: existing?.id ?? ulid<AgentSessionId>(),
        repoId: repo.id,
        kind: registration.kind,
        externalSessionId: registration.externalSessionId,
        branchRefId,
        attribution,
        cwd: registration.cwd,
        pid: registration.pid,
        startedAt: existing?.startedAt ?? stamp,
        lastActiveAt: stamp,
        endedAt: registration.event === 'end' ? stamp : null,
      };
      await store.upsertSession(session);

      if (existing === undefined) {
        await bus.publish({
          type: 'session.registered',
          repoId: repo.id,
          at: stamp,
          sessionId: session.id,
          kind: session.kind,
          branchRefId: session.branchRefId,
        });
      }
      if (registration.event === 'end') {
        await bus.publish({
          type: 'session.ended',
          repoId: repo.id,
          at: stamp,
          sessionId: session.id,
        });
      }
      log.debug('session hook', {
        event: registration.event,
        kind: registration.kind,
        attribution,
        sessionId: session.id,
      });
      return session;
    },

    async listLive(repoId: RepoId): Promise<AgentSession[]> {
      return (await sweep(repoId)).live;
    },

    async reap(): Promise<number> {
      let ended = 0;
      for (const repo of await store.listRepos()) ended += (await sweep(repo.id)).ended;
      if (ended > 0) log.info('reaped agent sessions', { ended });
      return ended;
    },
  };
}

/**
 * The settings fragment an agent tool installs so its sessions report here.
 *
 * Not a script, and carrying neither the token nor the port: a hook file lives
 * in the repository, which the agents read and commit, so anything written
 * into it is published. The command it names finds the daemon the way every
 * other client does, from the data dir, at run time.
 *
 * Claude Code's format is the one known. Others are the responsibility of
 * whatever installs this, once it exists.
 */
export function renderHookScripts(kind: AgentKind): Record<string, string> {
  if (kind !== 'claude-code') {
    throw new InterlockError('CONFIG_INVALID', `No hook format is known for ${kind}`, {
      details: { kind },
      remedy: 'Only claude-code hooks are rendered.',
    });
  }
  // `$PPID` is expanded by the shell the agent runs the command in, and is
  // that shell's parent: the agent. Without it the hook would record the
  // shell, which is gone the moment the hook returns.
  const command = (event: SessionEvent): unknown => [
    {
      hooks: [
        { type: 'command', command: `interlock hook ${event} --kind claude-code --pid $PPID` },
      ],
    },
  ];
  const settings = {
    hooks: {
      SessionStart: command('start'),
      UserPromptSubmit: command('activity'),
      PostToolUse: command('activity'),
      SessionEnd: command('end'),
    },
  };
  return { '.claude/settings.json': `${JSON.stringify(settings, null, 2)}\n` };
}
