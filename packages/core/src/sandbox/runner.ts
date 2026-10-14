import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { InterlockError, redact, silentLogger } from '@interlock/shared';
import type { Logger, SandboxConfig } from '@interlock/shared';
import {
  DEFAULT_PIDS_LIMIT,
  PIDS_EVENTS_FILES,
  SANDBOX_LABEL,
  TREE_TARGET,
  assertOwner,
  classifyDockerFailure,
  classifyRun,
  containerUser,
  createArgs,
  parseContainerState,
  pidsLimitHit,
  planMounts,
  unavailable,
} from './docker-args.js';
import type { PlannedMount, ResolvedSource, SandboxMount } from './docker-args.js';

/**
 * The Docker sandbox: the only way Interlock runs merged code.
 *
 * Docker is driven through its CLI with `execFile` and `spawn` and argument
 * arrays — never a shell on the host, and no client library in `core`. Each
 * run creates a container, attaches to it, reads its state and removes it, on
 * every path. Nothing here falls back to the host and nothing pulls an image.
 */

export interface SandboxRunRequest {
  /** The merged tree on the host, mounted read-only at `/work`. */
  readonly tree: string;
  /** The command, as an argument array. A command string goes through `shellCommand`. */
  readonly argv: readonly string[];
  /** Further bind mounts — dependencies read-only under `/work`, a cache under `/cache`. */
  readonly mounts?: readonly SandboxMount[];
  /** The only directory writable mounts may come from. */
  readonly cacheRoot?: string;
  /** Container path to run in; `/work` by default. */
  readonly workdir?: string;
  /** Kills the container. The run then rejects with `REQUEST_CANCELLED`. */
  readonly signal?: AbortSignal;
}

/**
 * A command that ran to its own exit, whatever the code. A non-zero exit is a
 * result: what it means is the analyzer's call, not the sandbox's.
 *
 * Output is capped, decoded as UTF-8 and redacted before it is returned,
 * because it is on its way to becoming evidence.
 */
export interface SandboxResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
}

export interface SandboxRunner {
  /**
   * Run a command in a fresh container.
   *
   * Rejects with `SANDBOX_UNAVAILABLE` when Docker cannot run it,
   * `SANDBOX_TIMEOUT` at the wall-clock limit, `SANDBOX_LIMIT` at the memory or
   * PID limit, `SANDBOX_REFUSED` for a mount the rules forbid, and
   * `REQUEST_CANCELLED` when the signal fires. None of those is a verdict on
   * the code.
   */
  run(request: SandboxRunRequest): Promise<SandboxResult>;
  /**
   * Remove every container this owner's label marks: what a crashed daemon
   * left. Meant for start-up, before any run, since it removes running ones
   * too. Returns how many were removed.
   */
  reapOrphans(): Promise<number>;
}

export interface SandboxRunnerOptions {
  readonly config: SandboxConfig;
  /**
   * Names whose containers these are, in their label. One per data directory,
   * so a daemon reaps its own leftovers and never another's live runs.
   */
  readonly owner: string;
  readonly pidsLimit?: number;
  /** Per stream; output past it is dropped and flagged. */
  readonly maxOutputBytes?: number;
  /** Resolved from `PATH` by default; overridden in tests to force a failure. */
  readonly dockerPath?: string;
  /** Docker's own default when absent. */
  readonly dockerHost?: string;
  readonly logger?: Logger;
}

/** Enough for a compiler's or a test runner's report; a log flood past it says nothing more. */
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * For the short Docker calls around a run — inspect, create, kill, remove.
 * Long enough for a busy daemon, short enough that a wedged one cannot hold a
 * check forever.
 */
const DOCKER_CALL_TIMEOUT_MS = 30_000;

/**
 * For reading the pids evidence before a timed-out container is killed. The
 * kill waits on it, and the evidence only names which limit was hit, so it is
 * not worth stretching the wall clock by a full call timeout on a slow daemon.
 */
const DIAGNOSTIC_CALL_TIMEOUT_MS = 5_000;

interface DockerCallResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function cancelled(): InterlockError {
  return new InterlockError('REQUEST_CANCELLED', 'The sandbox run was stopped', {
    remedy: 'None needed: the caller asked for it to stop.',
  });
}

async function resolveSource(path: string): Promise<ResolvedSource> {
  let realPath: string;
  try {
    realPath = await realpath(path);
  } catch (error) {
    throw new InterlockError('SANDBOX_REFUSED', 'A sandbox mount source does not exist', {
      details: { source: path, reason: (error as NodeJS.ErrnoException).code ?? null },
      remedy: 'Materialise the tree, or the mounted directory, before running.',
    });
  }
  const stats = await lstat(realPath);
  const kind = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
  return { realPath, kind };
}

/**
 * Every mount nested in the tree needs its mount point to exist there already,
 * as a real directory or file of the same kind as its source.
 *
 * Docker creates a missing mount point by writing it into the source of the
 * mount above — the slot — and with the tree read-only it cannot, so the run
 * would fail at start with an error naming neither cause. A mount point
 * reached through a symlink is refused too: the tree is merged code, and a
 * link there chooses where in the container the mount lands.
 */
async function assertMountPoints(tree: string, planned: readonly PlannedMount[]): Promise<void> {
  for (const mount of planned) {
    if (!mount.target.startsWith(`${TREE_TARGET}/`)) continue;
    const point = join(tree, ...mount.target.slice(TREE_TARGET.length + 1).split('/'));
    const source = await lstat(mount.source);
    let real: string | null = null;
    let matches = false;
    try {
      real = await realpath(point);
      const stats = await lstat(real);
      matches = source.isDirectory() ? stats.isDirectory() : stats.isFile();
    } catch {
      // Missing: refused below like a mismatch.
    }
    if (real !== point || !matches) {
      throw new InterlockError(
        'SANDBOX_REFUSED',
        'A sandbox mount has no mount point in the tree',
        {
          details: { target: mount.target },
          remedy:
            'Create the mount point in the tree, as a plain directory or file matching its source, before running.',
        },
      );
    }
  }
}

/** Keeps the first `limit` bytes of a stream and notes whether more came. */
class CappedStream {
  private readonly chunks: Buffer[] = [];
  private kept = 0;
  private readonly limit: number;
  truncated = false;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    const room = this.limit - this.kept;
    if (chunk.length > room) this.truncated = true;
    if (room <= 0) return;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(part);
    this.kept += part.length;
  }

  text(): string {
    return redact(Buffer.concat(this.chunks).toString('utf8'));
  }
}

export function createSandboxRunner(options: SandboxRunnerOptions): SandboxRunner {
  assertOwner(options.owner);
  const { config, owner } = options;
  const dockerPath = options.dockerPath ?? 'docker';
  const pidsLimit = options.pidsLimit ?? DEFAULT_PIDS_LIMIT;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const log = (options.logger ?? silentLogger).child('sandbox');
  // The client's own environment, so its context and credential helpers work.
  // `docker run` forwards none of it into the container without `-e`.
  const env: NodeJS.ProcessEnv =
    options.dockerHost === undefined
      ? process.env
      : { ...process.env, DOCKER_HOST: options.dockerHost };

  function notInstalled(): InterlockError {
    log.error('docker not found', { dockerPath });
    return unavailable('not-installed', { dockerPath });
  }

  function docker(
    args: readonly string[],
    timeoutMs = DOCKER_CALL_TIMEOUT_MS,
  ): Promise<DockerCallResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        dockerPath,
        args,
        { env, timeout: timeoutMs, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ stdout, stderr, exitCode: 0 });
            return;
          }
          const failure = error as NodeJS.ErrnoException & { killed?: boolean };
          if (failure.code === 'ENOENT') {
            reject(notInstalled());
            return;
          }
          if (typeof failure.code === 'number') {
            resolve({ stdout, stderr, exitCode: failure.code });
            return;
          }
          log.error('docker did not answer', {
            command: args[0] ?? null,
            killed: failure.killed === true,
          });
          reject(
            unavailable('docker-failed', {
              command: args[0] ?? null,
              timeoutMs,
            }),
          );
        },
      );
      child.stdin?.end();
    });
  }

  function failedCall(command: string, result: DockerCallResult): InterlockError {
    const reason = classifyDockerFailure(result.stderr);
    const stderr = redact(result.stderr.trim());
    log.error('docker refused the sandbox', { command, reason, stderr });
    return unavailable(reason, { command, image: config.image, stderr });
  }

  /** Best effort: on a path that is already failing, a second failure says nothing new. */
  async function remove(name: string): Promise<void> {
    try {
      const result = await docker(['rm', '--force', '--volumes', name]);
      if (result.exitCode !== 0 && !/no such container/iu.test(result.stderr)) {
        log.warn('sandbox container not removed', { name, stderr: redact(result.stderr.trim()) });
      }
    } catch (error) {
      log.warn('sandbox container not removed', { name, error: String(error) });
    }
  }

  /** Attach to the container, kill it at the wall clock or on abort, and say which fired. */
  function attach(
    name: string,
    signal: AbortSignal | undefined,
  ): Promise<{
    stdout: CappedStream;
    stderr: CappedStream;
    aborted: boolean;
    timedOut: boolean;
    pidsLimitHit: boolean;
  }> {
    return new Promise((resolve, reject) => {
      const stdout = new CappedStream(maxOutputBytes);
      const stderr = new CappedStream(maxOutputBytes);
      let aborted = false;
      let timedOut = false;
      let limitHit = false;
      let stopping: Promise<void> | null = null;

      const child = spawn(dockerPath, ['start', '--attach', name], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk);
      });

      // The container, not the client, is what has to stop: killing the
      // attached client leaves the container running. Killed by name.
      const stop = (why: 'abort' | 'time'): void => {
        if (stopping !== null) return;
        stopping = (async () => {
          if (why === 'time') {
            // Before the kill: both read a live container. One of the two
            // files exists, so `cat` exits non-zero and its output still counts.
            // Apart from the kill, which a failure here must not skip.
            // Each read on its own, so a failed one still leaves the other.
            let counted: string | null = null;
            let stats: string | null = null;
            try {
              const events = await docker(
                ['exec', name, 'cat', ...PIDS_EVENTS_FILES],
                DIAGNOSTIC_CALL_TIMEOUT_MS,
              );
              counted = /^max \d+$/mu.test(events.stdout) ? events.stdout : null;
            } catch (error) {
              log.warn('sandbox pids events not read', { name, error: String(error) });
            }
            if (counted === null) {
              try {
                const sampled = await docker(
                  ['stats', '--no-stream', '--format', '{{.PIDs}}', name],
                  DIAGNOSTIC_CALL_TIMEOUT_MS,
                );
                stats = sampled.exitCode === 0 ? sampled.stdout : null;
              } catch (error) {
                log.warn('sandbox pids stats not read', { name, error: String(error) });
              }
            }
            limitHit = pidsLimitHit(counted, stats, pidsLimit);
          }
          await docker(['kill', name]);
        })()
          .catch((error: unknown) => {
            log.warn('sandbox container not killed', { name, error: String(error) });
          })
          .finally(() => {
            // A wedged daemon would hold the attached client open; the
            // container is removed by name afterwards either way.
            child.kill('SIGKILL');
          });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        stop('time');
      }, config.timeoutMs);
      const onAbort = (): void => {
        aborted = true;
        stop('abort');
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      // An abort that landed while the container was being created fired no
      // event this listener could hear.
      if (signal?.aborted === true) onAbort();

      const settle = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      child.on('error', (error: NodeJS.ErrnoException) => {
        settle();
        reject(error.code === 'ENOENT' ? notInstalled() : unavailable('docker-failed', {}));
      });
      child.on('close', () => {
        settle();
        void (stopping ?? Promise.resolve()).then(() => {
          resolve({ stdout, stderr, aborted, timedOut, pidsLimitHit: limitHit });
        });
      });
    });
  }

  return {
    async run(request: SandboxRunRequest): Promise<SandboxResult> {
      if (!config.enabled) {
        throw new InterlockError('SANDBOX_UNAVAILABLE', 'The sandbox is disabled', {
          infra: true,
          remedy: 'Set sandbox.enabled to true; merged code never runs outside it.',
        });
      }
      if (request.signal?.aborted === true) throw cancelled();

      const user = containerUser(process.getuid?.(), process.getgid?.());
      const tree = await resolveSource(request.tree);
      const mounts = await Promise.all(
        (request.mounts ?? []).map(async (mount) => ({
          ...mount,
          resolved: await resolveSource(mount.source),
        })),
      );
      const cacheRoot =
        request.cacheRoot === undefined
          ? undefined
          : (await resolveSource(request.cacheRoot)).realPath;
      const planned = planMounts({
        tree,
        mounts,
        ...(cacheRoot === undefined ? {} : { cacheRoot }),
      });
      await assertMountPoints(tree.realPath, planned);

      const image = await docker(['image', 'inspect', '--format', '{{.Id}}', config.image]);
      if (image.exitCode !== 0) {
        // `image inspect` answers a missing image in words that have changed
        // between versions; anything but an unreachable daemon is a missing image.
        if (classifyDockerFailure(image.stderr) === 'daemon-down') {
          throw failedCall('image inspect', image);
        }
        log.error('sandbox image missing', { image: config.image });
        throw unavailable('image-missing', { image: config.image });
      }

      const name = `interlock-sandbox-${randomUUID()}`;
      const startedAt = Date.now();
      try {
        const created = await docker(
          createArgs({
            name,
            owner,
            image: config.image,
            user,
            cpuLimit: config.cpuLimit,
            memoryLimitMb: config.memoryLimitMb,
            pidsLimit,
            mounts: planned,
            workdir: request.workdir ?? TREE_TARGET,
            argv: request.argv,
          }),
        );
        if (created.exitCode !== 0) throw failedCall('create', created);

        const attached = await attach(name, request.signal);
        const inspected = await docker(['inspect', '--format', '{{json .State}}', name]);
        const state = inspected.exitCode === 0 ? parseContainerState(inspected.stdout) : null;
        if (state === null) {
          if (attached.aborted) throw cancelled();
          throw failedCall('inspect', inspected);
        }

        const durationMs = Date.now() - startedAt;
        const verdict = classifyRun({
          aborted: attached.aborted,
          timedOut: attached.timedOut,
          pidsLimitHit: attached.pidsLimitHit,
          state,
        });
        switch (verdict.kind) {
          case 'cancelled':
            log.debug('sandbox stopped', { name, durationMs });
            throw cancelled();
          case 'limit':
            log.warn('sandbox limit fired', { name, limit: verdict.limit, durationMs });
            if (verdict.limit === 'time') {
              throw new InterlockError(
                'SANDBOX_TIMEOUT',
                `The sandboxed command did not finish within ${String(config.timeoutMs)}ms`,
                {
                  details: { limit: 'time', timeoutMs: config.timeoutMs, durationMs },
                  remedy: 'Raise sandbox.timeoutMs, or narrow the command.',
                  infra: true,
                },
              );
            }
            throw new InterlockError(
              'SANDBOX_LIMIT',
              verdict.limit === 'memory'
                ? `The sandboxed command ran out of memory at ${String(config.memoryLimitMb)} MB`
                : `The sandboxed command reached its limit of ${String(pidsLimit)} processes`,
              {
                details: {
                  limit: verdict.limit,
                  ...(verdict.limit === 'memory'
                    ? { memoryLimitMb: config.memoryLimitMb }
                    : { pidsLimit }),
                  durationMs,
                },
                remedy:
                  verdict.limit === 'memory'
                    ? 'Raise sandbox.memoryLimitMb if the project needs more.'
                    : 'Look for a runaway process in the command; the limit is far above what a build uses.',
                infra: true,
              },
            );
          case 'failed-to-start': {
            const reason = classifyDockerFailure(verdict.error);
            log.error('sandbox did not start', { name, reason, error: redact(verdict.error) });
            throw unavailable(reason, { command: 'start', error: redact(verdict.error) });
          }
          case 'exited':
            log.debug('sandbox exited', { name, exitCode: verdict.exitCode, durationMs });
            return {
              exitCode: verdict.exitCode,
              stdout: attached.stdout.text(),
              stderr: attached.stderr.text(),
              stdoutTruncated: attached.stdout.truncated,
              stderrTruncated: attached.stderr.truncated,
              durationMs,
            };
        }
      } finally {
        await remove(name);
      }
    },

    async reapOrphans(): Promise<number> {
      const listed = await docker([
        'ps',
        '--all',
        '--quiet',
        '--no-trunc',
        '--filter',
        `label=${SANDBOX_LABEL}=${owner}`,
      ]);
      if (listed.exitCode !== 0) throw failedCall('ps', listed);
      const ids = listed.stdout.split('\n').filter((id) => id !== '');
      if (ids.length === 0) return 0;
      const removed = await docker(['rm', '--force', '--volumes', ...ids]);
      if (removed.exitCode !== 0) throw failedCall('rm', removed);
      log.info('removed orphaned sandbox containers', { count: ids.length });
      return ids.length;
    },
  };
}
