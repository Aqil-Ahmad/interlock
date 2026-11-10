import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runServiceManager } from '../src/processes.js';
import type { ServiceManager } from '../src/processes.js';

/**
 * The commands autostart runs, through the real call site: what a caller
 * reads back is the exit code and stderr, and a failure is an answer rather
 * than a throw.
 *
 * `systemctl` here is a script first on `PATH`, standing in for a service
 * manager this machine may not have; it does what its arguments say.
 */
describe('runServiceManager', () => {
  let bin: string;
  let path: string | undefined;

  beforeEach(() => {
    bin = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-bin-')));
    writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nprintf "%s" "$2" >&2\nexit "$1"\n');
    chmodSync(join(bin, 'systemctl'), 0o755);
    path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  });

  it('answers 0 and stderr for a command that succeeds', async () => {
    expect(await runServiceManager('systemctl', ['0', 'said'])).toStrictEqual({
      exitCode: 0,
      stderr: 'said',
    });
  });

  it('answers the exit code of a command that fails, without throwing', async () => {
    expect(await runServiceManager('systemctl', ['4', 'refused'])).toStrictEqual({
      exitCode: 4,
      stderr: 'refused',
    });
  });

  it('passes an argument as one argument, never through a shell', async () => {
    const result = await runServiceManager('systemctl', ['0', '$(touch /tmp/x); `id` | ;']);
    expect(result.stderr).toBe('$(touch /tmp/x); `id` | ;');
  });

  it('answers a service manager that is not there as a failure, and says why', async () => {
    process.env.PATH = bin;
    const result = await runServiceManager('launchctl', ['print']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('ENOENT');
  });

  it('runs nothing but a service manager', () => {
    expect(() => runServiceManager('sh' as ServiceManager, ['-c', 'true'])).toThrow(
      /Not a service manager/u,
    );
  });
});
