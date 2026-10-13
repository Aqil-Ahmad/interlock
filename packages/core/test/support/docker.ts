import { spawnSync } from 'node:child_process';

/**
 * Whether the sandbox suite can run here, and why not when it cannot.
 *
 * The suite runs real containers, so it needs a reachable Docker daemon, the
 * test image, and a non-root user — the sandbox refuses to run for root. A
 * suite that skipped quietly would pass on any machine without Docker and
 * prove nothing, so a skip always carries its reason, and on Linux CI, where
 * Docker is always present, it is a failure instead.
 */

/**
 * Pinned by digest like the default image, so a republished tag cannot change
 * what the isolation tests run. Small, and carries `sh`, `node` and `/proc`.
 */
export const TEST_IMAGE =
  'node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402';

/** Pulling the image once can take a while on a cold runner. */
const PULL_TIMEOUT_MS = 5 * 60_000;

export interface SandboxSuiteStatus {
  /** Null when the suite can run; otherwise why it cannot. */
  readonly blocker: string | null;
  /** Linux CI must run the suite, so a blocker there fails rather than skips. */
  readonly mustRun: boolean;
}

function docker(args: readonly string[], timeout = 30_000): { ok: boolean; output: string } {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout });
  if (result.error !== undefined) return { ok: false, output: result.error.message };
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

/**
 * Probe once per file. The test image is pulled here when absent — by the
 * test, never by the runner, which only ever passes `--pull=never`.
 */
export function sandboxSuiteStatus(): SandboxSuiteStatus {
  const mustRun = process.platform === 'linux' && process.env.CI === 'true';
  if (process.getuid?.() === 0) {
    return { blocker: 'running as root, which the sandbox refuses', mustRun };
  }
  const version = docker(['version', '--format', '{{.Server.Version}}']);
  if (!version.ok) return { blocker: `Docker is unavailable: ${version.output}`, mustRun };
  if (!docker(['image', 'inspect', TEST_IMAGE]).ok) {
    const pulled = docker(['pull', TEST_IMAGE], PULL_TIMEOUT_MS);
    if (!pulled.ok) {
      return { blocker: `the test image could not be pulled: ${pulled.output}`, mustRun };
    }
  }
  return { blocker: null, mustRun };
}

/** Containers carrying an owner's label, running or not. */
export function labelledContainers(label: string): string[] {
  const listed = docker(['ps', '--all', '--quiet', '--filter', `label=${label}`]);
  return listed.output.split('\n').filter((id) => id !== '');
}

/** Remove everything carrying an owner's label: the cleanup that runs even when a test failed. */
export function removeLabelled(label: string): void {
  const ids = labelledContainers(label);
  if (ids.length > 0) docker(['rm', '--force', ...ids]);
}

/** Whether an image is present locally. */
export function imagePresent(image: string): boolean {
  return docker(['image', 'inspect', image]).ok;
}
