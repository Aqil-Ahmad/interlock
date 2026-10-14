import { posix } from 'node:path';
import { InterlockError } from '@interlock/shared';
import { isWithin } from '../git/repo-handle.js';

/**
 * Everything about a sandbox run that can be decided without Docker: the
 * mount plan and its refusals, the `docker create` argument array, and what a
 * finished container's state means. Kept free of I/O so each rule is tested on
 * its own rather than through a container.
 */

/** Where the tree is mounted, read-only, and the working directory by default. */
export const TREE_TARGET = '/work';

/** The one writable path every run gets: a tmpfs that dies with the container. */
export const SCRATCH_TARGET = '/tmp';

/** Writable cache mounts live here, outside the tree, so nothing the host reads is under them. */
export const CACHE_TARGET = '/cache';

/** Label on every container the runner creates; its value names the owner. */
export const SANDBOX_LABEL = 'dev.interlock.sandbox';

/**
 * Generous for a build's worker processes and far below what a fork bomb
 * reaches in milliseconds. A build that genuinely needs more is reported as
 * the limit firing, never as a result.
 */
export const DEFAULT_PIDS_LIMIT = 512;

/** An extra bind mount, beside the tree. */
export interface SandboxMount {
  /** Absolute host path. */
  readonly source: string;
  /** Absolute container path: under `/work` when read-only, under `/cache` when writable. */
  readonly target: string;
  /**
   * Writable only from under the run's cache root. The host never reads,
   * follows or runs anything in a writable mount — it only deletes it — so a
   * symlink the command plants there points nowhere that matters.
   */
  readonly writable?: boolean;
}

/** What a source path turned out to be on the host, resolved by the caller. */
export interface ResolvedSource {
  /** `realpath` of the source. */
  readonly realPath: string;
  /** From `lstat` on the real path. */
  readonly kind: 'directory' | 'file' | 'other';
}

export interface MountPlanInput {
  /** `realpath` of the tree; it must be a directory. */
  readonly tree: ResolvedSource;
  readonly mounts: readonly (SandboxMount & { readonly resolved: ResolvedSource })[];
  /** `realpath` of the cache root, when the run has one. */
  readonly cacheRoot?: string;
}

export interface PlannedMount {
  readonly source: string;
  readonly target: string;
  readonly writable: boolean;
}

function refused(message: string, details: Record<string, unknown>): InterlockError {
  return new InterlockError('SANDBOX_REFUSED', message, {
    details,
    remedy:
      'Mount only directories or regular files; writable mounts only from under the cache root, at a path under /cache.',
  });
}

function isContainerPathUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/** Whether either path contains the other: two mounts that would see each other's files. */
function overlaps(a: string, b: string): boolean {
  return isWithin(a, b) || isWithin(b, a);
}

/**
 * Decide what gets mounted, or refuse.
 *
 * The rule is that no write a container makes is ever trusted by the host. The
 * tree is read-only because the host runs `git reset --hard` in it and the type
 * checker reads it; a writable mount comes only from under the cache root, which
 * may not overlap the tree or any read-only source, because whatever the host
 * reads from a writable directory follows a symlink the command chose. A socket
 * or a device is never a source: the Docker socket would hand the container
 * the host.
 */
export function planMounts(input: MountPlanInput): PlannedMount[] {
  if (input.tree.kind !== 'directory') {
    throw refused('The sandbox tree must be a directory', { tree: input.tree.realPath });
  }
  const planned: PlannedMount[] = [
    { source: input.tree.realPath, target: TREE_TARGET, writable: false },
  ];
  const targets = new Set<string>([TREE_TARGET]);

  for (const mount of input.mounts) {
    const writable = mount.writable === true;
    const { target } = mount;
    if (!target.startsWith('/') || posix.normalize(target) !== target || target.endsWith('/')) {
      throw refused('A sandbox mount target must be an absolute, normalised path', { target });
    }
    const root = writable ? CACHE_TARGET : TREE_TARGET;
    if (target === root || !isContainerPathUnder(root, target)) {
      throw refused(
        writable
          ? 'A writable sandbox mount must sit under /cache'
          : 'A read-only sandbox mount must sit under the tree, at /work',
        { target },
      );
    }
    if (targets.has(target)) {
      throw refused('Two sandbox mounts share a target', { target });
    }
    if (mount.resolved.kind === 'other') {
      throw refused('A sandbox mount source must be a directory or a regular file', {
        source: mount.resolved.realPath,
      });
    }
    if (writable) {
      if (input.cacheRoot === undefined) {
        throw refused('A writable sandbox mount needs a cache root', {
          source: mount.resolved.realPath,
        });
      }
      if (!isWithin(input.cacheRoot, mount.resolved.realPath)) {
        throw refused('A writable sandbox mount must come from under the cache root', {
          source: mount.resolved.realPath,
          cacheRoot: input.cacheRoot,
        });
      }
    }
    targets.add(target);
    planned.push({ source: mount.resolved.realPath, target, writable });
  }

  // Read-only mounts only: writable ones all come from under the cache root,
  // so two nested inside each other expose nothing a container could not
  // already write.
  if (input.cacheRoot !== undefined) {
    for (const mount of planned) {
      if (!mount.writable && overlaps(input.cacheRoot, mount.source)) {
        throw refused('The cache root overlaps a read-only sandbox mount', {
          source: mount.source,
          cacheRoot: input.cacheRoot,
        });
      }
    }
  }
  return planned;
}

/**
 * One `--mount` field, quoted when it needs to be.
 *
 * `--mount` is parsed as a CSV record, so a path holding a comma would end its
 * field early and the rest would be read as another option — `readonly` among
 * them, which is how a read-only mount could lose that flag. Quoted fields
 * double their quotes.
 */
export function csvField(field: string): string {
  return /[",\r\n]/u.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

export function mountArg(mount: PlannedMount): string {
  const fields = ['type=bind', `source=${mount.source}`, `target=${mount.target}`];
  if (!mount.writable) fields.push('readonly');
  return fields.map(csvField).join(',');
}

/** The uid and gid the container runs as. */
export interface ContainerUser {
  readonly uid: number;
  readonly gid: number;
}

/**
 * The container runs as the daemon's own user, so the 0700 data dir it reads
 * the tree from stays 0700. Root is refused rather than mapped to a fixed
 * unprivileged uid: that uid could read the slot only if the data dir were
 * opened to it.
 */
export function containerUser(uid: number | undefined, gid: number | undefined): ContainerUser {
  if (uid === undefined || gid === undefined) {
    throw new InterlockError('SANDBOX_UNAVAILABLE', 'The sandbox needs a POSIX user to run as', {
      infra: true,
      remedy: 'Run the Interlock daemon on Linux or macOS.',
    });
  }
  if (uid === 0) {
    throw new InterlockError(
      'SANDBOX_UNAVAILABLE',
      'The sandbox does not run while the daemon runs as root',
      {
        infra: true,
        remedy:
          'Run the Interlock daemon as an ordinary user. Sandboxed commands run as the daemon user, never as root.',
      },
    );
  }
  return { uid, gid };
}

/**
 * A command string — a toolchain override from `.interlock.json` — as the
 * argument array that runs it. The shell is the container's, never the host's.
 */
export function shellCommand(command: string): readonly string[] {
  return ['sh', '-c', command];
}

export interface CreateArgsInput {
  readonly name: string;
  readonly owner: string;
  readonly image: string;
  readonly user: ContainerUser;
  readonly cpuLimit: number;
  readonly memoryLimitMb: number;
  readonly pidsLimit: number;
  readonly mounts: readonly PlannedMount[];
  readonly workdir: string;
  readonly argv: readonly string[];
}

/**
 * The `docker create` argument array.
 *
 * The image's entrypoint is replaced by the command's first word, so nothing
 * the image ships wraps or rewrites the command. No `-e` from the host: the
 * container's environment is the image's plus `HOME`. `--log-driver none`
 * keeps a command's output off the Docker host's disk; it still reaches the
 * runner through the attached streams.
 */
export function createArgs(input: CreateArgsInput): string[] {
  const [entrypoint, ...rest] = input.argv;
  if (entrypoint === undefined || entrypoint === '') {
    throw refused('A sandbox command needs at least a program name', {});
  }
  const memory = `${String(input.memoryLimitMb)}m`;
  return [
    'create',
    '--pull=never',
    '--name',
    input.name,
    '--label',
    `${SANDBOX_LABEL}=${input.owner}`,
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--init',
    '--log-driver',
    'none',
    '--user',
    `${String(input.user.uid)}:${String(input.user.gid)}`,
    '--cpus',
    String(input.cpuLimit),
    '--memory',
    memory,
    // Equal to the memory limit: no swap, so a hog is killed rather than
    // slowed into the wall-clock limit and reported as the wrong one.
    '--memory-swap',
    memory,
    '--pids-limit',
    String(input.pidsLimit),
    '--tmpfs',
    `${SCRATCH_TARGET}:rw,nosuid,nodev,size=${memory},uid=${String(input.user.uid)},gid=${String(input.user.gid)},mode=0700`,
    '--env',
    `HOME=${SCRATCH_TARGET}`,
    ...input.mounts.flatMap((mount) => ['--mount', mountArg(mount)]),
    '--workdir',
    input.workdir,
    '--entrypoint',
    entrypoint,
    input.image,
    ...rest,
  ];
}

/** Docker's own words for a client that cannot reach its daemon, across versions and platforms. */
const DAEMON_UNREACHABLE =
  /cannot connect to the docker daemon|failed to connect to the docker api|error during connect|is the docker daemon running/iu;

/** A bind source Docker, or the VM Docker Desktop runs it in, cannot see. */
const MOUNT_UNREACHABLE =
  /bind source path does not exist|mounts denied|is not shared from the host|not shared from os x/iu;

const NO_SUCH_IMAGE = /no such image/iu;

/** Why Docker cannot be used, as the error a caller acts on. */
export function unavailable(
  reason: 'not-installed' | 'daemon-down' | 'image-missing' | 'mount-unreachable' | 'docker-failed',
  details: Record<string, unknown>,
): InterlockError {
  const messages = {
    'not-installed': [
      'Docker is not installed',
      'Install Docker and make sure `docker` is on PATH.',
    ],
    'daemon-down': [
      'The Docker daemon is not running',
      'Start Docker (Docker Desktop, colima or dockerd) and try again.',
    ],
    'image-missing': [
      'The sandbox image is not present',
      `Pull it once with \`docker pull ${String(details.image)}\`; Interlock never pulls by itself.`,
    ],
    'mount-unreachable': [
      'Docker cannot reach a directory the sandbox mounts',
      "Put Interlock's data directory inside a path Docker shares — on Docker Desktop, Settings → Resources → File sharing.",
    ],
    'docker-failed': ['Docker could not run the sandbox', 'Check `docker info` for the cause.'],
  } as const;
  const [message, remedy] = messages[reason];
  return new InterlockError('SANDBOX_UNAVAILABLE', message, {
    details: { ...details, reason },
    remedy,
    infra: true,
  });
}

/** What a failed `docker` call's stderr says about why. */
export function classifyDockerFailure(
  stderr: string,
): 'daemon-down' | 'image-missing' | 'mount-unreachable' | 'docker-failed' {
  if (DAEMON_UNREACHABLE.test(stderr)) return 'daemon-down';
  if (MOUNT_UNREACHABLE.test(stderr)) return 'mount-unreachable';
  if (NO_SUCH_IMAGE.test(stderr)) return 'image-missing';
  return 'docker-failed';
}

/** The parts of `docker inspect`'s `.State` that decide a run's outcome. */
export interface ContainerState {
  readonly exitCode: number;
  readonly oomKilled: boolean;
  /** Docker's own error starting the container; empty when it started. */
  readonly error: string;
  /**
   * Still running when inspected. Its exit code is then Docker's placeholder,
   * 0, and says nothing about the command.
   */
  readonly running: boolean;
}

/** Read `{{json .State}}`; null when it is not the shape Docker documents. */
export function parseContainerState(json: string): ContainerState | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const state = value as Record<string, unknown>;
  const exitCode = state.ExitCode;
  const oomKilled = state.OOMKilled;
  const error = state.Error;
  const running = state.Running;
  if (
    typeof exitCode !== 'number' ||
    typeof oomKilled !== 'boolean' ||
    typeof error !== 'string' ||
    typeof running !== 'boolean'
  ) {
    return null;
  }
  return { exitCode, oomKilled, error, running };
}

/** How a run ended, before its output is attached. */
export type RunVerdict =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'limit'; readonly limit: 'memory' | 'pids' | 'time' }
  | { readonly kind: 'failed-to-start'; readonly error: string }
  | { readonly kind: 'detached' }
  | { readonly kind: 'exited'; readonly exitCode: number };

export interface RunFacts {
  /** The caller's signal fired. */
  readonly aborted: boolean;
  /** The wall-clock limit fired. */
  readonly timedOut: boolean;
  /** The container's PID limit refused a fork at some point before the clock fired. */
  readonly pidsLimitHit: boolean;
  readonly state: ContainerState;
}

/**
 * Decide what a finished container means.
 *
 * Order matters. A cancelled run is nobody's verdict. An OOM kill is read from
 * Docker's flag, not from exit 137, which a `kill -9` produces too. A fork bomb
 * is never killed by the kernel — `fork` just fails at the limit — so it runs
 * into the wall clock, and a container whose PID limit refused a fork is
 * reported as the PID limit, the cause, rather than the time. A container
 * still running once the attached client has gone — the client died, or a
 * daemon with live restore dropped the connection — has not finished, so its
 * exit code is not a result; after a kill it may still be stopping, which is
 * why the limits and the abort are read first.
 */
export function classifyRun(facts: RunFacts): RunVerdict {
  if (facts.aborted) return { kind: 'cancelled' };
  if (facts.state.oomKilled) return { kind: 'limit', limit: 'memory' };
  if (facts.timedOut) return { kind: 'limit', limit: facts.pidsLimitHit ? 'pids' : 'time' };
  if (facts.state.running) return { kind: 'detached' };
  if (facts.state.error !== '') return { kind: 'failed-to-start', error: facts.state.error };
  return { kind: 'exited', exitCode: facts.state.exitCode };
}

/**
 * Where the PID controller counts refusals, under cgroup v2 and v1, as seen
 * from inside the container. Read with `docker exec`, because a fork bomb does
 * not sit at its limit: forks fail, the failing branches exit, and by the time
 * anyone looks the count has collapsed. The refusal counter does not.
 */
export const PIDS_EVENTS_FILES: readonly string[] = [
  '/sys/fs/cgroup/pids.events',
  '/sys/fs/cgroup/pids/pids.events',
];

/**
 * Whether the container ever hit its PID limit.
 *
 * The cgroup's `max` counter decides when it could be read. When it could
 * not — an `exec` refused for want of a free PID is the likeliest reason —
 * `docker stats` showing the container at its limit stands in. Only the
 * diagnosis rests on this: a PID limit and a timeout are both a run with no
 * verdict.
 */
export function pidsLimitHit(
  eventsOutput: string | null,
  statsOutput: string | null,
  limit: number,
): boolean {
  const max = /^max (\d+)$/mu.exec(eventsOutput ?? '');
  if (max !== null) return Number(max[1]) > 0;
  if (statsOutput === null) return false;
  const count = Number.parseInt(statsOutput.trim(), 10);
  return Number.isInteger(count) && count >= limit;
}

/** Owner labels reach `docker ps --filter`, so they are kept to a plain name. */
export function assertOwner(owner: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(owner)) {
    throw refused('A sandbox owner must be a plain name', { owner });
  }
}
