import { InterlockError, isInterlockError, makePairKey } from '@interlock/shared';
import type { BranchRef, BranchRefId, Finding, Logger, RepoId } from '@interlock/shared';
import type { CheckOutcome, PairCandidate } from './scheduler/index.js';
import type { Store } from './store/index.js';

/**
 * `interlock check`, on the daemon's side: run one named pair now and answer
 * with its state.
 *
 * Through the daemon because the daemon is the only writer of the shadows and
 * the store; a CLI merging on its own would race it for both.
 */

/** What a caller asks for, once validated. */
export interface CheckRequest {
  readonly a: string;
  /** Null to check `a` against the repository's default branch. */
  readonly b: string | null;
  readonly timeoutMs: number;
}

/** One side of the checked pair, as the store names it. */
export interface CheckedBranch {
  readonly id: BranchRefId;
  readonly name: string;
}

/**
 * The pair's state once its run has landed: its open Findings, read from the
 * store, never the run's own count. A run can correctly merge nothing — the
 * content was already judged, or a verdict was cached — and "it merged nothing"
 * is not "nothing is wrong".
 */
export interface CheckReport {
  readonly repoId: RepoId;
  readonly a: CheckedBranch;
  readonly b: CheckedBranch;
  readonly mergeBaseSha: string;
  readonly clean: boolean;
  readonly findings: readonly Finding[];
}

export interface Checks {
  run(repoId: RepoId, request: CheckRequest, signal: AbortSignal): Promise<CheckReport>;
}

export interface ChecksOptions {
  readonly store: Store;
  /** A watcher pass over the repository that begins after the call. */
  refreshRepo(rootPath: string): Promise<void>;
  planPair(repoId: RepoId, a: BranchRefId, b: BranchRefId): Promise<PairCandidate>;
  check(candidate: PairCandidate): Promise<CheckOutcome>;
  readonly logger: Logger;
}

/** What a caller who names no deadline gets: generous next to a run, short next to a person. */
export const CHECK_TIMEOUT_MS = 60_000;
/** The longest a caller may ask a request to stay open. */
export const MAX_CHECK_TIMEOUT_MS = 10 * 60_000;
/** The shortest: anything less cannot hold a pass over a repository. */
export const MIN_CHECK_TIMEOUT_MS = 1_000;

/**
 * Runs asked for in one check before it gives up on the pair holding still.
 *
 * A run is superseded when a side moves under it, and asked for again; a pair
 * whose branches move faster than a merge takes would otherwise be asked for
 * until the deadline, each time on content already gone.
 */
const MAX_ATTEMPTS = 4;

/** Long enough for any ref name git accepts; a body past it is not a branch name. */
const MAX_NAME_LENGTH = 1_024;

/** Branches named in an error before the rest become a count. */
const LISTED_BRANCHES = 20;

const CHECK_KEYS: ReadonlySet<string> = new Set(['a', 'b', 'timeoutMs']);

/**
 * Validate a check request body.
 *
 * The same discipline as a session registration: every field checked, every
 * unknown key refused, every problem reported at once.
 *
 * @throws InterlockError `API_REQUEST_INVALID`, naming every problem.
 */
export function parseCheckRequest(body: unknown): CheckRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid(['the body must be a JSON object']);
  }
  const record = body as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(record)) {
    if (!CHECK_KEYS.has(key)) problems.push(`unknown field ${JSON.stringify(key)}`);
  }
  const name = (field: 'a' | 'b'): string | null => {
    const value = record[field];
    if (field === 'b' && (value === undefined || value === null)) return null;
    if (typeof value !== 'string' || value === '') {
      problems.push(`${field} must be a branch name`);
      return null;
    }
    if (value.length > MAX_NAME_LENGTH) {
      problems.push(`${field} is longer than ${String(MAX_NAME_LENGTH)} characters`);
      return null;
    }
    return value;
  };
  const a = name('a');
  const b = name('b');
  let timeoutMs = CHECK_TIMEOUT_MS;
  if (record.timeoutMs !== undefined) {
    const value = record.timeoutMs;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < MIN_CHECK_TIMEOUT_MS ||
      value > MAX_CHECK_TIMEOUT_MS
    ) {
      problems.push(
        `timeoutMs must be a whole number from ${String(MIN_CHECK_TIMEOUT_MS)} to ${String(MAX_CHECK_TIMEOUT_MS)}`,
      );
    } else {
      timeoutMs = value;
    }
  }
  if (problems.length > 0 || a === null) throw invalid(problems);
  return { a, b, timeoutMs };
}

export function createChecks(options: ChecksOptions): Checks {
  const { store } = options;
  const log = options.logger.child('check');

  const run = async (
    repoId: RepoId,
    request: CheckRequest,
    signal: AbortSignal,
  ): Promise<CheckReport> => {
    const deadline = AbortSignal.timeout(request.timeoutMs);
    const within = <T>(work: Promise<T>): Promise<T> =>
      bounded(work, deadline, signal, request.timeoutMs);

    const repo = (await store.listRepos()).find((each) => each.id === repoId);
    if (repo === undefined) {
      throw new InterlockError('REPO_NOT_FOUND', 'No such repository', {
        details: { repoId },
        remedy: 'List repositories at /api/repos.',
      });
    }
    // Before a name is resolved: a branch made a moment ago is not stored yet,
    // and a pair is judged on what is on disk now, not at the last pass.
    await within(options.refreshRepo(repo.rootPath));
    const branches = await store.listBranchRefs(repo.id);
    const a = resolve(branches, request.a);
    const b = resolve(branches, request.b ?? repo.defaultBranch);
    if (a.id === b.id) {
      throw new InterlockError('API_REQUEST_INVALID', 'A branch cannot be checked against itself', {
        details: { branch: a.name },
        remedy:
          request.b === null
            ? `${a.name} is the default branch. Name the branch to check it against.`
            : 'Name two different branches.',
      });
    }

    for (let attempt = 1; ; attempt++) {
      // Under the deadline as well: a merge base on a large history is git work.
      const candidate = await within(options.planPair(repo.id, a.id, b.id));
      const outcome = await within(options.check(candidate));
      if (!settled(outcome)) {
        // A side moved under the run, or its tree left the shadow: the content
        // it judged is gone. Asked for again, on what is there now.
        if (attempt < MAX_ATTEMPTS) continue;
        throw new InterlockError('SNAPSHOT_STALE', 'The branches kept changing during the check', {
          details: { attempts: attempt },
          remedy: 'Check again once the branches are quiet.',
          infra: true,
        });
      }
      answerFor(outcome, a, b);
      const key = makePairKey(a.id, b.id);
      const findings = (await store.listOpenFindings(repo.id)).filter(
        (finding) => makePairKey(finding.attribution.branchA, finding.attribution.branchB) === key,
      );
      log.info('checked a pair', {
        repoId: repo.id,
        a: a.id,
        b: b.id,
        attempts: attempt,
        findings: findings.length,
      });
      return {
        repoId: repo.id,
        a: { id: a.id, name: a.name },
        b: { id: b.id, name: b.name },
        mergeBaseSha: candidate.pair.mergeBaseSha,
        clean: findings.length === 0,
        findings,
      };
    }
  };

  return { run };
}

/** A branch by its short name or its full ref, or a refusal listing what there is. */
function resolve(branches: readonly BranchRef[], name: string): BranchRef {
  const found = branches.find((branch) => branch.name === name || branch.ref === name);
  if (found !== undefined) return found;
  const names = branches.map((branch) => branch.name).sort();
  const listed = names.slice(0, LISTED_BRANCHES).join(', ');
  const more =
    names.length > LISTED_BRANCHES ? `, and ${String(names.length - LISTED_BRANCHES)} more` : '';
  throw new InterlockError('BRANCH_NOT_FOUND', `No branch named ${name}`, {
    details: { name },
    remedy:
      names.length === 0
        ? 'The repository has no branches the daemon can see.'
        : `Branches: ${listed}${more}.`,
  });
}

/** Whether a run judged the content it was given, so the pair's state can be read. */
function settled(outcome: CheckOutcome): boolean {
  if (outcome.kind === 'failed') {
    return !(isInterlockError(outcome.error) && outcome.error.code === 'SNAPSHOT_STALE');
  }
  return outcome.result.kind !== 'superseded';
}

/**
 * Turn a run that judged nothing into what the caller should be told; return
 * for one whose pair's state is the answer.
 */
function answerFor(outcome: CheckOutcome, a: BranchRef, b: BranchRef): void {
  if (outcome.kind === 'failed') throw outcome.error;
  const { result } = outcome;
  switch (result.kind) {
    case 'analysed':
    case 'duplicate':
    case 'superseded':
      return;
    case 'infra-failure':
      throw new InterlockError('ANALYZER_INFRA_FAILURE', 'The check could not run', {
        details: { component: result.component, message: result.message },
        remedy: 'This is the environment, not the pair. See the daemon log, and check again.',
        infra: true,
      });
    case 'skipped':
      switch (result.reason) {
        case 'unrelated':
          throw new InterlockError('BRANCHES_UNRELATED', 'The two branches share no history', {
            details: { a: a.name, b: b.name },
            remedy: 'There is no merge base, so there is no merge to check.',
          });
        case 'branch-gone':
          throw new InterlockError('BRANCH_NOT_FOUND', 'A branch of the pair went away', {
            details: { a: a.name, b: b.name },
            remedy: 'It was deleted during the check. List the branches and check again.',
          });
        case 'unborn':
          throw new InterlockError('BRANCH_NOT_FOUND', 'A branch of the pair has no commits', {
            details: { a: a.name, b: b.name },
            remedy: 'Commit on it first: there is nothing yet to merge.',
          });
        case 'unreadable':
          throw new InterlockError(
            'GIT_COMMAND_FAILED',
            'A worktree of the pair could not be read',
            {
              details: { a: a.name, b: b.name },
              remedy: 'Check its permissions; the daemon log names the path.',
              infra: true,
            },
          );
      }
  }
}

/**
 * `work`, or a refusal once the deadline passes or the caller hangs up.
 *
 * The work itself goes on: a run started is a run the scheduler finishes and
 * records, whoever was waiting for it.
 */
function bounded<T>(
  work: Promise<T>,
  deadline: AbortSignal,
  caller: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => {
      deadline.removeEventListener('abort', stop);
      caller.removeEventListener('abort', stop);
      reject(
        caller.aborted
          ? new InterlockError('REQUEST_CANCELLED', 'The caller went away')
          : new InterlockError('CHECK_TIMEOUT', 'The check did not finish in time', {
              details: { timeoutMs },
              remedy:
                'The daemon is busy, or the pass over the repository is slow. Check again, or pass a longer --timeout.',
              infra: true,
            }),
      );
    };
    if (deadline.aborted || caller.aborted) {
      stop();
      return;
    }
    deadline.addEventListener('abort', stop, { once: true });
    caller.addEventListener('abort', stop, { once: true });
    work.then(
      (value) => {
        deadline.removeEventListener('abort', stop);
        caller.removeEventListener('abort', stop);
        resolve(value);
      },
      (error: unknown) => {
        deadline.removeEventListener('abort', stop);
        caller.removeEventListener('abort', stop);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function invalid(problems: readonly string[]): InterlockError {
  return new InterlockError('API_REQUEST_INVALID', 'The check request is invalid', {
    details: { problems },
    remedy: `Fix: ${problems.join('; ')}.`,
  });
}
