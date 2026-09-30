import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANALYZER_PIPELINE,
  captureDirtyState,
  commitSnapshotInShadow,
  createGitRunner,
  ensureShadow,
  extractChangeSet,
  listBranchRefs,
  mergeBase,
  openUserRepo,
  speculativeMerge,
} from '../../packages/core/src/index.js';
import type { Analyzer, AnalyzerContext, GitRunner } from '../../packages/core/src/index.js';
import { isInterlockError, silentLogger, ulid } from '../../packages/shared/src/index.js';
import type {
  AnalyzerKind,
  BranchRef,
  Finding,
  RepoId,
  SnapshotId,
  SpeculativeRunId,
} from '../../packages/shared/src/index.js';
import type { Fixture } from './format.js';
import { generate } from './generate.js';
import type { Sides } from './score.js';

/**
 * Every analyzer that exists, in the order the pipeline runs them: core's own
 * list, never a copy, so an analyzer added to the pipeline is scored the day
 * it lands. One the set has labels for and this list does not hold is reported
 * as not run, and its expectations count as missed: that is its recall today.
 */
export const ANALYZERS: readonly Analyzer[] = ANALYZER_PIPELINE;

/** A fixture's findings, or why it produced none it could be scored on. */
export type FixtureRun =
  | {
      readonly kind: 'ran';
      readonly fixture: Fixture;
      readonly sides: Sides;
      readonly findings: readonly Finding[];
    }
  | {
      readonly kind: 'infra-failure';
      readonly fixture: Fixture;
      /** The analyzer that failed, or null for the path before any analyzer. */
      readonly analyzer: AnalyzerKind | null;
      readonly message: string;
    };

/**
 * Build `fixture` in a directory of its own and take it through the path the
 * daemon takes: discover its branches, capture each worktree into the shadow
 * the way the watcher does, commit both captures there, merge them from their
 * merge base, and hand the merge to every analyzer.
 *
 * The same core calls in the same order, not the daemon itself: what lives
 * only in its run pipeline — the verdict cache, reconciling Findings across
 * runs, recapturing a side whose tree the shadow lost — is not exercised here.
 * That is what scoring analyzers needs; the two can drift, and a change to the
 * order there belongs here too.
 *
 * The directory is removed whatever happens. Nothing is written anywhere else:
 * the repository, its shadow and the shadow's data dir all live under it.
 */
export async function runFixture(
  fixture: Fixture,
  runner: GitRunner = createGitRunner(),
): Promise<FixtureRun> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-eval-')));
  try {
    return await inside(dir, fixture, runner);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function inside(dir: string, fixture: Fixture, runner: GitRunner): Promise<FixtureRun> {
  const built = generate(fixture, dir);
  const repoId = '01JBQ0000000000000000EVAL' as RepoId;
  let context: AnalyzerContext;
  try {
    const handle = await openUserRepo(built.root, { runner });
    const shadow = await ensureShadow(handle, { runner, dataDir: join(dir, 'data'), repoId });
    const branches = await listBranchRefs(handle, repoId, { runner });
    const branchOf = (name: string): BranchRef => {
      const found = branches.find((branch) => branch.name === name);
      if (found?.worktreePath == null) throw new Error(`branch ${name} has no worktree`);
      return found;
    };
    const [a, b] = [branchOf('a'), branchOf('b')];

    // As the watcher captures: into the shadow, dirty state included, with a
    // change set against the default branch.
    const main = branchOf('main');
    const side = async (branch: BranchRef) => {
      const snapshot = await captureDirtyState(branch.worktreePath!, handle, {
        runner,
        objectStore: shadow,
      });
      const base = await mergeBase(handle, snapshot.headSha!, main.headSha, { runner });
      const changeSet = await extractChangeSet(handle, branch, base!, {
        runner,
        snapshot: { id: ulid<SnapshotId>(), treeOid: snapshot.treeOid },
        objectStore: shadow,
      });
      const commit = await commitSnapshotInShadow(shadow, snapshot, { runner });
      return { snapshot, changeSet, commit: commit.commitSha };
    };
    const [sideA, sideB] = [await side(a), await side(b)];
    const mergeBaseSha = await mergeBase(handle, sideA.snapshot.headSha!, sideB.snapshot.headSha!, {
      runner,
    });
    if (mergeBaseSha === null) throw new Error('the branches share no history');

    const mergeRequest = { shadow, commitA: sideA.commit, commitB: sideB.commit, mergeBaseSha };
    context = {
      runId: ulid<SpeculativeRunId>(),
      branchA: a.id,
      branchB: b.id,
      changeSetA: sideA.changeSet,
      changeSetB: sideB.changeSet,
      mergeRequest,
      merged: await speculativeMerge(mergeRequest, { runner }),
      slot: null,
      runner,
      logger: silentLogger,
      signal: new AbortController().signal,
    };
  } catch (error) {
    // Git or the file system failing under the path is the environment, and a
    // fixture it stopped is not a conflict found or missed. Anything else is a
    // fault in the set or the runner, and stops the run.
    if (isInterlockError(error) && error.infra) {
      return { kind: 'infra-failure', fixture, analyzer: null, message: error.message };
    }
    throw error;
  }

  const findings: Finding[] = [];
  for (const analyzer of ANALYZERS) {
    if (!analyzer.appliesTo(context)) continue;
    const outcome = await analyzer.analyze(context);
    if (outcome.verdict === 'infra-failure' || outcome.verdict === 'timeout') {
      return {
        kind: 'infra-failure',
        fixture,
        analyzer: analyzer.kind,
        message: outcome.diagnostic ?? outcome.verdict,
      };
    }
    findings.push(...outcome.findings);
  }
  return { kind: 'ran', fixture, sides: { a: context.branchA, b: context.branchB }, findings };
}
