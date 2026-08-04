import { notImplemented } from '@interlock/shared';
import type { AgentKind } from '@interlock/shared';

/**
 * Agent session registration: how Interlock learns who is editing what.
 *
 * Agent hooks post session metadata here on start/stop and around tool use.
 * Detection is best-effort — without hooks the watcher still sees the branch,
 * it just cannot attribute it, and everything except agent-targeted advice
 * keeps working.
 *
 * The session ↔ branch mapping is a durable record, not a cache.
 */

export interface SessionRegistration {
  readonly kind: AgentKind;
  readonly externalSessionId: string;
  readonly cwd: string;
  readonly branch: string | null;
  readonly startedAt: string;
}

/** Handle a hook callback from an agent tool. */
export function registerSession(_registration: SessionRegistration): Promise<void> {
  return notImplemented('registerSession', 'M1');
}

/** Generate the hook scripts `interlock init` installs into a repo. */
export function renderHookScripts(_daemonUrl: string, _token: string): Record<string, string> {
  return notImplemented('renderHookScripts', 'M1');
}
