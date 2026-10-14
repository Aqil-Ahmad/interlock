import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, InterlockError } from '@interlock/shared';
import type { SandboxConfig } from '@interlock/shared';
import { SANDBOX_LABEL, createSandboxRunner, shellCommand } from '../src/sandbox/index.js';
import type { SandboxRunner, SandboxRunnerOptions } from '../src/sandbox/index.js';
import {
  TEST_IMAGE,
  imagePresent,
  labelledContainers,
  removeLabelled,
  sandboxSuiteStatus,
} from './support/docker.js';

/**
 * The sandbox, against a real Docker daemon.
 *
 * Every claim the runner makes about isolation and limits is shown by a
 * command run inside the container — never by running the same command on the
 * host to compare. Each test's containers carry a label unique to the test and
 * are removed in `afterEach`, whether or not the test passed.
 */

const status = sandboxSuiteStatus();
const nonRoot = process.getuid?.() !== 0;

const config = (overrides: Partial<SandboxConfig> = {}): SandboxConfig => ({
  ...DEFAULT_CONFIG.sandbox,
  image: TEST_IMAGE,
  cpuLimit: 1,
  memoryLimitMb: 256,
  timeoutMs: 20_000,
  ...overrides,
});

async function rejection(promise: Promise<unknown>): Promise<InterlockError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof InterlockError) return error;
    throw error;
  }
  throw new Error('expected the run to be refused');
}

let scratch: string;
let owner: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'interlock-sandbox-'));
  owner = `test-${randomUUID()}`;
});

afterEach(() => {
  if (status.blocker === null) removeLabelled(`${SANDBOX_LABEL}=${owner}`);
  rmSync(scratch, { recursive: true, force: true });
});

function makeTree(name = 'tree'): string {
  const tree = join(scratch, name);
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, 'hello.txt'), 'from the merged tree\n');
  return tree;
}

describe('sandbox runner: the suite itself', () => {
  const { blocker } = status;
  if (blocker === null) {
    it('has Docker and the test image', () => {
      expect(status.blocker).toBeNull();
    });
  } else if (status.mustRun) {
    it('runs on Linux CI', () => {
      throw new Error(`The sandbox suite must run on Linux CI, and cannot: ${blocker}`);
    });
  } else {
    console.warn(`Sandbox tests skipped: ${blocker}`);
    it.skip(`skipped the Docker tests: ${blocker}`, () => {
      // Never runs; the title carries the reason into the report.
    });
  }
});

describe('sandbox runner: without Docker', () => {
  it('reports Docker not installed, and runs nothing on the host instead', async () => {
    const runner = createSandboxRunner({
      config: config(),
      owner,
      dockerPath: join(scratch, 'no-docker-here'),
    });
    const tree = makeTree();
    const error = await rejection(
      runner.run({ tree, argv: shellCommand(`touch ${join(tree, 'ran-on-host')}`) }),
    );
    if (nonRoot) {
      expect(error.code).toBe('SANDBOX_UNAVAILABLE');
      expect(error.details.reason).toBe('not-installed');
      expect(error.remedy).toMatch(/Install Docker/u);
    }
    expect(existsSync(join(tree, 'ran-on-host'))).toBe(false);
  });

  it('refuses to run while the sandbox is disabled', async () => {
    const runner = createSandboxRunner({ config: config({ enabled: false }), owner });
    const error = await rejection(runner.run({ tree: scratch, argv: ['true'] }));
    expect(error.code).toBe('SANDBOX_UNAVAILABLE');
    expect(error.remedy).toMatch(/sandbox\.enabled/u);
  });

  it('is cancelled before anything starts when the signal has already fired', async () => {
    const runner = createSandboxRunner({ config: config(), owner });
    const error = await rejection(
      runner.run({ tree: scratch, argv: ['true'], signal: AbortSignal.abort() }),
    );
    expect(error.code).toBe('REQUEST_CANCELLED');
  });

  it('refuses an owner a label filter could misread', () => {
    expect(() => createSandboxRunner({ config: config(), owner: 'a=b' })).toThrow(InterlockError);
  });
});

/**
 * Docker stood in for by a script, for the answers a real daemon will not
 * give on demand: a mount Docker Desktop's VM cannot see, a container that
 * failed to start, a client that dies mid-run. The script reads its mode from
 * a file beside it and logs every call.
 */
describe.runIf(nonRoot)('sandbox runner: Docker misbehaving', () => {
  let fake: string;

  const SCRIPT = `#!/bin/sh
dir=$(dirname "$0")
mode=$(cat "$dir/mode")
echo "$*" >> "$dir/calls"
case "$1" in
  image)
    if [ "$mode" = image-odd ]; then echo "Error: something unexpected" >&2; exit 1; fi
    echo sha256:fake; exit 0 ;;
  create)
    case "$mode" in
      mount-denied) echo "docker: Error response from daemon: Mounts denied: The path /data is not shared from the host and is not known to Docker." >&2; exit 125 ;;
      vanish) rm -f "$0" ;;
      noexec) chmod -x "$0" ;;
    esac
    echo created; exit 0 ;;
  start)
    case "$mode" in hang|hang-bad-inspect|hang-exec-dies) exec sleep 600 ;; esac
    echo out; exit 0 ;;
  inspect)
    case "$mode" in
      start-error) echo '{"ExitCode":127,"OOMKilled":false,"Error":"error while creating mount source path: mounts denied"}' ;;
      bad-inspect|hang-bad-inspect) echo "Error: No such object" >&2; exit 1 ;;
      *) echo '{"ExitCode":0,"OOMKilled":false,"Error":""}' ;;
    esac
    exit 0 ;;
  exec)
    if [ "$mode" = hang-exec-dies ]; then kill -9 $$; fi
    exit 2 ;;
  stats) echo 3; exit 0 ;;
  kill) kill -9 $$ ;;
  rm)
    case "$mode" in rm-fails*) echo "Error: removal of container is already in progress" >&2; exit 1 ;; esac
    exit 0 ;;
  ps)
    if [ "$mode" = ps-fails ]; then echo "Cannot connect to the Docker daemon at unix:///x. Is the docker daemon running?" >&2; exit 1; fi
    case "$mode" in ps-two|rm-fails-reap) echo aaa; echo bbb ;; esac
    exit 0 ;;
esac
exit 2
`;

  beforeEach(() => {
    fake = join(scratch, 'fake');
    mkdirSync(fake);
    writeFileSync(join(fake, 'docker'), SCRIPT, { mode: 0o755 });
  });

  const runnerIn = (mode: string, options: Partial<SandboxRunnerOptions> = {}): SandboxRunner => {
    writeFileSync(join(fake, 'mode'), mode);
    return createSandboxRunner({
      config: config(),
      owner,
      dockerPath: join(fake, 'docker'),
      ...options,
    });
  };
  const calls = (): string[] => readFileSync(join(fake, 'calls'), 'utf8').trim().split('\n');

  it('reports a mount Docker cannot reach as unavailable, with a remedy about file sharing', async () => {
    const error = await rejection(
      runnerIn('mount-denied').run({ tree: makeTree(), argv: ['true'] }),
    );
    expect(error.code).toBe('SANDBOX_UNAVAILABLE');
    expect(error.details.reason).toBe('mount-unreachable');
    expect(error.remedy).toMatch(/File sharing/u);
    expect(calls().some((call) => call.startsWith('rm '))).toBe(true);
  });

  it('reports a container Docker could not start as unavailable, never as its exit code', async () => {
    const error = await rejection(
      runnerIn('start-error').run({ tree: makeTree(), argv: ['true'] }),
    );
    expect(error.code).toBe('SANDBOX_UNAVAILABLE');
    expect(error.details.reason).toBe('mount-unreachable');
  });

  it('reads an image inspect it does not understand as a missing image', async () => {
    const error = await rejection(runnerIn('image-odd').run({ tree: makeTree(), argv: ['true'] }));
    expect(error.details.reason).toBe('image-missing');
    expect(calls().some((call) => call.startsWith('create'))).toBe(false);
  });

  it('is unavailable when the state cannot be read', async () => {
    const error = await rejection(
      runnerIn('bad-inspect').run({ tree: makeTree(), argv: ['true'] }),
    );
    expect(error.code).toBe('SANDBOX_UNAVAILABLE');
  });

  it('is cancelled, not unavailable, when an aborted run left no state to read', async () => {
    const controller = new AbortController();
    const runner = runnerIn('hang-bad-inspect');
    const run = runner.run({ tree: makeTree(), argv: ['true'], signal: controller.signal });
    setImmediate(() => {
      controller.abort();
    });
    expect((await rejection(run)).code).toBe('REQUEST_CANCELLED');
  });

  it('still stops at the wall clock when the kill itself fails, and removes the container', async () => {
    const runner = runnerIn('hang', { config: config({ timeoutMs: 200 }) });
    const error = await rejection(runner.run({ tree: makeTree(), argv: ['true'] }));
    expect(error.code).toBe('SANDBOX_TIMEOUT');
    expect(
      calls()
        .filter((call) => /^(stats|kill|rm) /u.test(call))
        .map((c) => c.split(' ')[0]),
    ).toStrictEqual(['stats', 'kill', 'rm']);
  });

  it('still samples the pids and kills the container when reading the pids events fails', async () => {
    // The fake samples 3 processes: at this limit, the sample alone names it.
    const runner = runnerIn('hang-exec-dies', {
      pidsLimit: 3,
      config: config({ timeoutMs: 200 }),
    });
    const error = await rejection(runner.run({ tree: makeTree(), argv: ['true'] }));
    expect(error.code).toBe('SANDBOX_LIMIT');
    expect(error.details.limit).toBe('pids');
    expect(
      calls()
        .filter((call) => /^(exec|stats|kill|rm) /u.test(call))
        .map((c) => c.split(' ')[0]),
    ).toStrictEqual(['exec', 'stats', 'kill', 'rm']);
  });

  it('is not installed when Docker disappears mid-run, and the removal failing says nothing new', async () => {
    const error = await rejection(runnerIn('vanish').run({ tree: makeTree(), argv: ['true'] }));
    expect(error.details.reason).toBe('not-installed');
  });

  it('is unavailable when the client cannot be executed mid-run', async () => {
    const error = await rejection(runnerIn('noexec').run({ tree: makeTree(), argv: ['true'] }));
    expect(error.code).toBe('SANDBOX_UNAVAILABLE');
    expect(error.details.reason).toBe('docker-failed');
  });

  it('returns the result when only the removal afterwards fails', async () => {
    const result = await runnerIn('rm-fails').run({ tree: makeTree(), argv: ['true'] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('out\n');
  });

  it('reaps by label, and reports a daemon it cannot reach', async () => {
    expect(await runnerIn('ps-two').reapOrphans()).toBe(2);
    expect(calls()).toContain('rm --force --volumes aaa bbb');
    expect(await runnerIn('ok').reapOrphans()).toBe(0);
    expect((await rejection(runnerIn('ps-fails').reapOrphans())).details.reason).toBe(
      'daemon-down',
    );
    writeFileSync(join(fake, 'calls'), '');
    const error = await rejection(runnerIn('rm-fails-reap').reapOrphans());
    expect(error.code).toBe('SANDBOX_UNAVAILABLE');
  });
});

describe.runIf(status.blocker === null)('sandbox runner: in Docker', () => {
  const runner = (options: Partial<SandboxRunnerOptions> = {}): SandboxRunner =>
    createSandboxRunner({ config: config(), owner, ...options });
  const run = (argv: readonly string[], tree = makeTree()) => runner().run({ tree, argv });
  const node = (script: string): readonly string[] => ['node', '-e', script];

  describe('isolation', () => {
    it('has no network: connecting to an outside address fails', async () => {
      const result = await run(
        node(
          "require('net').connect(80, '1.1.1.1').on('connect', () => process.exit(0)).on('error', (e) => { console.log(e.code); process.exit(3); })",
        ),
      );
      expect(result.exitCode).toBe(3);
      expect(result.stdout.trim()).toMatch(/^E[A-Z]+$/u);
    });

    it("runs as the daemon's own uid and gid, which is not root", async () => {
      const result = await run(['sh', '-c', 'id -u; id -g']);
      expect(result.stdout.trim().split('\n')).toStrictEqual([
        String(process.getuid?.()),
        String(process.getgid?.()),
      ]);
      expect(result.stdout.trim().split('\n')[0]).not.toBe('0');
    });

    it('has no capabilities and cannot gain privileges', async () => {
      const result = await run(['grep', '-E', '^(CapEff|NoNewPrivs):', '/proc/self/status']);
      expect(result.stdout).toMatch(/^CapEff:\s+0000000000000000$/mu);
      expect(result.stdout).toMatch(/^NoNewPrivs:\s+1$/mu);
    });

    it('mounts the tree read-only and gives a writable tmpfs', async () => {
      const tree = makeTree();
      const result = await run(
        node(
          "const fs = require('fs'); try { fs.writeFileSync('/work/new.txt', 'x'); console.log('wrote'); } catch (e) { console.log(e.code); } fs.writeFileSync('/tmp/ok', 'x'); console.log(fs.readFileSync('/work/hello.txt', 'utf8').trim());",
        ),
        tree,
      );
      expect(result.stdout.trim().split('\n')).toStrictEqual(['EROFS', 'from the merged tree']);
      expect(existsSync(join(tree, 'new.txt'))).toBe(false);
    });

    it('passes no host environment variable in, and no Docker socket', async () => {
      process.env.INTERLOCK_SANDBOX_CANARY = 'host-only-value';
      try {
        const result = await run([
          'sh',
          '-c',
          'env; for s in /var/run/docker.sock /run/docker.sock; do [ -e "$s" ] && echo "socket at $s"; done; true',
        ]);
        expect(result.stdout).not.toContain('host-only-value');
        expect(result.stdout).not.toContain('INTERLOCK_SANDBOX_CANARY');
        expect(result.stdout).not.toContain('socket at');
        expect(result.stdout).toContain('HOME=/tmp');
      } finally {
        delete process.env.INTERLOCK_SANDBOX_CANARY;
      }
    });

    it('runs a command string inside the container, touching nothing on the host', async () => {
      const hostDir = join(scratch, 'host-side');
      mkdirSync(hostDir);
      const command = `touch ${hostDir}/pwned; echo $(id -u) > /tmp/x && cat /tmp/x | tr -d '\\n'; rm -rf /work/* 2>/dev/null; touch "${hostDir}/q"; \`touch ${hostDir}/b\`; exit 0`;
      const tree = makeTree();
      const result = await runner().run({ tree, argv: shellCommand(command) });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(String(process.getuid?.()));
      for (const name of ['pwned', 'q', 'b']) expect(existsSync(join(hostDir, name))).toBe(false);
      expect(readFileSync(join(tree, 'hello.txt'), 'utf8')).toBe('from the merged tree\n');
    });
  });

  describe('mounts', () => {
    it('mounts a path holding a comma and a quote, still read-only', async () => {
      const tree = makeTree('a,b "c",readonly=false');
      const result = await run(
        node(
          "const fs = require('fs'); console.log(fs.readFileSync('/work/hello.txt', 'utf8').trim()); try { fs.writeFileSync('/work/x', 'x'); } catch (e) { console.log(e.code); }",
        ),
        tree,
      );
      expect(result.stdout.trim().split('\n')).toStrictEqual(['from the merged tree', 'EROFS']);
    });

    it('resolves a relative workspace link in a dependency mount into the merged tree', async () => {
      const tree = makeTree();
      mkdirSync(join(tree, 'packages', 'pkg'), { recursive: true });
      writeFileSync(join(tree, 'packages', 'pkg', 'index.js'), 'merged\n');
      const deps = join(scratch, 'deps-node_modules');
      mkdirSync(join(deps, '@x'), { recursive: true });
      symlinkSync('../../packages/pkg', join(deps, '@x', 'pkg'));
      mkdirSync(join(tree, 'node_modules'));
      const result = await runner().run({
        tree,
        argv: ['cat', '/work/node_modules/@x/pkg/index.js'],
        mounts: [{ source: deps, target: '/work/node_modules' }],
      });
      expect(result.stdout).toBe('merged\n');
    });

    it('writes to a cache mounted from under the cache root, and nowhere else', async () => {
      const cacheRoot = join(scratch, 'cache');
      mkdirSync(join(cacheRoot, 'slot-1'), { recursive: true });
      const result = await runner().run({
        tree: makeTree(),
        argv: ['sh', '-c', 'echo kept > /cache/build/out && echo ok'],
        cacheRoot,
        mounts: [{ source: join(cacheRoot, 'slot-1'), target: '/cache/build', writable: true }],
      });
      expect(result.stdout).toBe('ok\n');
      expect(readFileSync(join(cacheRoot, 'slot-1', 'out'), 'utf8')).toBe('kept\n');
    });

    it('refuses a writable mount from outside the cache root, before any container exists', async () => {
      const cacheRoot = join(scratch, 'cache');
      mkdirSync(cacheRoot);
      const tree = makeTree();
      const error = await rejection(
        runner().run({
          tree,
          argv: ['true'],
          cacheRoot,
          mounts: [{ source: tree, target: '/cache/x', writable: true }],
        }),
      );
      expect(error.code).toBe('SANDBOX_REFUSED');
      expect(labelledContainers(`${SANDBOX_LABEL}=${owner}`)).toStrictEqual([]);
    });

    it('refuses a socket as a source', async () => {
      const socket = join(scratch, 's.sock');
      const server: Server = createServer();
      await new Promise<void>((resolve) => server.listen(socket, resolve));
      try {
        const error = await rejection(
          runner().run({
            tree: makeTree(),
            argv: ['true'],
            mounts: [{ source: socket, target: '/work/docker.sock' }],
          }),
        );
        expect(error.code).toBe('SANDBOX_REFUSED');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('refuses a nested mount whose mount point is missing, a link, or the wrong kind', async () => {
      const deps = join(scratch, 'deps');
      mkdirSync(deps);
      const file = join(scratch, 'npmrc');
      writeFileSync(file, '');
      const cases: [string, (tree: string) => void, string][] = [
        ['missing', () => undefined, deps],
        [
          'a link out of the tree',
          (tree) => {
            symlinkSync('/etc', join(tree, 'node_modules'));
          },
          deps,
        ],
        [
          'a directory for a file',
          (tree) => {
            mkdirSync(join(tree, 'node_modules'));
          },
          file,
        ],
      ];
      for (const [label, prepare, source] of cases) {
        const tree = makeTree(`tree-${label.replaceAll(' ', '-')}`);
        prepare(tree);
        const error = await rejection(
          runner().run({
            tree,
            argv: ['true'],
            mounts: [{ source, target: '/work/node_modules' }],
          }),
        );
        expect(error.code, label).toBe('SANDBOX_REFUSED');
        expect(error.message, label).toMatch(/no mount point/u);
      }
      expect(labelledContainers(`${SANDBOX_LABEL}=${owner}`)).toStrictEqual([]);
    });

    it('refuses a tree that does not exist', async () => {
      const error = await rejection(run(['true'], join(scratch, 'missing')));
      expect(error.code).toBe('SANDBOX_REFUSED');
      expect(error.details.reason).toBe('ENOENT');
    });
  });

  describe('limits', () => {
    it('holds a fork bomb at the PID limit and reports that limit', async () => {
      const error = await rejection(
        runner({ pidsLimit: 32, config: config({ timeoutMs: 5_000 }) }).run({
          tree: makeTree(),
          argv: shellCommand('f() { f | f & }; f; sleep 600'),
        }),
      );
      expect(error.code).toBe('SANDBOX_LIMIT');
      expect(error.details.limit).toBe('pids');
      expect(error.message).toMatch(/limit of 32 processes/u);
      expect(error.infra).toBe(true);
      expect(labelledContainers(`${SANDBOX_LABEL}=${owner}`)).toStrictEqual([]);
    });

    it('kills a memory hog and reports it as out of memory', async () => {
      const error = await rejection(
        runner({ config: config({ memoryLimitMb: 96 }) }).run({
          tree: makeTree(),
          argv: node('const a = []; for (;;) a.push(Buffer.alloc(1 << 20, 1));'),
        }),
      );
      expect(error.code).toBe('SANDBOX_LIMIT');
      expect(error.details.limit).toBe('memory');
      expect(error.message).toMatch(/out of memory at 96 MB/u);
    });

    it('kills a busy loop at the wall clock as SANDBOX_TIMEOUT, and leaves no container', async () => {
      const error = await rejection(
        runner({ config: config({ timeoutMs: 1_500 }) }).run({
          tree: makeTree(),
          argv: shellCommand('while :; do :; done'),
        }),
      );
      expect(error.code).toBe('SANDBOX_TIMEOUT');
      expect(error.details.limit).toBe('time');
      expect(error.infra).toBe(true);
      expect(labelledContainers(`${SANDBOX_LABEL}=${owner}`)).toStrictEqual([]);
    });

    it('kills the container when the run is aborted', async () => {
      const controller = new AbortController();
      // Abort on Docker's own report that the container started, so the kill
      // lands on a running container rather than racing its creation.
      const events = spawn('docker', [
        'events',
        '--filter',
        `label=${SANDBOX_LABEL}=${owner}`,
        '--filter',
        'event=start',
        '--format',
        '{{.Action}}',
      ]);
      events.stdout.once('data', () => {
        controller.abort();
      });
      try {
        const error = await rejection(
          // A wall clock far past the test's own timeout: only the abort can
          // end this run in time.
          runner({ config: config({ timeoutMs: 600_000 }) }).run({
            tree: makeTree(),
            argv: ['sleep', '600'],
            signal: controller.signal,
          }),
        );
        expect(error.code).toBe('REQUEST_CANCELLED');
        expect(controller.signal.aborted).toBe(true);
        expect(labelledContainers(`${SANDBOX_LABEL}=${owner}`)).toStrictEqual([]);
      } finally {
        events.kill();
      }
    });
  });

  describe('results', () => {
    it('returns a non-zero exit as a result, with both streams', async () => {
      const result = await run(shellCommand('echo out; echo err >&2; exit 7'));
      expect(result).toMatchObject({
        exitCode: 7,
        stdout: 'out\n',
        stderr: 'err\n',
        stdoutTruncated: false,
        stderrTruncated: false,
      });
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it('caps output and flags the stream that was cut', async () => {
      const result = await runner({ maxOutputBytes: 1024 }).run({
        tree: makeTree(),
        argv: shellCommand("head -c 200000 /dev/zero | tr '\\0' a; echo short >&2"),
      });
      expect(result.stdout).toBe('a'.repeat(1024));
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderr).toBe('short\n');
      expect(result.stderrTruncated).toBe(false);
    });

    it('flags a stream one byte over the cap, and not one exactly at it', async () => {
      const capped = runner({ maxOutputBytes: 1024 });
      const at = await capped.run({
        tree: makeTree(),
        argv: shellCommand("head -c 1024 /dev/zero | tr '\\0' a"),
      });
      expect(at.stdout).toHaveLength(1024);
      expect(at.stdoutTruncated).toBe(false);
      const over = await capped.run({
        tree: makeTree('over'),
        argv: shellCommand("head -c 1025 /dev/zero | tr '\\0' a"),
      });
      expect(over.stdout).toHaveLength(1024);
      expect(over.stdoutTruncated).toBe(true);
    });

    it('redacts secrets in output before returning it', async () => {
      const token = `ghp_${'a1B2'.repeat(9)}`;
      const result = await run(['echo', `token=${token}`]);
      expect(result.stdout).not.toContain(token);
      expect(result.stdout).toContain('[redacted]');
    });
  });

  describe('infrastructure', () => {
    it('reports the daemon down, with a remedy', async () => {
      const error = await rejection(
        runner({ dockerHost: `unix://${join(scratch, 'no-daemon.sock')}` }).run({
          tree: makeTree(),
          argv: ['true'],
        }),
      );
      expect(error.code).toBe('SANDBOX_UNAVAILABLE');
      expect(error.details.reason).toBe('daemon-down');
      expect(error.remedy).toMatch(/Start Docker/u);
    });

    it('reports an absent image and does not pull it', async () => {
      const image = `node:22-alpine@sha256:${'0'.repeat(64)}`;
      const error = await rejection(
        runner({ config: config({ image }) }).run({ tree: makeTree(), argv: ['true'] }),
      );
      expect(error.code).toBe('SANDBOX_UNAVAILABLE');
      expect(error.details.reason).toBe('image-missing');
      expect(error.remedy).toContain(`docker pull ${image}`);
      expect(imagePresent(image)).toBe(false);
    });

    it('finds and removes a container a crashed daemon left behind', async () => {
      const left = spawn('docker', [
        'create',
        '--pull=never',
        '--label',
        `${SANDBOX_LABEL}=${owner}`,
        TEST_IMAGE,
        'sleep',
        '600',
      ]);
      await new Promise((resolve) => left.on('close', resolve));
      expect(labelledContainers(`${SANDBOX_LABEL}=${owner}`)).toHaveLength(1);

      const other = createSandboxRunner({ config: config(), owner: `${owner}-other` });
      expect(await other.reapOrphans()).toBe(0);
      expect(labelledContainers(`${SANDBOX_LABEL}=${owner}`)).toHaveLength(1);

      expect(await runner().reapOrphans()).toBe(1);
      expect(labelledContainers(`${SANDBOX_LABEL}=${owner}`)).toStrictEqual([]);
    });
  });
});
