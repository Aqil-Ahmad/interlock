import { describe, expect, it } from 'vitest';
import { InterlockError } from '@interlock/shared';
import {
  SANDBOX_LABEL,
  assertOwner,
  classifyDockerFailure,
  classifyRun,
  containerUser,
  createArgs,
  csvField,
  mountArg,
  parseContainerState,
  pidsLimitHit,
  planMounts,
  shellCommand,
  unavailable,
} from './docker-args.js';
import type { ContainerState, CreateArgsInput, MountPlanInput } from './docker-args.js';

const dir = (realPath: string) => ({ realPath, kind: 'directory' as const });

function refusal(run: () => unknown): InterlockError {
  try {
    run();
  } catch (error) {
    if (error instanceof InterlockError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('planMounts', () => {
  const base: MountPlanInput = { tree: dir('/data/slot'), mounts: [] };

  it('mounts the tree read-only at /work', () => {
    expect(planMounts(base)).toStrictEqual([
      { source: '/data/slot', target: '/work', writable: false },
    ]);
  });

  it('places dependencies read-only under the tree and a cache writable under /cache', () => {
    const planned = planMounts({
      tree: dir('/data/slot'),
      cacheRoot: '/data/cache',
      mounts: [
        { source: '/deps/nm', target: '/work/node_modules', resolved: dir('/deps/nm') },
        {
          source: '/data/cache/slot-1',
          target: '/cache/turbo',
          writable: true,
          resolved: dir('/data/cache/slot-1'),
        },
      ],
    });
    expect(planned).toStrictEqual([
      { source: '/data/slot', target: '/work', writable: false },
      { source: '/deps/nm', target: '/work/node_modules', writable: false },
      { source: '/data/cache/slot-1', target: '/cache/turbo', writable: true },
    ]);
  });

  it('refuses a tree that is not a directory', () => {
    const error = refusal(() => planMounts({ tree: { realPath: '/f', kind: 'file' }, mounts: [] }));
    expect(error.code).toBe('SANDBOX_REFUSED');
    expect(error.infra).toBe(false);
  });

  it.each([
    ['relative', 'work/x'],
    ['unnormalised', '/work/a/../b'],
    ['trailing slash', '/work/x/'],
  ])('refuses a %s target', (_, target) => {
    const error = refusal(() =>
      planMounts({ ...base, mounts: [{ source: '/d', target, resolved: dir('/d') }] }),
    );
    expect(error.message).toMatch(/absolute, normalised/u);
  });

  it.each([
    ['the tree itself', '/work'],
    ['outside the tree', '/etc/x'],
    ['a sibling sharing a prefix', '/workshop'],
  ])('refuses a read-only target at %s', (_, target) => {
    const error = refusal(() =>
      planMounts({ ...base, mounts: [{ source: '/d', target, resolved: dir('/d') }] }),
    );
    expect(error.message).toMatch(/under the tree/u);
  });

  it('refuses a writable target outside /cache, including under the tree', () => {
    for (const target of ['/work/dist', '/cache', '/cachex/y']) {
      const error = refusal(() =>
        planMounts({
          ...base,
          cacheRoot: '/c',
          mounts: [{ source: '/c/x', target, writable: true, resolved: dir('/c/x') }],
        }),
      );
      expect(error.message, target).toMatch(/under \/cache/u);
    }
  });

  it('refuses two mounts at one target', () => {
    const mount = { source: '/d', target: '/work/a', resolved: dir('/d') };
    expect(refusal(() => planMounts({ ...base, mounts: [mount, mount] })).message).toMatch(
      /share a target/u,
    );
  });

  it('refuses a socket or a device as a source, which is how the Docker socket would get in', () => {
    const error = refusal(() =>
      planMounts({
        ...base,
        mounts: [
          {
            source: '/var/run/docker.sock',
            target: '/work/s',
            resolved: { realPath: '/var/run/docker.sock', kind: 'other' },
          },
        ],
      }),
    );
    expect(error.message).toMatch(/directory or a regular file/u);
  });

  it('accepts a regular file as a read-only source', () => {
    expect(
      planMounts({
        ...base,
        mounts: [
          { source: '/f', target: '/work/.npmrc', resolved: { realPath: '/f', kind: 'file' } },
        ],
      }),
    ).toHaveLength(2);
  });

  it('refuses a writable mount without a cache root', () => {
    const error = refusal(() =>
      planMounts({
        ...base,
        mounts: [{ source: '/c/x', target: '/cache/x', writable: true, resolved: dir('/c/x') }],
      }),
    );
    expect(error.message).toMatch(/needs a cache root/u);
  });

  it('refuses a writable mount from outside the cache root, judged on whole path segments', () => {
    const error = refusal(() =>
      planMounts({
        ...base,
        cacheRoot: '/data/cache',
        mounts: [
          {
            source: '/data/cache-other',
            target: '/cache/x',
            writable: true,
            resolved: dir('/data/cache-other'),
          },
        ],
      }),
    );
    expect(error.message).toMatch(/from under the cache root/u);
  });

  it('refuses a cache root that holds the tree, or sits inside it', () => {
    for (const cacheRoot of ['/data', '/data/slot/cache']) {
      const error = refusal(() => planMounts({ ...base, cacheRoot }));
      expect(error.message, cacheRoot).toMatch(/overlaps a read-only/u);
    }
  });

  it('refuses a cache root that overlaps a read-only dependency mount', () => {
    const error = refusal(() =>
      planMounts({
        ...base,
        cacheRoot: '/deps',
        mounts: [{ source: '/deps/nm', target: '/work/node_modules', resolved: dir('/deps/nm') }],
      }),
    );
    expect(error.message).toMatch(/overlaps a read-only/u);
  });
});

describe('mountArg', () => {
  it('marks a read-only mount readonly and a writable one not', () => {
    expect(mountArg({ source: '/a', target: '/work', writable: false })).toBe(
      'type=bind,source=/a,target=/work,readonly',
    );
    expect(mountArg({ source: '/c', target: '/cache/x', writable: true })).toBe(
      'type=bind,source=/c,target=/cache/x',
    );
  });

  it('quotes a path with a comma, so the rest is not read as another option', () => {
    expect(mountArg({ source: '/a,readonly=false', target: '/work', writable: false })).toBe(
      'type=bind,"source=/a,readonly=false",target=/work,readonly',
    );
  });

  it('doubles quotes inside a quoted field', () => {
    expect(csvField('source=/a"b,c')).toBe('"source=/a""b,c"');
    expect(csvField('source=/a"b')).toBe('"source=/a""b"');
    expect(csvField('source=/a\nb')).toBe('"source=/a\nb"');
    expect(csvField('source=/a\rb')).toBe('"source=/a\rb"');
    expect(csvField('source=/plain')).toBe('source=/plain');
  });
});

describe('containerUser', () => {
  it("runs as the daemon's own uid and gid", () => {
    expect(containerUser(501, 20)).toStrictEqual({ uid: 501, gid: 20 });
  });

  it('refuses root with a remedy rather than running as a fixed uid', () => {
    const error = refusal(() => containerUser(0, 0));
    expect(error.code).toBe('SANDBOX_UNAVAILABLE');
    expect(error.infra).toBe(true);
    expect(error.remedy).toMatch(/ordinary user/u);
  });

  it('refuses a platform with no POSIX ids', () => {
    expect(refusal(() => containerUser(undefined, undefined)).code).toBe('SANDBOX_UNAVAILABLE');
    expect(refusal(() => containerUser(1000, undefined)).code).toBe('SANDBOX_UNAVAILABLE');
  });
});

describe('shellCommand', () => {
  it("hands a command string to the container's shell as one argument", () => {
    expect(shellCommand('pnpm build && rm -rf ~; echo $HOME')).toStrictEqual([
      'sh',
      '-c',
      'pnpm build && rm -rf ~; echo $HOME',
    ]);
  });
});

describe('createArgs', () => {
  const input: CreateArgsInput = {
    name: 'interlock-sandbox-x',
    owner: 'owner-1',
    image: 'img@sha256:abc',
    user: { uid: 1000, gid: 1001 },
    cpuLimit: 1.5,
    memoryLimitMb: 256,
    pidsLimit: 64,
    mounts: [{ source: '/slot', target: '/work', writable: false }],
    workdir: '/work',
    argv: ['node', '--version'],
  };
  const args = createArgs(input);
  const valueOf = (flag: string): string | undefined => args[args.indexOf(flag) + 1];

  it('never pulls, and labels the container with its owner', () => {
    expect(args[0]).toBe('create');
    expect(args).toContain('--pull=never');
    expect(valueOf('--label')).toBe(`${SANDBOX_LABEL}=owner-1`);
    expect(valueOf('--name')).toBe('interlock-sandbox-x');
  });

  it('isolates: no network, no capabilities, no privilege gain, read-only root, non-root user', () => {
    expect(valueOf('--network')).toBe('none');
    expect(valueOf('--cap-drop')).toBe('ALL');
    expect(valueOf('--security-opt')).toBe('no-new-privileges');
    expect(args).toContain('--read-only');
    expect(valueOf('--user')).toBe('1000:1001');
    expect(valueOf('--log-driver')).toBe('none');
    expect(args).toContain('--init');
  });

  it('limits CPU, memory with no swap, and processes', () => {
    expect(valueOf('--cpus')).toBe('1.5');
    expect(valueOf('--memory')).toBe('256m');
    expect(valueOf('--memory-swap')).toBe('256m');
    expect(valueOf('--pids-limit')).toBe('64');
  });

  it("gives one tmpfs, owned by the container's user, and points HOME at it", () => {
    expect(valueOf('--tmpfs')).toBe('/tmp:rw,nosuid,nodev,size=256m,uid=1000,gid=1001,mode=0700');
    expect(args.filter((arg) => arg === '--env')).toHaveLength(1);
    expect(valueOf('--env')).toBe('HOME=/tmp');
  });

  it('mounts what the plan says and runs the command as the entrypoint', () => {
    expect(valueOf('--mount')).toBe('type=bind,source=/slot,target=/work,readonly');
    expect(valueOf('--workdir')).toBe('/work');
    expect(valueOf('--entrypoint')).toBe('node');
    expect(args.slice(-2)).toStrictEqual(['img@sha256:abc', '--version']);
  });

  it('puts the image after every option, so an argument cannot become a docker flag', () => {
    const hostile = createArgs({ ...input, argv: ['sh', '--privileged', '-v', '/:/host'] });
    const at = hostile.indexOf('img@sha256:abc');
    expect(hostile.slice(at + 1)).toStrictEqual(['--privileged', '-v', '/:/host']);
    expect(hostile.slice(0, at)).not.toContain('--privileged');
  });

  it('refuses an empty command', () => {
    expect(refusal(() => createArgs({ ...input, argv: [] })).code).toBe('SANDBOX_REFUSED');
    expect(refusal(() => createArgs({ ...input, argv: [''] })).code).toBe('SANDBOX_REFUSED');
  });
});

describe('classifyDockerFailure', () => {
  it.each([
    [
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      'daemon-down',
    ],
    [
      'failed to connect to the docker API at unix:///x; check if the path is correct',
      'daemon-down',
    ],
    ['error during connect: Get "http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.24/info"', 'daemon-down'],
    ['Is the docker daemon running?', 'daemon-down'],
    [
      'Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /x',
      'mount-unreachable',
    ],
    [
      'docker: Error response from daemon: Mounts denied: The path /x is not shared from the host',
      'mount-unreachable',
    ],
    ['The path /x is not shared from OS X and is not known to Docker.', 'mount-unreachable'],
    ['Error response from daemon: No such image: node:99', 'image-missing'],
    ['Error response from daemon: conflict', 'docker-failed'],
  ] as const)('%s', (stderr, reason) => {
    expect(classifyDockerFailure(stderr)).toBe(reason);
  });
});

describe('unavailable', () => {
  it('is infrastructure with a remedy for every reason', () => {
    for (const reason of [
      'not-installed',
      'daemon-down',
      'image-missing',
      'mount-unreachable',
      'docker-failed',
    ] as const) {
      const error = unavailable(reason, { image: 'img@sha256:abc' });
      expect(error.code, reason).toBe('SANDBOX_UNAVAILABLE');
      expect(error.infra, reason).toBe(true);
      expect(error.remedy, reason).toBeTruthy();
      expect(error.details.reason, reason).toBe(reason);
    }
  });

  it('names the image to pull, since Interlock never pulls it', () => {
    expect(unavailable('image-missing', { image: 'img@sha256:abc' }).remedy).toContain(
      'docker pull img@sha256:abc',
    );
  });
});

describe('parseContainerState', () => {
  it("reads Docker's state", () => {
    expect(
      parseContainerState(
        '{"Status":"exited","Running":false,"ExitCode":3,"OOMKilled":false,"Error":""}',
      ),
    ).toStrictEqual({ exitCode: 3, oomKilled: false, error: '', running: false });
    expect(
      parseContainerState(
        '{"Status":"running","Running":true,"ExitCode":0,"OOMKilled":false,"Error":""}',
      ),
    ).toStrictEqual({ exitCode: 0, oomKilled: false, error: '', running: true });
  });

  it.each([
    ['not JSON', 'nope'],
    ['not an object', '3'],
    ['null', 'null'],
    ['no exit code', '{"Running":false,"OOMKilled":false,"Error":""}'],
    ['no OOM flag', '{"Running":false,"ExitCode":0,"Error":""}'],
    ['no error field', '{"Running":false,"ExitCode":0,"OOMKilled":false}'],
    ['no running flag', '{"ExitCode":0,"OOMKilled":false,"Error":""}'],
  ])('is null for %s', (_, json) => {
    expect(parseContainerState(json)).toBeNull();
  });
});

describe('classifyRun', () => {
  const exited: ContainerState = { exitCode: 2, oomKilled: false, error: '', running: false };
  const facts = { aborted: false, timedOut: false, pidsLimitHit: false, state: exited };

  it('is a result for any exit of its own, non-zero included', () => {
    expect(classifyRun(facts)).toStrictEqual({ kind: 'exited', exitCode: 2 });
  });

  it('is cancelled when the caller stopped it, whatever else fired', () => {
    expect(
      classifyRun({
        aborted: true,
        timedOut: true,
        pidsLimitHit: true,
        state: { exitCode: 137, oomKilled: true, error: '', running: true },
      }),
    ).toStrictEqual({ kind: 'cancelled' });
  });

  it("reads an OOM kill from Docker's flag, not from exit 137", () => {
    expect(classifyRun({ ...facts, state: { ...exited, exitCode: 137, oomKilled: true } })).toEqual(
      { kind: 'limit', limit: 'memory' },
    );
    expect(classifyRun({ ...facts, state: { ...exited, exitCode: 137 } })).toEqual({
      kind: 'exited',
      exitCode: 137,
    });
    expect(
      classifyRun({ ...facts, timedOut: true, state: { ...exited, oomKilled: true } }),
    ).toEqual({ kind: 'limit', limit: 'memory' });
  });

  it('names the PID limit when the clock fired on a container sitting at it', () => {
    expect(classifyRun({ ...facts, timedOut: true, pidsLimitHit: true })).toEqual({
      kind: 'limit',
      limit: 'pids',
    });
    expect(classifyRun({ ...facts, timedOut: true })).toEqual({ kind: 'limit', limit: 'time' });
  });

  it("is a failure to start when Docker recorded an error, never the command's exit", () => {
    expect(
      classifyRun({ ...facts, state: { ...exited, exitCode: 127, error: 'mounts denied' } }),
    ).toEqual({ kind: 'failed-to-start', error: 'mounts denied' });
  });

  it('is no result for a container still running, whatever exit code Docker shows', () => {
    const running = { ...exited, exitCode: 0, running: true };
    expect(classifyRun({ ...facts, state: running })).toEqual({ kind: 'detached' });
    expect(classifyRun({ ...facts, state: { ...running, error: 'mounts denied' } })).toEqual({
      kind: 'detached',
    });
  });

  it('reads a limit or an abort first, since a killed container may still be stopping', () => {
    const running = { ...exited, running: true };
    expect(classifyRun({ ...facts, timedOut: true, state: running })).toEqual({
      kind: 'limit',
      limit: 'time',
    });
    expect(classifyRun({ ...facts, aborted: true, state: running })).toEqual({
      kind: 'cancelled',
    });
  });
});

describe('pidsLimitHit', () => {
  it("trusts the cgroup's refusal counter when it could be read", () => {
    expect(pidsLimitHit('max 97\n', null, 64)).toBe(true);
    expect(pidsLimitHit('max 0\n', '64', 64)).toBe(false);
    expect(pidsLimitHit('cat: missing\nmax 1', null, 64)).toBe(true);
  });

  it('falls back to the live count, at or past the limit, when it could not', () => {
    expect(pidsLimitHit(null, '64\n', 64)).toBe(true);
    expect(pidsLimitHit('', '65', 64)).toBe(true);
    expect(pidsLimitHit(null, '63', 64)).toBe(false);
    expect(pidsLimitHit(null, '--', 64)).toBe(false);
    expect(pidsLimitHit(null, null, 64)).toBe(false);
  });
});

describe('assertOwner', () => {
  it('accepts a plain name and refuses anything a filter could misread', () => {
    expect(() => {
      assertOwner('daemon-3f2a.1_x');
    }).not.toThrow();
    for (const owner of ['', '-x', 'a=b', 'a,b', 'a b', 'x'.repeat(129)]) {
      expect(() => {
        assertOwner(owner);
      }, owner).toThrow(InterlockError);
    }
  });
});
