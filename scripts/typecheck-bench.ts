#!/usr/bin/env tsx
/**
 * The type checker's numbers on a real repository: a cold check against warm
 * ones and two one-file edits, what each service costs as services are added,
 * and how long the main thread stalls meanwhile.
 *
 * Timed here rather than asserted in a test. A test runs on a shared machine
 * against a small repository, so a ratio between two of its timings passes or
 * fails with the machine rather than the code.
 *
 * Memory is read two ways, because every worker is a thread of this process
 * and the process's RSS counts them all: each service's heap, read inside its
 * worker after its check, and the process's RSS as services are added.
 *
 * The checkout given is only read. It is cloned, and the clone is what is
 * checked and edited; the checkout lends its installed `node_modules`, as the
 * dependency checkout does in the daemon.
 *
 *   pnpm exec tsx scripts/typecheck-bench.ts <checkout> <tsconfig> <file to edit>
 *
 * The tsconfig and the file are relative to the checkout's root. The file is
 * edited twice: adding an export, which re-checks what imports it too, then
 * leaving every signature as it was, which re-checks that file alone.
 * `INTERLOCK_BENCH_HEAP_MB` and `INTERLOCK_BENCH_DEADLINE_MS` override the
 * configured limits, to see how far past them a repository goes.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  createGitRunner,
  createTypecheckRegistry,
  createWorktreePool,
  ensureShadow,
  installIdentity,
  listTree,
  speculativeMerge,
} from '../packages/core/src/index.js';
import type {
  ShadowRepo,
  TypecheckOutcome,
  TypecheckRegistry,
  UserRepo,
  WorktreePool,
} from '../packages/core/src/index.js';
import { createLogger, DEFAULT_CONFIG, makePairKey, ulid } from '../packages/shared/src/index.js';
import type { BranchRefId, MergePairKey, RepoId } from '../packages/shared/src/index.js';

const WARM_CHECKS = Number(process.env.INTERLOCK_BENCH_WARM ?? 20);
const WORKERS = Number(process.env.INTERLOCK_BENCH_WORKERS ?? 3);
const HEAP_MB = Number(process.env.INTERLOCK_BENCH_HEAP_MB ?? DEFAULT_CONFIG.typecheck.maxHeapMb);
const DEADLINE_MS = Number(
  process.env.INTERLOCK_BENCH_DEADLINE_MS ?? DEFAULT_CONFIG.typecheck.deadlineMs,
);

const MIB = 2 ** 20;
const mib = (bytes: number): number => Math.round(bytes / MIB);
const rssMib = (): number => mib(process.memoryUsage().rss);

type Checked = Extract<TypecheckOutcome, { kind: 'checked' }>;

interface Timed {
  readonly outcome: Checked;
  /** From asking for the slot to the answer: the merge, the fill, the listing and the check. */
  readonly wallMs: number;
  readonly fillMs: number;
  readonly listMs: number;
}

/** A check that did not complete, which ends the run with what it says. */
class Incomplete extends Error {
  readonly outcome: Exclude<TypecheckOutcome, { kind: 'checked' }>;

  constructor(outcome: Exclude<TypecheckOutcome, { kind: 'checked' }>) {
    super(`the check did not complete: ${outcome.kind}`);
    this.outcome = outcome;
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function summary(timed: Timed): Record<string, number> {
  return {
    wallMs: timed.wallMs,
    checkMs: Math.round(timed.outcome.durationMs),
    fillMs: timed.fillMs,
    listMs: timed.listMs,
    projects: timed.outcome.report.projects.length,
    filesChecked: timed.outcome.filesChecked,
    programsBuilt: timed.outcome.programsBuilt,
    diagnostics: timed.outcome.report.files.length,
    configDiagnostics: timed.outcome.report.config.length,
    heapMib: mib(timed.outcome.heapBytes),
  };
}

async function main(): Promise<void> {
  const [checkoutArg, configPath, editPath] = process.argv.slice(2);
  if (checkoutArg === undefined || configPath === undefined || editPath === undefined) {
    console.error('usage: typecheck-bench.ts <checkout> <tsconfig> <file to edit>');
    process.exitCode = 2;
    return;
  }
  const checkout = realpathSync(resolve(checkoutArg));
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-typecheck-bench-')));
  const log = createLogger('bench', { level: 'info' });
  const runner = createGitRunner();
  const repoId = ulid<RepoId>();
  const dataDir = join(base, 'data');
  const clone = join(base, 'clone');
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', clone, ...args], {
      stdio: 'pipe',
      encoding: 'utf8',
      // A large repository's listing is past the default megabyte.
      maxBuffer: 256 * MIB,
    }).trim();

  let registry: TypecheckRegistry | undefined;
  try {
    log.info('cloning', { checkout });
    execFileSync('git', ['clone', '-q', '--shared', checkout, clone], { stdio: 'pipe' });
    git('config', 'user.name', 'Interlock Bench');
    git('config', 'user.email', 'bench@example.invalid');
    git('config', 'maintenance.auto', 'false');
    git('config', 'gc.auto', '0');
    const head = git('rev-parse', 'HEAD');
    const dependencyTreeOid = git('rev-parse', 'HEAD^{tree}');
    const trackedFiles = git('ls-files', '-z').split('\0').filter(Boolean).length;

    const commitEdit = (text: string, message: string): string => {
      appendFileSync(join(clone, editPath), text);
      git('commit', '-q', '-am', message);
      return git('rev-parse', 'HEAD');
    };
    // The signature first: the first edit after a cold check re-checks the
    // importers whatever it changed, so a body edit made first would be timed
    // as one that changed the file's shape.
    const signatureEdit = commitEdit(
      '\nexport const interlockBenchDelta = 1;\n',
      'bench: signature edit',
    );
    const bodyEdit = commitEdit(
      '\n// interlock bench: an edit that leaves every signature as it was\n',
      'bench: body edit',
    );

    const user: UserRepo = { kind: 'user', rootPath: clone, gitDir: join(clone, '.git') };
    const shadow: ShadowRepo = await ensureShadow(user, { runner, dataDir, repoId });
    registry = createTypecheckRegistry({
      maxServices: WORKERS,
      maxHeapMb: HEAP_MB,
      deadlineMs: DEADLINE_MS,
      logger: log,
    });
    const services = registry;
    const pool: WorktreePool = createWorktreePool(shadow, {
      runner,
      dataDir,
      repoId,
      size: WORKERS,
      logger: log,
      onEvict: (eviction) => services.release(eviction.path),
    });

    /** One commit's tree, checked in a pair's slot: the commit merged with itself. */
    const check = async (key: MergePairKey, sha: string): Promise<Timed> => {
      const started = performance.now();
      const merged = await speculativeMerge(
        { shadow, commitA: sha, commitB: sha, mergeBaseSha: sha },
        { runner },
      );
      let listMs = 0;
      const slot = await pool.withSlot(
        { key, commitA: sha, commitB: sha, merged, dependencyTreeOid },
        async (held) => {
          const listing = performance.now();
          const tree = await listTree(runner, held.repo, held.treeOid);
          listMs = Math.round(performance.now() - listing);
          return services.check({
            root: held.path,
            dependencyRoot: checkout,
            tree,
            project: configPath,
          });
        },
      );
      const wallMs = Math.round(performance.now() - started);
      if (slot.kind !== 'ran') throw new Error(`the slot was skipped: ${slot.paths.join(', ')}`);
      if (slot.value.kind !== 'checked') throw new Incomplete(slot.value);
      return { outcome: slot.value, wallMs, fillMs: slot.fillMs, listMs };
    };

    const warm = async (key: MergePairKey): Promise<Timed[]> => {
      const runs: Timed[] = [];
      for (let i = 0; i < WARM_CHECKS; i++) runs.push(await check(key, head));
      return runs;
    };

    const newKey = (): MergePairKey => makePairKey(ulid<BranchRefId>(), ulid<BranchRefId>());
    const identityStarted = performance.now();
    await installIdentity(checkout);
    const installIdentityMs = Math.round(performance.now() - identityStarted);
    const baselineRssMib = rssMib();
    const workers: Record<string, number>[] = [];
    const stalls = monitorEventLoopDelay({ resolution: 10 });

    log.info('cold check', { configPath, maxHeapMb: HEAP_MB, deadlineMs: DEADLINE_MS });
    const firstKey = newKey();
    stalls.enable();
    let cold: Timed;
    try {
      cold = await check(firstKey, head);
    } finally {
      stalls.disable();
    }
    const coldRssMib = rssMib();
    log.info('warm checks', { count: WARM_CHECKS });
    const warmRuns = await warm(firstKey);
    workers.push({
      workers: 1,
      coldHeapMib: mib(cold.outcome.heapBytes),
      coldRssMib,
      warmHeapMib: mib(warmRuns.at(-1)!.outcome.heapBytes),
      warmRssMib: rssMib(),
    });

    log.info('edits', { file: editPath });
    const signature = await check(firstKey, signatureEdit);
    const body = await check(firstKey, bodyEdit);

    for (let count = 2; count <= WORKERS; count++) {
      log.info('another service', { workers: count });
      const key = newKey();
      const added = await check(key, head);
      const addedRssMib = rssMib();
      const addedWarm = await warm(key);
      workers.push({
        workers: count,
        coldHeapMib: mib(added.outcome.heapBytes),
        coldRssMib: addedRssMib,
        warmHeapMib: mib(addedWarm.at(-1)!.outcome.heapBytes),
        warmRssMib: rssMib(),
      });
    }

    const warmCheckMs = warmRuns.map((run) => Math.round(run.outcome.durationMs));
    const warmWallMs = warmRuns.map((run) => run.wallMs);
    const compiler = JSON.parse(
      readFileSync(
        createRequire(import.meta.url).resolve('typescript/package.json', {
          paths: [join(import.meta.dirname, '../packages/core')],
        }),
        'utf8',
      ),
    ) as { version: string };
    console.log(
      JSON.stringify(
        {
          checkout,
          configPath,
          trackedFiles,
          typescript: compiler.version,
          node: process.version,
          cores: cpus().length,
          maxHeapMb: HEAP_MB,
          deadlineMs: DEADLINE_MS,
          installIdentityMs,
          baselineRssMib,
          longestStallMs: Math.round(stalls.max / 1e6),
          cold: summary(cold),
          warm: {
            checks: WARM_CHECKS,
            checkMsMedian: median(warmCheckMs),
            checkMsMax: Math.max(...warmCheckMs),
            wallMsMedian: median(warmWallMs),
            wallMsMax: Math.max(...warmWallMs),
            listMsMedian: median(warmRuns.map((run) => run.listMs)),
            filesCheckedMax: Math.max(...warmRuns.map((run) => run.outcome.filesChecked)),
            programsBuiltMax: Math.max(...warmRuns.map((run) => run.outcome.programsBuilt)),
          },
          signatureEdit: summary(signature),
          bodyEdit: summary(body),
          workers,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (!(error instanceof Incomplete)) throw error;
    console.log(
      JSON.stringify(
        {
          checkout,
          configPath,
          maxHeapMb: HEAP_MB,
          deadlineMs: DEADLINE_MS,
          incomplete: error.outcome,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    await registry?.close();
    rmSync(base, { recursive: true, force: true });
  }
}

await main();
