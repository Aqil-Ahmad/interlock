import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/processes.js';

/**
 * The commands autostart runs, through the real call site: what a caller
 * reads back is the exit code and stderr, and a failure is an answer rather
 * than a throw.
 */
describe('runCommand', () => {
  it('answers 0 and stderr for a command that succeeds', async () => {
    const result = await runCommand(process.execPath, ['-e', "process.stderr.write('said')"]);
    expect(result).toStrictEqual({ exitCode: 0, stderr: 'said' });
  });

  it('answers the exit code of a command that fails, without throwing', async () => {
    const result = await runCommand(process.execPath, [
      '-e',
      "process.stderr.write('refused'); process.exit(4)",
    ]);
    expect(result).toStrictEqual({ exitCode: 4, stderr: 'refused' });
  });

  it('answers a binary that is not there as a failure', async () => {
    const result = await runCommand('/nonexistent/interlock-test-binary', []);
    expect(result.exitCode).not.toBe(0);
  });

  it('passes an argument as one argument, never through a shell', async () => {
    const result = await runCommand(process.execPath, [
      '-e',
      'process.stderr.write(process.argv[1])',
      '--',
      '$(touch /tmp/x); `id` | ;',
    ]);
    expect(result.stderr).toBe('$(touch /tmp/x); `id` | ;');
  });
});
