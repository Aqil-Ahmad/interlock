#!/usr/bin/env tsx
/**
 * The scheduler's numbers, with five branches under continuous edit: what the
 * daemon costs idle and under edit, how long a conflicting edit takes to become
 * a Finding, how deep the queue gets, and how often clean merges escalate and
 * escalations evict.
 *
 * CPU is machine-wide and measured as a difference against a baseline of the
 * same workload — see `watcher-bench.ts` for why — and each phase is run three
 * ways: the edits alone, the watcher alone, and the watcher with the scheduler
 * and run pipeline behind it. The last two differ by what this task added.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRunner } from '../packages/core/src/index.js';
import { createLogger, resolveConfig, silentLogger } from '../packages/shared/src/index.js';
import type { MergeConflictEvidence } from '../packages/shared/src/index.js';
import { EventBus } from '../packages/daemon/src/bus/index.js';
import { createScheduler } from '../packages/daemon/src/scheduler/index.js';
import type { Scheduler, SchedulerStats } from '../packages/daemon/src/scheduler/index.js';
import { createRunPipeline } from '../packages/daemon/src/scheduler/run-pipeline.js';
import { createShadowRegistry } from '../packages/daemon/src/shadows.js';
import { openStore } from '../packages/daemon/src/store/index.js';
import { createWatcher } from '../packages/daemon/src/watcher/index.js';

const FILE_COUNT = Number(process.env.INTERLOCK_BENCH_FILES ?? 10_000);
const BRANCHES = 5;
const IDLE_SECONDS = Number(process.env.INTERLOCK_BENCH_IDLE_S ?? 30);
const ACTIVE_SECONDS = Number(process.env.INTERLOCK_BENCH_ACTIVE_S ?? 60);
/** Each branch writes this often: an agent mid-task, not a person typing. */
const EDIT_INTERVAL_MS = 1_000;
/** A new conflict is planted between two branches this often. */
const PLANT_INTERVAL_MS = 10_000;
/** Long enough for the first pass over every worktree to finish. */
const WARM_UP_MS = 20_000;

interface CpuSample {
  readonly idle: number;
  readonly total: number;
}

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
  return total === 0 ? 0 : (total - (to.idle - from.idle)) / total;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

function buildFixture(base: string): { root: string; worktrees: string[] } {
  const root = join(base, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
  git(root, 'config', 'user.name', 'Interlock Bench');
  git(root, 'config', 'user.email', 'bench@example.invalid');
  git(root, 'config', 'maintenance.auto', 'false');
  git(root, 'config', 'gc.auto', '0');
  const perDirectory = 100;
  for (let index = 0; index < FILE_COUNT; index++) {
    const directory = join(root, 'src', `pkg${String(Math.floor(index / perDirectory))}`);
    if (index % perDirectory === 0) mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `file${String(index)}.ts`),
      `export const v${String(index)} = 0;\n`,
    );
  }
  mkdirSync(join(root, 'src', 'shared'), { recursive: true });
  writeFileSync(join(root, 'src', 'shared', 'index.ts'), 'export {};\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture');

  const worktrees: string[] = [];
  for (let index = 0; index < BRANCHES; index++) {
    const path = join(base, `wt${String(index)}`);
    git(root, 'worktree', 'add', '-q', '-b', `agent${String(index)}`, path);
    worktrees.push(path);
  }
  return { root, worktrees };
}

/**
 * Every branch rewrites a file of its own in a package of its own — nothing in
 * common, so those pairs are declined — and one in a shared directory, so every
 * pair overlaps by directory and merges cleanly: the escalation candidates.
 */
function startEditing(worktrees: readonly string[]): () => void {
  let round = 0;
  const timer = setInterval(() => {
    round += 1;
    worktrees.forEach((worktree, index) => {
      const own = join(worktree, 'src', `pkg${String(index)}`, `file${String(index * 100)}.ts`);
      writeFileSync(own, `export const v${String(index * 100)} = ${String(round)};\n`);
      writeFileSync(
        join(worktree, 'src', 'shared', `agent${String(index)}.ts`),
        `export const round = ${String(round)};\n`,
      );
    });
  }, EDIT_INTERVAL_MS);
  return () => {
    clearInterval(timer);
  };
}

interface System {
  readonly scheduler: Scheduler | null;
  /** Edit-to-Finding, per planted conflict. */
  readonly latencies: number[];
  readonly planted: () => number;
  plant(): void;
  stop(): Promise<void>;
}

async function startSystem(
  root: string,
  worktrees: readonly string[],
  withScheduler: boolean,
  dataDir: string,
): Promise<System> {
  const config = resolveConfig({ dataDir, repos: [root], daemon: { port: 0 } });
  const store = await openStore({ path: ':memory:' });
  const bus = new EventBus({ logger: silentLogger });
  const runner = createGitRunner();
  const shadows = createShadowRegistry({ runner, dataDir });
  const latencies: number[] = [];
  const plantedAt = new Map<string, number>();
  let planted = 0;

  let scheduler: Scheduler | null = null;
  let pipeline: ReturnType<typeof createRunPipeline> | null = null;
  if (withScheduler) {
    const runs = createRunPipeline({ store, bus, runner, shadows });
    pipeline = runs;
    runs.attach();
    scheduler = createScheduler({
      config,
      bus,
      logger: silentLogger,
      plan: (repoId, branch) => runs.plan(repoId, branch),
      runPair: (request, signal) => runs.runPair(request, signal),
    });
    scheduler.start();
    bus.on('finding.raised', async (event) => {
      const finding = await store.getFinding(event.findingId);
      const merge = finding?.evidence.find(
        (e): e is MergeConflictEvidence => e.type === 'merge-conflict',
      );
      const started = merge === undefined ? undefined : plantedAt.get(merge.path);
      if (started !== undefined) {
        latencies.push(Date.now() - started);
        plantedAt.delete(merge!.path);
      }
    });
  }

  const watcher = createWatcher({ config, store, bus, runner, shadows, logger: silentLogger });
  await watcher.start();

  return {
    scheduler,
    latencies,
    planted: () => planted,
    plant(): void {
      // Two branches, taking turns, add the same file with different content.
      planted += 1;
      const path = `src/shared/conflict${String(planted)}.ts`;
      const [one, two] = [planted % BRANCHES, (planted + 1) % BRANCHES];
      plantedAt.set(path, Date.now());
      writeFileSync(join(worktrees[one]!, path), `export const side = ${String(one)};\n`);
      writeFileSync(join(worktrees[two]!, path), `export const side = ${String(two)};\n`);
    },
    async stop(): Promise<void> {
      await watcher.stop();
      await scheduler?.stop();
      pipeline?.detach();
      await store.close();
    },
  };
}

async function measure(seconds: number): Promise<number> {
  const from = sampleCpu();
  await sleep(seconds * 1000);
  return busyFraction(from, sampleCpu());
}

async function main(): Promise<void> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-scheduler-bench-')));
  const log = createLogger('bench', { level: 'info' });
  try {
    log.info('building fixture', { files: FILE_COUNT, branches: BRANCHES });
    const { root, worktrees } = buildFixture(base);

    log.info('idle: baseline, watcher alone, watcher with scheduler', { seconds: IDLE_SECONDS });
    const idleBaseline = await measure(IDLE_SECONDS);
    // The same warm-up for both: the first pass hashes every worktree, and
    // measuring before it ends reads start-up as idle.
    let system = await startSystem(root, worktrees, false, join(base, 'data-watcher'));
    await sleep(WARM_UP_MS);
    const idleWatcher = await measure(IDLE_SECONDS);
    await system.stop();
    system = await startSystem(root, worktrees, true, join(base, 'data-full'));
    await sleep(WARM_UP_MS);
    await system.scheduler!.idle();
    // The one idle cost the scheduler can have is work: a branch settled while
    // nothing changed. Counted directly, since sampling cannot see zero.
    const settledBeforeIdle = system.scheduler!.stats.settled;
    const idleFull = await measure(IDLE_SECONDS);
    const idleSettled = system.scheduler!.stats.settled - settledBeforeIdle;
    await system.stop();

    log.info('active: baseline, watcher alone, watcher with scheduler', {
      seconds: ACTIVE_SECONDS,
    });
    let stopEditing = startEditing(worktrees);
    const activeBaseline = await measure(ACTIVE_SECONDS);
    stopEditing();
    system = await startSystem(root, worktrees, false, join(base, 'data-watcher'));
    stopEditing = startEditing(worktrees);
    const activeWatcher = await measure(ACTIVE_SECONDS);
    stopEditing();
    await system.stop();

    system = await startSystem(root, worktrees, true, join(base, 'data-full'));
    stopEditing = startEditing(worktrees);
    const planting = setInterval(() => {
      system.plant();
    }, PLANT_INTERVAL_MS);
    const activeFull = await measure(ACTIVE_SECONDS);
    clearInterval(planting);
    stopEditing();
    // Findings for conflicts planted near the end still count.
    await sleep(20_000);
    const stats: SchedulerStats = system.scheduler!.stats;
    await system.stop();

    const percent = (fraction: number): number => Number((fraction * 100).toFixed(2));
    console.log(
      JSON.stringify(
        {
          files: FILE_COUNT,
          branches: BRANCHES,
          cores: cpus().length,
          idleBaselinePercent: percent(idleBaseline),
          idleWatcherPercent: percent(idleWatcher - idleBaseline),
          idleFullPercent: percent(idleFull - idleBaseline),
          idleSchedulerPercent: percent(idleFull - idleWatcher),
          activeBaselinePercent: percent(activeBaseline),
          activeWatcherPercent: percent(activeWatcher - activeBaseline),
          activeFullPercent: percent(activeFull - activeBaseline),
          activeSchedulerPercent: percent(activeFull - activeWatcher),
          idleSettled,
          planted: system.planted(),
          findings: system.latencies.length,
          editToFindingP50Ms: percentile(system.latencies, 0.5),
          editToFindingMaxMs: Math.max(...system.latencies),
          maxQueueDepth: stats.maxQueueDepth,
          settled: stats.settled,
          declined: stats.noOverlap,
          started: stats.started,
          analysed: stats.analysed,
          duplicates: stats.duplicates,
          superseded: stats.superseded,
          failures: stats.failures,
          escalations: stats.escalations,
          deferred: stats.deferred,
          evictions: stats.evictions,
          escalationRate: stats.escalationRate,
          evictionRate: stats.evictionRate,
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

void main();
