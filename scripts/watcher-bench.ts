#!/usr/bin/env tsx
/**
 * The watcher's two numbers: what it costs when nothing is happening, and how
 * long it takes to notice when something is.
 *
 * Both are product requirements rather than curiosities. A tool that costs 12%
 * CPU at idle is uninstalled whatever its findings are worth, and the active
 * latency is the budget M2's scheduler is designed against.
 *
 * CPU is measured as a difference against a baseline of the same workload with
 * the watcher switched off, because most of the watcher's cost is `git` in a
 * child process and `process.cpuUsage()` counts only this one. Machine-wide
 * sampling picks the children up; subtracting the baseline removes everything
 * else on the machine, provided the machine is quiet.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRunner } from '../packages/core/src/index.js';
import { createLogger, silentLogger } from '../packages/shared/src/index.js';
import { EventBus } from '../packages/daemon/src/bus/index.js';
import { openStore } from '../packages/daemon/src/store/index.js';
import { createSweep } from '../packages/daemon/src/watcher/sweep.js';
import { createWorktreeWatcher } from '../packages/daemon/src/watcher/worktree-watcher.js';

/** The repository shape the budget is stated against. */
const FILE_COUNT = 10_000;
const WORKTREES = 3;
const IDLE_SECONDS = 30;
const ACTIVE_SECONDS = 60;
/**
 * How often the timer sweeps, standing in for the daemon's own interval.
 *
 * Overridable, because the idle cost is very nearly a function of this alone: a
 * pass captures every worktree, and a capture hashes every file in it.
 */
const SWEEP_INTERVAL_MS = Number(process.env.INTERLOCK_BENCH_SWEEP_MS ?? 5_000);

interface CpuSample {
  readonly idle: number;
  readonly total: number;
}

/** Machine-wide CPU, which is the only measure that sees child processes. */
function sampleCpu(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

function busyFraction(from: CpuSample, to: CpuSample): number {
  const total = to.total - from.total;
  const idle = to.idle - from.idle;
  return total === 0 ? 0 : (total - idle) / total;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index]!;
}

const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

/**
 * A repository the size the budget names, with several worktrees under edit.
 *
 * Files are spread across directories rather than piled into one: a recursive
 * watch registers per directory on Linux, and a flat tree would measure a
 * shape no repository has.
 */
function buildFixture(base: string): { root: string; worktrees: string[] } {
  const root = join(base, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
  git(root, 'config', 'user.name', 'Interlock Bench');
  git(root, 'config', 'user.email', 'bench@example.invalid');

  const perDirectory = 100;
  for (let index = 0; index < FILE_COUNT; index++) {
    const directory = join(root, 'src', `pkg${String(Math.floor(index / perDirectory))}`);
    if (index % perDirectory === 0) mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `file${String(index)}.ts`),
      `export const v${String(index)} = 0;\n`,
    );
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture');

  const worktrees: string[] = [];
  for (let index = 0; index < WORKTREES - 1; index++) {
    const path = join(base, `wt${String(index)}`);
    git(root, 'worktree', 'add', '-q', '-b', `feature${String(index)}`, path);
    worktrees.push(path);
  }
  return { root, worktrees: [root, ...worktrees] };
}

interface Harness {
  readonly stop: () => Promise<void>;
  readonly latencies: number[];
  /** Which branch each worktree is checked out to, so a write can be timed. */
  readonly branchByWorktree: ReadonlyMap<string, string>;
  /** Wall time of one pass over an unchanged repository. */
  readonly timeIdleSweep: () => Promise<number>;
}

/**
 * The daemon's own wiring: filesystem signals into the sweep, the sweep into
 * the bus. Assembled here rather than imported because the composition root is
 * not written yet, and a benchmark of a pipeline nobody connected would measure
 * a shape that never runs.
 */
async function startWatcher(
  root: string,
  worktrees: readonly string[],
  writeTimes: Map<string, number>,
): Promise<Harness> {
  const store = await openStore({ path: ':memory:' });
  const bus = new EventBus({ logger: silentLogger });
  const runner = createGitRunner();
  const sweep = createSweep({ store, bus, runner, dataDir: join(root, '..', 'data') });
  const latencies: number[] = [];

  bus.on('branch.snapshot', (event) => {
    if (event.treeOid === null) return;
    // Timed from the oldest write this snapshot answers, not the newest. Under
    // continuous editing the newest is always within one write interval, which
    // measures how stale the snapshot is rather than how long a change waited —
    // and a change waiting is what a scheduler budget is built on.
    const started = writeTimes.get(event.branchRefId);
    if (started !== undefined) {
      latencies.push(Date.now() - started);
      writeTimes.delete(event.branchRefId);
    }
  });

  await sweep.reconcile(root);

  const branchByWorktree = new Map<string, string>();
  for (const repo of await store.listRepos()) {
    for (const branch of await store.listBranchRefs(repo.id)) {
      if (branch.worktreePath !== null) branchByWorktree.set(branch.worktreePath, branch.id);
    }
  }

  // A reconcile started by a signal outlives the thing that asked for it: the
  // fixture is removed while passes are still in flight, and an unhandled
  // rejection takes the process down after the report has been printed.
  const reconcile = (): void => {
    void sweep.reconcile(root).catch(() => undefined);
  };

  const watcher = createWorktreeWatcher({
    onSignal: (signal) => {
      // The signal is what makes the hash worth doing; a pass with nothing
      // marked reconciles refs and leaves every worktree alone.
      sweep.markChanged(signal.worktreePath);
      reconcile();
    },
  });
  for (const worktree of worktrees) {
    watcher.watch({ worktreePath: worktree, gitDir: join(root, '.git') });
  }

  const timer = setInterval(reconcile, SWEEP_INTERVAL_MS);

  return {
    latencies,
    branchByWorktree,
    timeIdleSweep: async (): Promise<number> => {
      const started = performance.now();
      await sweep.reconcile(root);
      return performance.now() - started;
    },
    stop: async () => {
      clearInterval(timer);
      watcher.close();
      // Let whatever the last signal started finish against a fixture that is
      // still on disk, rather than reporting on a half-torn-down run.
      await sweep.reconcile(root).catch(() => undefined);
      await store.close();
    },
  };
}

/** Rewrite one file per worktree, forever, until told to stop. */
function startEditing(
  worktrees: readonly string[],
  onWrite: (worktree: string) => void,
): () => void {
  let round = 0;
  const timer = setInterval(() => {
    round += 1;
    for (const worktree of worktrees) {
      const path = join(worktree, 'src', 'pkg0', 'file0.ts');
      writeFileSync(path, `export const v0 = ${String(round)};\n`);
      onWrite(worktree);
    }
  }, 200);
  return () => {
    clearInterval(timer);
  };
}

async function main(): Promise<void> {
  // Canonical throughout: git reports resolved paths, and on macOS `/var` is a
  // symlink to `/private/var` — so a worktree keyed on what `mkdtemp` returned
  // never matches the branch git reports for it, and nothing gets timed.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-bench-')));
  const log = createLogger('bench', { level: 'info' });
  try {
    log.info('building fixture', { files: FILE_COUNT, worktrees: WORKTREES });
    const { root, worktrees } = buildFixture(base);

    // Idle: the same wall time with and without the watcher, so what is left
    // after subtracting is the watcher and its children.
    log.info('measuring idle baseline', { seconds: IDLE_SECONDS });
    let from = sampleCpu();
    await sleep(IDLE_SECONDS * 1000);
    const idleBaseline = busyFraction(from, sampleCpu());

    log.info('measuring idle with the watcher', { seconds: IDLE_SECONDS });
    const idleRun = await startWatcher(root, worktrees, new Map());
    from = sampleCpu();
    await sleep(IDLE_SECONDS * 1000);
    const idleWithWatcher = busyFraction(from, sampleCpu());

    // Timed directly, because sampling cannot see a cost this small: the
    // difference above sits inside the noise of any machine doing anything
    // else, and a budget verified against noise is not verified. A pass over an
    // unchanged repository is the whole of the idle cost, so the share of a
    // core it takes is that duration over the interval between passes.
    log.info('timing idle sweep passes');
    const passes: number[] = [];
    for (let index = 0; index < 5; index++) passes.push(await idleRun.timeIdleSweep());
    await idleRun.stop();

    // Active: the editing loop runs in both, so the difference is the watcher's
    // response to it rather than the cost of producing the writes.
    log.info('measuring active baseline', { seconds: ACTIVE_SECONDS });
    let stopEditing = startEditing(worktrees, () => undefined);
    from = sampleCpu();
    await sleep(ACTIVE_SECONDS * 1000);
    const activeBaseline = busyFraction(from, sampleCpu());
    stopEditing();

    log.info('measuring active with the watcher', { seconds: ACTIVE_SECONDS });
    const writeTimes = new Map<string, number>();
    const activeRun = await startWatcher(root, worktrees, writeTimes);
    stopEditing = startEditing(worktrees, (worktree) => {
      const branchRefId = activeRun.branchByWorktree.get(worktree);
      // Only the first write since the last snapshot: the rest are answered by
      // the same one, and overwriting would time the newest instead.
      if (branchRefId !== undefined && !writeTimes.has(branchRefId)) {
        writeTimes.set(branchRefId, Date.now());
      }
    });
    from = sampleCpu();
    await sleep(ACTIVE_SECONDS * 1000);
    const activeWithWatcher = busyFraction(from, sampleCpu());
    stopEditing();
    await activeRun.stop();

    const percent = (fraction: number): number => Number((fraction * 100).toFixed(2));
    const report = {
      files: FILE_COUNT,
      worktrees: WORKTREES,
      sweepIntervalMs: SWEEP_INTERVAL_MS,
      // Both sides of every difference, because the difference alone cannot be
      // read: three points above a busy machine is noise, and three above an
      // idle one is the whole budget.
      idleBaselinePercent: percent(idleBaseline),
      idleWithWatcherPercent: percent(idleWithWatcher),
      idleCpuPercent: percent(idleWithWatcher - idleBaseline),
      activeBaselinePercent: percent(activeBaseline),
      activeWithWatcherPercent: percent(activeWithWatcher),
      activeCpuPercent: percent(activeWithWatcher - activeBaseline),
      idleSweepP50Ms: Number(percentile(passes, 0.5).toFixed(1)),
      idleSweepMaxMs: Number(Math.max(...passes).toFixed(1)),
      // What interval keeps a pass under 2% of one core.
      sweepIntervalForBudgetMs: Math.ceil(percentile(passes, 0.5) / 0.02),
      samples: activeRun.latencies.length,
      p50Ms: percentile(activeRun.latencies, 0.5),
      p95Ms: percentile(activeRun.latencies, 0.95),
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

void main();
