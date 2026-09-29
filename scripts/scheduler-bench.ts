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
 *
 * `INTERLOCK_BENCH_MODE=retention` runs the same edits against a store on disk,
 * with the retention window compressed to minutes, and samples row counts and
 * file size, and the shadow's own objects, collected in each pass: growth per
 * hour before anything ages out, and whether all of it goes flat once it does. `INTERLOCK_BENCH_MODE=large-prune` times one pass over a
 * large synthetic backlog, and one over an hour's worth of rows after it.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGitRunner } from '../packages/core/src/index.js';
import type { CollectReport } from '../packages/core/src/index.js';
import { createLogger, resolveConfig, silentLogger } from '../packages/shared/src/index.js';
import type { MergeConflictEvidence } from '../packages/shared/src/index.js';
import { EventBus } from '../packages/daemon/src/bus/index.js';
import { createScheduler } from '../packages/daemon/src/scheduler/index.js';
import type { Scheduler, SchedulerStats } from '../packages/daemon/src/scheduler/index.js';
import { createRunPipeline } from '../packages/daemon/src/scheduler/run-pipeline.js';
import { createRetention } from '../packages/daemon/src/retention.js';
import type { Retention } from '../packages/daemon/src/retention.js';
import { createShadowCollector, createShadowRegistry } from '../packages/daemon/src/shadows.js';
import { openStore } from '../packages/daemon/src/store/index.js';
import type { PruneReport } from '../packages/daemon/src/store/index.js';
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

interface SystemOptions {
  /** A file, for measuring what a store on disk costs; `:memory:` otherwise. */
  readonly storePath?: string;
  readonly retention?: { readonly windowMs: number; readonly intervalMs: number };
  /** Undo a planted conflict this long after planting it, as an agent resolving it would. */
  readonly resolveAfterMs?: number;
}

interface System {
  readonly scheduler: Scheduler | null;
  /** Every retention pass's report, in order. */
  readonly passes: PruneReport[];
  /** Every shadow collection's report, in order. */
  readonly collections: CollectReport[];
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
  options: SystemOptions = {},
): Promise<System> {
  const config = resolveConfig({ dataDir, repos: [root], daemon: { port: 0 } });
  const store = await openStore({ path: options.storePath ?? ':memory:' });
  // Persisted as the daemon persists them, in order: the event log is the
  // largest table a busy store has, and a bench without it measures the rest.
  let appends: Promise<void> = Promise.resolve();
  const passes: PruneReport[] = [];
  const collections: CollectReport[] = [];
  let retention: Retention | null = null;
  const bus = new EventBus({
    logger: silentLogger,
    onRecord: (record) => {
      appends = appends.then(() => store.appendEvent(record));
    },
  });
  const runner = createGitRunner();
  const shadows = createShadowRegistry({ runner, dataDir });
  const latencies: number[] = [];
  const plantedAt = new Map<string, number>();
  let planted = 0;

  let scheduler: Scheduler | null = null;
  let pipeline: ReturnType<typeof createRunPipeline> | null = null;
  // A day compresses the reuse bound with it, at the ratio the defaults have:
  // left at an hour, every snapshot commit would outlive a window of minutes.
  const commitReuseMs =
    options.retention === undefined ? undefined : Math.round(options.retention.windowMs / 24);
  if (withScheduler) {
    const runs = createRunPipeline({
      store,
      bus,
      runner,
      shadows,
      ...(commitReuseMs === undefined ? {} : { commitReuseMs }),
    });
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

  if (options.retention !== undefined) {
    const logger = createLogger('bench', {
      level: 'info',
      sink: (record) => {
        if (record.msg === 'pruned the store') passes.push(record as unknown as PruneReport);
        if (record.msg === 'collected the shadow') {
          collections.push(record as unknown as CollectReport);
        }
        if (record.level === 'warn') console.error(JSON.stringify(record));
      },
    });
    const runs = pipeline;
    const collector = createShadowCollector({
      shadows,
      store,
      runner,
      heldTrees: (repoId) => runs?.heldTrees(repoId) ?? [],
      marginMs: commitReuseMs!,
      logger,
    });
    retention = createRetention({
      store,
      windowMs: options.retention.windowMs,
      intervalMs: options.retention.intervalMs,
      logger,
      collect: (before, signal) => collector.pass(before, signal),
    });
    retention.start();
  }

  const watcher = createWatcher({ config, store, bus, runner, shadows, logger: silentLogger });
  await watcher.start();

  const resolving = new Set<ReturnType<typeof setTimeout>>();

  return {
    scheduler,
    passes,
    collections,
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
      if (options.resolveAfterMs !== undefined) {
        const timer = setTimeout(() => {
          resolving.delete(timer);
          const file = join(worktrees[two]!, path);
          if (existsSync(file)) unlinkSync(file);
        }, options.resolveAfterMs);
        resolving.add(timer);
      }
    },
    async stop(): Promise<void> {
      for (const timer of resolving) clearTimeout(timer);
      await retention?.stop();
      await watcher.stop();
      await scheduler?.stop();
      pipeline?.detach();
      await appends;
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

/** Rows per table, and the database's size on disk with its write-ahead log. */
function sampleStore(path: string): Record<string, number> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const counts: Record<string, number> = {};
    for (const table of [
      'events',
      'speculative_runs',
      'findings',
      'evidence',
      'change_sets',
      'analyzer_cache',
      'merge_pairs',
    ]) {
      counts[table] = Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0);
    }
    const wal = `${path}-wal`;
    counts.bytes = statSync(path).size + (existsSync(wal) ? statSync(wal).size : 0);
    counts.walBytes = existsSync(wal) ? statSync(wal).size : 0;
    // Pages the file holds, and how many of them are free for reuse: a file
    // that stops growing while the free list is used up is reusing, not leaking.
    counts.pages = Number(db.prepare('PRAGMA page_count').get()?.page_count ?? 0);
    counts.freePages = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0);
    return counts;
  } finally {
    db.close();
  }
}

/**
 * Every shadow's own objects: loose ones by count and bytes, and packs by bytes.
 * The user's objects, borrowed through alternates, are not the shadow's.
 */
function sampleShadows(dataDir: string): Record<string, number> {
  const counts = { shadowLoose: 0, shadowLooseBytes: 0, shadowPackBytes: 0 };
  const shadowsDir = join(dataDir, 'shadows');
  if (!existsSync(shadowsDir)) return counts;
  for (const shadow of readdirSync(shadowsDir)) {
    const objects = join(shadowsDir, shadow, 'objects');
    for (const dir of readdirSync(objects)) {
      if (/^[0-9a-f]{2}$/u.test(dir)) {
        for (const file of readdirSync(join(objects, dir))) {
          // git writes an object as a temporary file and renames it, and a
          // collection may unlink one between the listing and the stat.
          if (file.startsWith('tmp_')) continue;
          const stat = statSync(join(objects, dir, file), { throwIfNoEntry: false });
          if (stat === undefined) continue;
          counts.shadowLoose += 1;
          counts.shadowLooseBytes += stat.size;
        }
      } else if (dir === 'pack') {
        for (const file of readdirSync(join(objects, dir))) {
          counts.shadowPackBytes += statSync(join(objects, dir, file)).size;
        }
      }
    }
  }
  return counts;
}

/**
 * A day of continuous edits, compressed: the window is minutes rather than
 * days, so the store reaches the steady state a day would put it in — rows
 * aging out as fast as they arrive — within the run.
 */
async function retentionMain(): Promise<void> {
  const windowMs = Number(process.env.INTERLOCK_BENCH_WINDOW_MS ?? 3 * 60_000);
  const windows = Number(process.env.INTERLOCK_BENCH_WINDOWS ?? 4);
  const sampleMs = windowMs / 6;
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-retention-bench-')));
  const log = createLogger('bench', { level: 'info' });
  try {
    log.info('building fixture', { files: FILE_COUNT, branches: BRANCHES });
    const { root, worktrees } = buildFixture(base);
    const dataDir = join(base, 'data');
    const storePath = join(dataDir, 'interlock.db');
    const system = await startSystem(root, worktrees, true, dataDir, {
      storePath,
      retention: { windowMs, intervalMs: sampleMs },
      resolveAfterMs: 30_000,
    });
    const stopEditing = startEditing(worktrees);
    const planting = setInterval(() => {
      system.plant();
    }, PLANT_INTERVAL_MS);

    log.info('editing', { windowMs, windows, sampleMs });
    const startedAt = Date.now();
    const samples: Record<string, number>[] = [];
    while (Date.now() - startedAt < windowMs * windows) {
      await sleep(sampleMs);
      const sample = { minute: Number(((Date.now() - startedAt) / 60_000).toFixed(1)) };
      const taken = { ...sample, ...sampleStore(storePath), ...sampleShadows(dataDir) };
      samples.push(taken);
      log.info('sample', taken);
    }
    clearInterval(planting);
    stopEditing();
    const stats = system.scheduler!.stats;
    await system.stop();

    // Growth from the first window alone, before anything is old enough to go.
    const firstWindow = samples.filter((sample) => sample.minute! <= windowMs / 60_000);
    const edge = firstWindow.at(-1)!;
    const start = samples[0]!;
    // From the first sample, not from zero: an empty store already has a size.
    const perHour = (key: string): number =>
      Math.round(((edge[key]! - start[key]!) / (edge.minute! - start.minute!)) * 60);
    const later = samples.filter((sample) => sample.minute! > (windowMs * 2) / 60_000);
    const spread = (key: string): [number, number] => [
      Math.min(...later.map((sample) => sample[key]!)),
      Math.max(...later.map((sample) => sample[key]!)),
    ];
    console.log(
      JSON.stringify(
        {
          files: FILE_COUNT,
          branches: BRANCHES,
          windowMinutes: windowMs / 60_000,
          runs: stats.analysed,
          perHour: {
            events: perHour('events'),
            runs: perHour('speculative_runs'),
            changeSets: perHour('change_sets'),
            verdicts: perHour('analyzer_cache'),
            bytes: perHour('bytes'),
            shadowLoose: perHour('shadowLoose'),
            shadowLooseBytes: perHour('shadowLooseBytes'),
          },
          atOneWindow: edge,
          afterTwoWindows: {
            events: spread('events'),
            runs: spread('speculative_runs'),
            changeSets: spread('change_sets'),
            verdicts: spread('analyzer_cache'),
            bytes: spread('bytes'),
            shadowLoose: spread('shadowLoose'),
            shadowLooseBytes: spread('shadowLooseBytes'),
            shadowPackBytes: spread('shadowPackBytes'),
          },
          passes: system.passes.length,
          collections: system.collections.length,
          largestPackKib: Math.max(...system.collections.map((report) => report.after.kib)),
          longestCollectionMs: Math.max(...system.collections.map((report) => report.durationMs)),
          longestBatchMs: Math.max(...system.passes.map((pass) => pass.longestBatchMs)),
          longestPassMs: Math.max(...system.passes.map((pass) => pass.durationMs)),
          samples,
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/**
 * One pass over a large backlog — a store never pruned, or one whose window
 * was just shortened — and one over an hour's worth of rows after it.
 *
 * Rows are written straight into SQLite, shaped as the pipeline writes them:
 * each run with its events, a resolved Finding and its evidence, a verdict,
 * and a change set per capture; one run in a hundred still holds an open
 * Finding, whose chain the pass has to keep.
 */
async function largePruneMain(): Promise<void> {
  const runs = Number(process.env.INTERLOCK_BENCH_RUNS ?? 50_000);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-prune-bench-')));
  const log = createLogger('bench', { level: 'info' });
  try {
    const path = join(base, 'data', 'interlock.db');
    const created = await openStore({ path });
    await created.close();

    const old = Date.now() - 30 * 24 * 60 * 60_000;
    const fill = (count: number, from: number, step: number, tag: string): void => {
      const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
      try {
        db.exec('BEGIN');
        db.exec(`INSERT OR IGNORE INTO repos VALUES ('R', '/r', 'main', '/s', '{}', 'x', 'x')`);
        db.exec(`INSERT OR IGNORE INTO branch_refs (id, repo_id, ref, name, head_sha, worktree_path, dirty, first_seen_at, updated_at)
          VALUES ('A', 'R', 'refs/heads/a', 'a', 'h', '/a', NULL, 'x', 'x'),
                 ('B', 'R', 'refs/heads/b', 'b', 'h', '/b', NULL, 'x', 'x')`);
        db.exec(
          `INSERT OR IGNORE INTO merge_pairs VALUES ('P', 'R', 'A', 'B', 'A:B', 'm', 0, NULL, 0)`,
        );
        const event = db.prepare(
          'INSERT INTO events (id, repo_id, type, payload, at, caused_by) VALUES (?, ?, ?, ?, ?, ?)',
        );
        const run = db.prepare(
          `INSERT INTO speculative_runs VALUES (?, 'P', 's', 's', 'complete', '{}', '[]', ?, ?, 5)`,
        );
        const finding = db.prepare(
          `INSERT INTO findings VALUES (?, ?, 'textual', 'r', 'high', 1, ?, 't', 'd', 'A', 'B', NULL, 'r', ?, ?, NULL)`,
        );
        const evidence = db.prepare(`INSERT INTO evidence VALUES (?, ?, 'span', ?)`);
        const verdict = db.prepare(
          `INSERT INTO analyzer_cache (key, analyzer, verdict, finding_ids, duration_ms, diagnostic, created_at, run_id, findings) VALUES (?, 'textual', 'findings', '[]', 1, NULL, ?, ?, '[]')`,
        );
        const change = db.prepare(`INSERT INTO change_sets VALUES (?, 'A', NULL, 'm', 'h', ?, ?)`);
        const body = JSON.stringify({ excerpt: 'x'.repeat(200) });
        for (let n = 0; n < count; n++) {
          const at = new Date(from + n * step).toISOString();
          const id = `${tag}${String(n).padStart(9, '0')}`;
          const snapshot = `${id}s`;
          event.run(
            snapshot,
            'R',
            'branch.snapshot',
            JSON.stringify({ type: 'branch.snapshot', at }),
            at,
            null,
          );
          event.run(
            `${id}p`,
            'R',
            'pair.scheduled',
            JSON.stringify({ type: 'pair.scheduled', at }),
            at,
            snapshot,
          );
          let previous = `${id}p`;
          for (const type of [
            'run.started',
            'run.merge-completed',
            'run.analyzer-completed',
            'finding.raised',
            'run.finished',
          ]) {
            const eventId = `${id}${type}`;
            event.run(eventId, 'R', type, JSON.stringify({ type, runId: id, at }), at, previous);
            previous = eventId;
          }
          run.run(id, at, at);
          finding.run(`${id}f`, id, n % 100 === 0 ? 'open' : 'resolved', at, at);
          evidence.run(`${id}f`, 0, body);
          evidence.run(`${id}f`, 1, body);
          verdict.run(`${id}k`, at, id);
          change.run(`${id}c`, JSON.stringify([{ path: 'src/a.ts', hunks: [] }]), at);
        }
        db.exec('COMMIT');
      } finally {
        db.close();
      }
    };

    log.info('filling', { runs });
    // Spread across the three weeks before the cutoff, so all of it has aged out.
    fill(runs, old, (22 * 24 * 60 * 60_000) / runs, 'O');
    const before = sampleStore(path);

    const store = await openStore({ path });
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const backlog = await store.prune(cutoff);
    const afterBacklog = sampleStore(path);

    // An hour's worth, just aged out: what a steady-state pass meets.
    const hourly = Number(process.env.INTERLOCK_BENCH_HOURLY_RUNS ?? 1_000);
    await store.close();
    fill(hourly, Date.now() - 8 * 24 * 60 * 60_000, 3_600_000 / hourly, 'H');
    const reopened = await openStore({ path });
    const steady = await reopened.prune(cutoff);
    await reopened.close();

    console.log(
      JSON.stringify({ runs, before, backlog, afterBacklog, hourlyRuns: hourly, steady }, null, 2),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const MODE = process.env.INTERLOCK_BENCH_MODE ?? 'cpu';
void (MODE === 'retention' ? retentionMain() : MODE === 'large-prune' ? largePruneMain() : main());
