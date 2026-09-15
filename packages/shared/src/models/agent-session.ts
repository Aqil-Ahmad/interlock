import type { AgentSessionId, BranchRefId, RepoId } from '../ids.js';

/**
 * Which tool is driving a branch.
 *
 * Populated by agent hook scripts where available, inferred best-effort
 * otherwise.
 */
export const AGENT_KINDS = ['claude-code', 'codex', 'cursor', 'human', 'unknown'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * How the session's branch became known.
 *
 * `reported` means the hook named it; `inferred` means it was derived from the
 * working directory the hook ran in. The advisor may say less about an inferred
 * one, which is why the difference is stored rather than collapsed.
 */
/**
 * Bounds on the two strings an agent chooses in a session hook.
 *
 * In `shared` because both sides of the wire check them: the daemon refuses a
 * payload past them, and the client refuses locally first, so an oversized id
 * is a message rather than a connection dropped mid-upload.
 */
export const MAX_SESSION_ID_LENGTH = 256;
export const MAX_SESSION_PATH_LENGTH = 4_096;

export const SESSION_ATTRIBUTIONS = ['reported', 'inferred'] as const;
export type SessionAttribution = (typeof SESSION_ATTRIBUTIONS)[number];

export interface AgentSession {
  readonly id: AgentSessionId;
  readonly repoId: RepoId;
  readonly kind: AgentKind;
  /** Tool-provided session identifier, when the tool exposes one. */
  readonly externalSessionId: string | null;
  readonly branchRefId: BranchRefId | null;
  readonly attribution: SessionAttribution;
  /** Working directory the session was launched in. */
  readonly cwd: string | null;
  /**
   * The agent's process, for liveness. `null` for a session nothing reported a
   * pid for, which then lives and dies by its heartbeat alone.
   */
  readonly pid: number | null;
  readonly startedAt: string;
  /** Last heartbeat or observed activity; drives liveness. */
  readonly lastActiveAt: string;
  readonly endedAt: string | null;
}

/** A session is live if it has not ended and was active recently. */
export function isLive(session: AgentSession, now: number, staleAfterMs = 5 * 60_000): boolean {
  if (session.endedAt !== null) return false;
  return now - Date.parse(session.lastActiveAt) < staleAfterMs;
}
