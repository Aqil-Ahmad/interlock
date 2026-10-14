import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { holdDataDir } from '@interlock/daemon';
import type { DataDirHold } from '@interlock/daemon';
import {
  INTERLOCK_PROTOCOL_VERSION,
  configPath,
  logPath,
  runtimePath,
  silentLogger,
  tokenPath,
} from '@interlock/shared';
import type { DaemonRuntime } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureState, describeDiff, diffState } from '../../core/test/support/repo-state.js';
import { autostartItem } from '../src/autostart.js';
import type { AutostartContext } from '../src/autostart.js';
import { runDaemon } from '../src/commands/daemon.js';
import type { DaemonIo } from '../src/commands/daemon.js';

/**
 * `interlock daemon` against real daemons, run as real detached processes.
 *
 * Everything here is a property of processes — what is left running, what is
 * signalled, what survives a crash — so the daemon is the real entry point,
 * run from source through tsx's loader in the same node process, which keeps
 * the pid `start` sees the daemon's own. Every test runs on a fresh temp data
 * dir and port 0, and every daemon a test starts is stopped after it, failing
 * or not.
 */

const ROOT = realpathSync(join(import.meta.dirname, '..', '..', '..'));
const MAIN = join(ROOT, 'packages', 'daemon', 'src', 'main.ts');
const TSCONFIG = join(ROOT, 'tsconfig.check.json');

/** The terminal-active characters a line carries, by code point; newlines are the output's own. */
const controls = (text: string): number[] =>
  [...text]
    .map((character) => character.codePointAt(0) ?? 0)
    .filter((point) => [0x1b, 0x07, 0x9b, 0x202e].includes(point));

interface Call {
  readonly argv: readonly string[];
}

describe('interlock daemon', () => {
  let base: string;
  let dataDir: string;
  let home: string;
  let out: string[];
  let err: string[];
  let signalled: { pid: number; signal: NodeJS.Signals | 0 }[];
  let calls: Call[];
  let answers: string[];
  let interactive: boolean;
  let platform: NodeJS.Platform;
  let failing: string | null;
  let holds: DataDirHold[];
  let servers: Server[];
  let children: ChildProcess[];
  let follow: AbortController;

  const io = (): DaemonIo => ({
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    // The real environment for PATH and git, with the data dir swapped in, so
    // a real INTERLOCK_DATA_DIR never reaches the suite.
    env: { ...process.env, INTERLOCK_DATA_DIR: dataDir, TSX_TSCONFIG_PATH: TSCONFIG },
    interactive,
    ask: (question) => {
      out.push(question);
      return Promise.resolve(answers.shift() ?? '');
    },
    launch: () => ({ command: process.execPath, args: ['--import', 'tsx', MAIN] }),
    autostart: {
      platform,
      home,
      uid: 501,
      run: (file, args) => {
        calls.push({ argv: [file, ...args] });
        return Promise.resolve(
          failing !== null && [file, ...args].join(' ').includes(failing)
            ? { exitCode: 5, stderr: 'refused\n' }
            : { exitCode: 0, stderr: '' },
        );
      },
    },
    home,
    kill: (pid, signal) => {
      signalled.push({ pid, signal });
      process.kill(pid, signal);
    },
    stopped: () => follow.signal,
    startTimeoutMs: 20_000,
    stopTimeoutMs: 20_000,
  });

  /** Autostart with a single absolute entry point, which a source run does not have. */
  const installed = (): DaemonIo => ({
    ...io(),
    launch: () => ({ command: '/usr/local/bin/node', args: ['/opt/interlock/daemon/main.js'] }),
  });

  const daemon = async (...args: string[]): Promise<number> => {
    out = [];
    err = [];
    return runDaemon(args, io());
  };

  const stdout = (): string => out.join('');
  const stderr = (): string => err.join('');

  const published = (): DaemonRuntime | null => {
    try {
      return JSON.parse(readFileSync(runtimePath(dataDir), 'utf8')) as DaemonRuntime;
    } catch {
      return null;
    }
  };

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const config = (value: unknown): void => {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(configPath(dataDir), JSON.stringify(value));
  };

  /** A live process that is not the daemon: what a reused pid would name. */
  const bystander = (): ChildProcess => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    children.push(child);
    return child;
  };

  /** A listener answering health as a daemon would, with whatever it is told. */
  const fakeHealth = async (body: Record<string, unknown>): Promise<number> => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return address.port;
  };

  const publish = (port: number, pid: number): void => {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      runtimePath(dataDir),
      JSON.stringify({ protocolVersion: 1, port, pid, startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    writeFileSync(tokenPath(dataDir), 'a-token\n', { mode: 0o600 });
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-daemon-cli-')));
    dataDir = join(base, 'data');
    home = join(base, 'home');
    mkdirSync(home);
    out = [];
    err = [];
    signalled = [];
    calls = [];
    answers = [];
    interactive = false;
    platform = 'linux';
    failing = null;
    holds = [];
    servers = [];
    children = [];
    follow = new AbortController();
  });

  afterEach(async () => {
    follow.abort();
    for (const hold of holds) hold.release();
    for (const server of servers) server.close();
    for (const child of children) child.kill('SIGKILL');
    // Whatever a test started, stopped through the command when it can be and
    // killed when it cannot, so no daemon outlives the file.
    const runtime = published();
    if (runtime !== null && alive(runtime.pid) && runtime.pid !== process.pid) {
      await runDaemon(['stop'], io()).catch(() => undefined);
      if (alive(runtime.pid)) process.kill(runtime.pid, 'SIGKILL');
    }
    rmSync(base, { recursive: true, force: true });
  });

  describe('arguments', () => {
    it('prints the usage, naming every command and the exit codes', async () => {
      expect(await daemon('--help')).toBe(0);
      for (const word of [
        'start',
        'stop',
        'status',
        'logs',
        'autostart',
        '--purge',
        '64',
        '69',
        '70',
      ]) {
        expect(stdout()).toContain(word);
      }
    });

    it('answers no command with the usage and 64', async () => {
      expect(await daemon()).toBe(64);
      expect(stdout()).toContain('Usage: interlock daemon');
    });

    it('documents the exit codes in every command’s help', async () => {
      for (const sub of ['start', 'stop', 'status', 'logs', 'autostart']) {
        expect(await daemon(sub, '--help')).toBe(0);
        expect(stdout()).toContain('Exit codes');
      }
      await daemon('status', '--help');
      expect(stdout()).toContain('0 running, 69 not running');
    });

    it('refuses an unknown command, an unknown option and a bad line count with 64', async () => {
      expect(await daemon('restart')).toBe(64);
      expect(stderr()).toContain('restart');
      expect(await daemon('start', '--now')).toBe(64);
      expect(stderr()).toContain('--now');
      expect(await daemon('logs', '-n', '1e3')).toBe(64);
      expect(await daemon('logs', '-n')).toBe(64);
      expect(await daemon('stop', '--yes')).toBe(64);
      expect(await daemon('autostart', 'maybe')).toBe(64);
    });

    it('refuses a relative INTERLOCK_DATA_DIR with 64', async () => {
      out = [];
      err = [];
      const code = await runDaemon(['status'], {
        ...io(),
        env: { INTERLOCK_DATA_DIR: 'relative' },
      });
      expect(code).toBe(64);
      expect(stderr()).toContain('INTERLOCK_DATA_DIR');
    });
  });

  describe('start, status and stop', () => {
    it('reports not running with 69, in both forms, creating nothing', async () => {
      expect(await daemon('status')).toBe(69);
      expect(stdout()).toContain('not running');
      expect(await daemon('status', '--json')).toBe(69);
      expect(JSON.parse(stdout())).toMatchObject({ running: false, dataDir });
      expect(existsSync(dataDir)).toBe(false);
    });

    it('starts detached, reports where, is found running, and stops', async () => {
      config({ repos: [], daemon: { port: 0 } });
      expect(await daemon('start')).toBe(0);
      const runtime = published();
      expect(runtime).not.toBeNull();
      expect(stdout()).toContain(`pid ${String(runtime!.pid)}`);
      expect(stdout()).toContain(`port ${String(runtime!.port)}`);
      expect(stdout()).toContain(dataDir);

      expect(await daemon('status')).toBe(0);
      expect(stdout()).toMatch(/^running\n/u);
      expect(stdout()).toContain(`pid       ${String(runtime!.pid)}`);
      expect(stdout()).toContain(`protocol  ${String(INTERLOCK_PROTOCOL_VERSION)}`);
      expect(stdout()).toContain('uptime');
      expect(stdout()).not.toContain('warning');

      expect(await daemon('status', '--json')).toBe(0);
      expect(JSON.parse(stdout())).toMatchObject({
        running: true,
        dataDir,
        pid: runtime!.pid,
        port: runtime!.port,
        protocolVersion: INTERLOCK_PROTOCOL_VERSION,
        protocolMismatch: false,
      });

      // The log is in the data dir, owner-only, and carries its records.
      expect(statSync(logPath(dataDir)).mode & 0o777).toBe(0o600);
      expect(readFileSync(logPath(dataDir), 'utf8')).toContain('"daemon started"');

      expect(await daemon('stop')).toBe(0);
      expect(stdout()).toContain(`stopped (pid ${String(runtime!.pid)})`);
      expect(alive(runtime!.pid)).toBe(false);
      expect(signalled).toContainEqual({ pid: runtime!.pid, signal: 'SIGTERM' });
      expect(await daemon('status')).toBe(69);
    }, 60_000);

    it('leaves a running daemon alone and starts no second one', async () => {
      config({ repos: [], daemon: { port: 0 } });
      expect(await daemon('start')).toBe(0);
      const first = published()!;
      expect(await daemon('start')).toBe(0);
      expect(stdout()).toContain('already running');
      expect(stdout()).toContain(`pid ${String(first.pid)}`);
      expect(published()).toStrictEqual(first);
      // One start's records in the log, not two.
      const starts = readFileSync(logPath(dataDir), 'utf8').split('"daemon started"').length - 1;
      expect(starts).toBe(2);
    }, 60_000);

    it('starts over a runtime file a crashed daemon left', async () => {
      config({ repos: [], daemon: { port: 0 } });
      // Port 1 answers nothing, and the pid is this test runner: alive, and
      // not the daemon.
      publish(1, process.pid);
      expect(await daemon('status')).toBe(69);
      expect(await daemon('start')).toBe(0);
      expect(published()!.pid).not.toBe(process.pid);
      expect(signalled.filter((entry) => entry.pid === process.pid)).toStrictEqual([]);
    }, 60_000);

    it('prints the daemon’s own error, code and remedy when it dies at start', async () => {
      // A port someone else holds: the config loads, and the daemon dies binding.
      const taken = await fakeHealth({});
      config({ repos: [], daemon: { port: taken } });
      expect(await daemon('start')).toBe(70);
      expect(stderr()).toContain('before it was up');
      expect(stderr()).toContain('CONFIG_INVALID: Port');
      expect(stderr()).toContain('already in use');
      expect(stderr()).toContain('set daemon.port to a free port');
      expect(stdout()).toBe('');
      expect(await daemon('status')).toBe(69);
    }, 60_000);

    it('prints a config’s remedy, and starts nothing, when the config is invalid', async () => {
      config({ repo: ['/x'] });
      expect(await daemon('start')).toBe(70);
      expect(stderr()).toContain('CONFIG_INVALID');
      expect(stderr()).toContain(configPath(dataDir));
      expect(existsSync(logPath(dataDir))).toBe(false);
    });

    it('refuses a data dir inside a watched repository before writing its log there', async () => {
      const repo = join(base, 'repo');
      execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', repo], {
        stdio: 'pipe',
      });
      // The config is the one file the test puts there, and it is in the
      // state captured before: what `start` must not add is anything else.
      dataDir = join(repo, '.interlock');
      config({ repos: [repo], daemon: { port: 0 } });
      const before = captureState(repo);

      expect(await daemon('start')).toBe(70);
      expect(stderr()).toContain('inside a watched repository');
      expect(stderr()).toContain('INTERLOCK_DATA_DIR');

      const after = captureState(repo);
      const diff = diffState(before, after);
      expect(diff, describeDiff(diff, before, after)).toStrictEqual({
        changed: [],
        removed: [],
        added: [],
      });
    });

    it('reads only this start’s records when the daemon dies saying nothing', async () => {
      // An error from an earlier run is in the log; this one exits without one.
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        logPath(dataDir),
        `${JSON.stringify({ level: 'error', msg: 'an old failure', remedy: 'an old remedy' })}\n`,
        { mode: 0o600 },
      );
      out = [];
      err = [];
      const code = await runDaemon(['start'], {
        ...io(),
        launch: () => ({ command: process.execPath, args: ['-e', 'process.exit(3)', '--'] }),
      });
      expect(code).toBe(70);
      expect(stderr()).toContain('exited 3 before it was up, and logged no reason');
      expect(stderr()).not.toContain('an old');
    });

    it('stops, and reports, a daemon that never answers', async () => {
      out = [];
      err = [];
      const code = await runDaemon(['start'], {
        ...io(),
        launch: () => ({
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)', '--'],
        }),
        startTimeoutMs: 1_000,
      });
      expect(code).toBe(70);
      expect(stderr()).toContain('DAEMON_START_FAILED');
      expect(stderr()).toContain('did not answer in time');
      const [launched] = signalled;
      expect(launched?.signal).toBe('SIGTERM');
      const deadline = Date.now() + 10_000;
      while (alive(launched!.pid)) {
        if (Date.now() > deadline) throw new Error('the launched process outlived its start');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });

    it('reports a daemon that does not exit after SIGTERM, without escalating', async () => {
      // Confirmed by the hold and the API, and deaf to SIGTERM.
      const deaf = spawn(
        process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        { stdio: 'ignore' },
      );
      children.push(deaf);
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      holds.push(holdDataDir(dataDir, silentLogger));
      const port = await fakeHealth({
        pid: deaf.pid,
        protocolVersion: INTERLOCK_PROTOCOL_VERSION,
        startedAt: new Date().toISOString(),
      });
      publish(port, deaf.pid!);
      // Until node has installed the handler, SIGTERM would still kill it.
      await new Promise((resolve) => setTimeout(resolve, 500));

      out = [];
      err = [];
      expect(await runDaemon(['stop'], { ...io(), stopTimeoutMs: 1_000 })).toBe(70);
      expect(stderr()).toContain('did not exit within 1 s');
      expect(signalled).toStrictEqual([
        { pid: deaf.pid, signal: 'SIGTERM' },
        ...signalled.slice(1).map(() => ({ pid: deaf.pid, signal: 0 })),
      ]);
      expect(alive(deaf.pid!)).toBe(true);
    });

    it('says no daemon is running, with 0, when stopped twice', async () => {
      expect(await daemon('stop')).toBe(0);
      expect(stdout()).toContain('No daemon is running');
    });

    it('never signals a live process the runtime file names when nothing holds the data dir', async () => {
      const victim = bystander();
      publish(1, victim.pid!);
      expect(await daemon('stop')).toBe(0);
      expect(stdout()).toContain('No daemon is running');
      expect(stdout()).toContain('left from one that is gone');
      expect(signalled).toStrictEqual([]);
      expect(alive(victim.pid!)).toBe(true);

      // The test runner itself, the process most certainly alive.
      publish(1, process.pid);
      expect(await daemon('stop')).toBe(0);
      expect(signalled).toStrictEqual([]);
    });

    it('never signals when the hold is held but the API names a different pid', async () => {
      const victim = bystander();
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      holds.push(holdDataDir(dataDir, silentLogger));
      const port = await fakeHealth({
        pid: process.pid,
        protocolVersion: INTERLOCK_PROTOCOL_VERSION,
        startedAt: new Date().toISOString(),
      });
      publish(port, victim.pid!);

      expect(await daemon('stop')).toBe(69);
      expect(stderr()).toContain('Nothing was signalled');
      expect(stderr()).toContain(`pid ${String(process.pid)}`);
      expect(await daemon('status')).toBe(69);
      expect(await daemon('start')).toBe(69);
      expect(signalled).toStrictEqual([]);
      expect(alive(victim.pid!)).toBe(true);
    });

    it('never signals when the hold is held and nothing answers', async () => {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      holds.push(holdDataDir(dataDir, silentLogger));
      publish(1, process.pid);
      expect(await daemon('stop')).toBe(69);
      expect(stderr()).toContain('nothing answered');
      expect(signalled).toStrictEqual([]);
    });

    it('flags a daemon speaking another protocol, still running', async () => {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      holds.push(holdDataDir(dataDir, silentLogger));
      const port = await fakeHealth({
        pid: process.pid,
        protocolVersion: INTERLOCK_PROTOCOL_VERSION + 1,
        startedAt: new Date(Date.now() - 3_723_000).toISOString(),
      });
      publish(port, process.pid);

      expect(await daemon('status')).toBe(0);
      expect(stdout()).toContain('warning: the daemon speaks protocol');
      expect(stdout()).toContain('uptime    1h 2m 3s');
      expect(await daemon('status', '--json')).toBe(0);
      expect(JSON.parse(stdout())).toMatchObject({
        running: true,
        protocolVersion: INTERLOCK_PROTOCOL_VERSION + 1,
        cliProtocolVersion: INTERLOCK_PROTOCOL_VERSION,
        protocolMismatch: true,
      });
    });
  });

  describe('logs', () => {
    const write = (...lines: string[]): void => {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      appendFileSync(logPath(dataDir), lines.map((line) => `${line}\n`).join(''), { mode: 0o600 });
    };
    const record = (msg: string, fields: Record<string, unknown> = {}): string =>
      JSON.stringify({
        time: '2026-10-14T10:00:00.000Z',
        level: 'info',
        component: 'daemon',
        msg,
        ...fields,
      });

    it('says there is no log with 69', async () => {
      expect(await daemon('logs')).toBe(69);
      expect(stderr()).toContain('No daemon log');
    });

    it('prints the last lines readably, the previous file included', async () => {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(`${logPath(dataDir)}.1`, `${record('older')}\n`);
      write(record('one', { port: 4 }), record('two'), record('three'));
      expect(await daemon('logs')).toBe(0);
      expect(stdout()).toBe(
        [
          '2026-10-14T10:00:00.000Z INFO  daemon: older',
          '2026-10-14T10:00:00.000Z INFO  daemon: one port=4',
          '2026-10-14T10:00:00.000Z INFO  daemon: two',
          '2026-10-14T10:00:00.000Z INFO  daemon: three',
          '',
        ].join('\n'),
      );
      expect(await daemon('logs', '-n', '2')).toBe(0);
      expect(stdout().trim().split('\n')).toHaveLength(2);
      expect(stdout()).toContain('three');
      expect(await daemon('logs', '-n', '0')).toBe(0);
      expect(stdout()).toBe('');
    });

    it('escapes terminal control characters in every field, in both forms', async () => {
      write(
        record('evil \u001b]0;pwned\u0007 msg', { path: 'a\u009b2Jb', 'k\u001b[31m': 'c\u202ed' }),
        'a crash trace \u001b[2J with no JSON',
      );
      expect(await daemon('logs')).toBe(0);
      const text = stdout();
      expect(controls(text)).toStrictEqual([]);
      expect(text).toContain('evil \\x1b]0;pwned\\x07 msg');
      expect(text).toContain('a\\x9b2Jb');
      expect(text).toContain('c\\u{202e}d');
      expect(text).toContain('a crash trace \\x1b[2J with no JSON');

      expect(await daemon('logs', '--json')).toBe(0);
      const json = stdout();
      expect(controls(json)).toStrictEqual([]);
      const lines = json
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      // The same characters, back out of the JSON: escaped, not lost.
      expect(lines[0]).toMatchObject({ msg: 'evil \u001b]0;pwned\u0007 msg', path: 'a\u009b2Jb' });
      expect(lines[1]).toStrictEqual({ raw: 'a crash trace \u001b[2J with no JSON' });
    });

    it('follows the file as it grows and across a rotation', async () => {
      write(record('before'));
      const done = runDaemon(['logs', '--follow', '-n', '1'], io());
      const until = async (text: string): Promise<void> => {
        const deadline = Date.now() + 10_000;
        while (!out.join('').includes(text)) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${text}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };
      await until('before');
      // Half a line, then the rest: printed once it is whole.
      appendFileSync(logPath(dataDir), record('grown').slice(0, 10));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(out.join('')).not.toContain('grown');
      appendFileSync(logPath(dataDir), `${record('grown').slice(10)}\n`);
      await until('grown');
      renameSync(logPath(dataDir), `${logPath(dataDir)}.1`);
      write(record('after rotation'));
      await until('after rotation');
      follow.abort();
      expect(await done).toBe(0);
      expect(out.join('').split('grown').length - 1).toBe(1);
    });
  });

  describe('autostart', () => {
    const context = (overrides: Partial<AutostartContext> = {}): AutostartContext => ({
      platform: 'linux',
      home,
      uid: 501,
      node: '/usr/local/bin/node',
      entry: '/opt/interlock/daemon/main.js',
      dataDir,
      run: () => Promise.resolve({ exitCode: 0, stderr: '' }),
      ...overrides,
    });

    it('installs and loads a systemd user unit naming absolute paths, and removes it', async () => {
      out = [];
      err = [];
      expect(await runDaemon(['autostart', 'on'], installed())).toBe(0);
      const item = autostartItem(context());
      expect(item.path).toBe(join(home, '.config', 'systemd', 'user', item.name));
      expect(readFileSync(item.path, 'utf8')).toBe(item.content);
      expect(item.content).toContain(
        'ExecStart="/usr/local/bin/node" "/opt/interlock/daemon/main.js" --log-to-file',
      );
      expect(item.content).toContain(`Environment="INTERLOCK_DATA_DIR=${dataDir}"`);
      expect(item.content).not.toMatch(/Restart=/u);
      expect(calls.map((call) => call.argv.join(' '))).toStrictEqual([
        'systemctl --user daemon-reload',
        `systemctl --user enable --now ${item.name}`,
      ]);

      calls = [];
      expect(await runDaemon(['autostart', 'off'], installed())).toBe(0);
      expect(existsSync(item.path)).toBe(false);
      expect(calls.map((call) => call.argv.join(' '))).toStrictEqual([
        `systemctl --user disable --now ${item.name}`,
        'systemctl --user daemon-reload',
      ]);
      expect(await runDaemon(['autostart', 'off'], installed())).toBe(0);
      expect(out.join('')).toContain('was not on');
    });

    it('installs and loads a launchd agent, and boots it out', async () => {
      platform = 'darwin';
      expect(await runDaemon(['autostart', 'on'], installed())).toBe(0);
      const item = autostartItem(context({ platform: 'darwin' }));
      expect(item.path).toBe(join(home, 'Library', 'LaunchAgents', `${item.name}.plist`));
      expect(readFileSync(item.path, 'utf8')).toBe(item.content);
      expect(item.content).toContain('<string>/usr/local/bin/node</string>');
      expect(item.content).toContain('<string>/opt/interlock/daemon/main.js</string>');
      expect(item.content).toContain('<string>--log-to-file</string>');
      expect(item.content).toContain(
        `<key>INTERLOCK_DATA_DIR</key>\n    <string>${dataDir}</string>`,
      );
      expect(item.content).toMatch(/<key>KeepAlive<\/key>\n {2}<false\/>/u);
      expect(calls.map((call) => call.argv)).toStrictEqual([
        ['launchctl', 'bootstrap', 'gui/501', item.path],
      ]);

      calls = [];
      expect(await runDaemon(['autostart', 'off'], installed())).toBe(0);
      expect(calls.map((call) => call.argv)).toStrictEqual([
        ['launchctl', 'bootout', `gui/501/${item.name}`],
      ]);
      expect(existsSync(item.path)).toBe(false);
    });

    it('gives each data dir its own item', () => {
      expect(autostartItem(context()).name).not.toBe(
        autostartItem(context({ dataDir: `${dataDir}2` })).name,
      );
    });

    it('escapes what systemd and launchd would read as syntax', () => {
      const odd = '/tmp/a "b" %h $HOME \\ & <c>';
      const unit = autostartItem(context({ dataDir: odd, entry: '/opt/$x/%i.js' })).content;
      expect(unit).toContain(
        'Environment="INTERLOCK_DATA_DIR=/tmp/a \\"b\\" %%h $$HOME \\\\ & <c>"',
      );
      expect(unit).toContain('"/opt/$$x/%%i.js"');
      expect(unit).toContain('Description=Interlock daemon for /tmp/a "b" %%h $HOME \\ & <c>');
      const plist = autostartItem(context({ platform: 'darwin', dataDir: odd })).content;
      expect(plist).toContain('<string>/tmp/a &quot;b&quot; %h $HOME \\ &amp; &lt;c&gt;</string>');
    });

    it('refuses a path it cannot write faithfully, and a platform it does not know', () => {
      expect(() => autostartItem(context({ dataDir: '/tmp/a\nExecStart=/bin/sh' }))).toThrow(
        /cannot be written/u,
      );
      expect(() => autostartItem(context({ entry: 'relative.js' }))).toThrow(/cannot be written/u);
      expect(() => autostartItem(context({ platform: 'win32' }))).toThrow(/not supported/u);
    });

    it('leaves nothing installed when the load fails', async () => {
      failing = 'enable';
      expect(await runDaemon(['autostart', 'on'], installed())).toBe(70);
      expect(err.join('')).toContain('could not load');
      expect(existsSync(autostartItem(context()).path)).toBe(false);
    });

    it('replaces an item already installed, unloading it first', async () => {
      expect(await runDaemon(['autostart', 'on'], installed())).toBe(0);
      calls = [];
      expect(await runDaemon(['autostart', 'on'], installed())).toBe(0);
      expect(calls[0]!.argv.slice(0, 4)).toStrictEqual(['systemctl', '--user', 'disable', '--now']);
    });

    it('refuses to install from a run with no single entry point', async () => {
      expect(await daemon('autostart', 'on')).toBe(70);
      expect(stderr()).toContain('entry point');
    });
  });

  describe('stop --purge', () => {
    it('refuses without a terminal unless given --yes, deleting nothing', async () => {
      config({ repos: [], daemon: { port: 0 } });
      writeFileSync(join(dataDir, 'daemon.lock'), '');
      expect(await daemon('stop', '--purge')).toBe(64);
      expect(stderr()).toContain('--yes');
      expect(existsSync(configPath(dataDir))).toBe(true);
    });

    it('refuses a directory that is not Interlock’s, before asking anything', async () => {
      mkdirSync(dataDir);
      writeFileSync(join(dataDir, 'daemon.lock'), '');
      writeFileSync(join(dataDir, 'notes.txt'), 'mine\n');
      interactive = true;
      answers = ['yes'];
      expect(await daemon('stop', '--purge')).toBe(64);
      expect(stderr()).toContain('did not write');
      expect(stdout()).toBe('');
      expect(readFileSync(join(dataDir, 'notes.txt'), 'utf8')).toBe('mine\n');
    });

    it('refuses the home directory', async () => {
      dataDir = home;
      writeFileSync(join(home, 'daemon.lock'), '');
      expect(await daemon('stop', '--purge', '--yes')).toBe(64);
      expect(existsSync(join(home, 'daemon.lock'))).toBe(true);
    });

    it('asks, and deletes nothing on anything but yes', async () => {
      config({ repos: [], daemon: { port: 0 } });
      expect(await daemon('start')).toBe(0);
      interactive = true;
      answers = ['n'];
      expect(await daemon('stop', '--purge')).toBe(0);
      expect(stdout()).toContain('cannot be undone');
      expect(stdout()).toContain('MiB');
      expect(stdout()).toContain('Nothing was deleted');
      expect(await daemon('status')).toBe(0);
    }, 60_000);

    it('stops the daemon, removes autostart, deletes everything, reports the size, and starts again from nothing', async () => {
      config({ repos: [], daemon: { port: 0 } });
      expect(await runDaemon(['autostart', 'on'], installed())).toBe(0);
      expect(await daemon('start')).toBe(0);
      const pid = published()!.pid;
      interactive = true;
      answers = ['y'];

      out = [];
      err = [];
      expect(await runDaemon(['stop', '--purge'], installed())).toBe(0);
      expect(stdout()).toContain(`stopped (pid ${String(pid)})`);
      expect(stdout()).toContain('Autostart is off');
      expect(stdout()).toMatch(/Purged .*: \d+\.\d MiB reclaimed/u);
      expect(alive(pid)).toBe(false);
      expect(existsSync(dataDir)).toBe(false);
      expect(
        existsSync(
          autostartItem({
            ...installed().autostart,
            node: '/usr/local/bin/node',
            entry: '/opt/interlock/daemon/main.js',
            dataDir,
          }).path,
        ),
      ).toBe(false);

      expect(await daemon('start')).toBe(0);
      expect(await daemon('status')).toBe(0);
    }, 90_000);

    it('purges with --yes and no terminal, and says when there is nothing to purge', async () => {
      config({ repos: [], daemon: { port: 0 } });
      expect(await daemon('start')).toBe(0);
      expect(await daemon('stop', '--purge', '--yes')).toBe(0);
      expect(existsSync(dataDir)).toBe(false);
      expect(await daemon('stop', '--purge', '--yes')).toBe(0);
      expect(stdout()).toContain('Nothing to purge');
    }, 60_000);

    it('leaves a watched repository byte-identical', async () => {
      const repo = join(base, 'repo');
      const git = (...args: string[]): string =>
        execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' });
      execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', repo], {
        stdio: 'pipe',
      });
      git('config', 'user.name', 'Interlock Test');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'maintenance.auto', 'false');
      git('config', 'gc.auto', '0');
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      git('add', '-A');
      git('commit', '-qm', 'one');
      writeFileSync(join(repo, 'a.txt'), 'uncommitted\n');
      config({ repos: [repo], daemon: { port: 0 } });

      expect(await daemon('start')).toBe(0);
      // Until the daemon has built the shadow that borrows the repository's objects.
      const deadline = Date.now() + 20_000;
      while (!existsSync(join(dataDir, 'shadows'))) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the shadow');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(await daemon('stop')).toBe(0);
      const before = captureState(repo);
      expect(await daemon('stop', '--purge', '--yes')).toBe(0);
      const after = captureState(repo);
      const diff = diffState(before, after);
      expect(diff, describeDiff(diff, before, after)).toStrictEqual({
        changed: [],
        removed: [],
        added: [],
      });
      expect(existsSync(dataDir)).toBe(false);
    }, 90_000);

    it('refuses a data dir inside a watched repository', async () => {
      const repo = join(base, 'repo');
      execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', repo], {
        stdio: 'pipe',
      });
      dataDir = join(repo, 'state');
      config({ repos: [repo] });
      writeFileSync(join(dataDir, 'daemon.lock'), '');
      expect(await daemon('stop', '--purge', '--yes')).toBe(64);
      expect(stderr()).toContain('inside a watched repository');
      expect(existsSync(join(dataDir, 'daemon.lock'))).toBe(true);
    });
  });
});
