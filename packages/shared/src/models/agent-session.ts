import type { AgentSessionId, BranchRefId, RepoId } from '../ids.js';

/**
 * Which tool is driving a branch.
 *
 * Populated by agent hook scripts where available, inferred best-effort
 * otherwise.
 */
export type AgentKind = 'claude-code' | 'codex' | 'cursor' | 'human' | 'unknown';

export interface AgentSession {
  readonly id: AgentSessionId;
  readonly repoId: RepoId;
  readonly kind: AgentKind;
  /** Tool-provided session identifier, when the tool exposes one. */
  readonly externalSessionId: string | null;
  readonly branchRefId: BranchRefId | null;
  /** Working directory the session was launched in. */
  readonly cwd: string | null;
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
