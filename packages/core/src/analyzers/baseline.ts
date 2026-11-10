import { createHash } from 'node:crypto';
import { InterlockError, silentLogger } from '@interlock/shared';
import type { Logger } from '@interlock/shared';
import { parseNameStatus } from '../git/diff.js';
import { assertObjectId, runRequired } from '../git/repo-handle.js';
import type { GitRunner, ShadowRepo } from '../git/repo-handle.js';
import { dependencyDrift } from '../git/worktree-pool.js';
import type { PoolSlot } from '../git/worktree-pool.js';
import { DEFAULT_PROJECT, TYPESCRIPT_VERSION } from './typecheck-paths.js';
import { installIdentity, installRoots, listTree } from './typecheck.js';
import type {
  ConfigDiagnostic,
  FileDiagnostic,
  TypecheckOutcome,
  TypecheckRegistry,
  TypecheckReport,
} from './typecheck.js';

/**
 * The baseline differ: of everything the compiler says about a merged tree,
 * the part the merge caused.
 *
 * A merged tree is often broken before anyone merges it — `main` carries type
 * errors, or one branch does on its own — and every one of those would reach
 * an agent as a conflict it did not cause. So four trees of a pair are
 * checked: the merge base, each side alone, and the merge. A diagnostic the
 * merge has and none of the other three can explain is merge-induced.
 *
 * The false-positive rule decides every ambiguity here. Wherever the
 * comparison cannot tell whether a diagnostic is new, it is not new: a real
 * conflict missed is a recall gap the fixture suite shows, a pre-existing
 * error reported as new is an agent told to fix what it did not break.
 */

/** Bumped whenever a change here could change which diagnostics are merge-induced. */
export const BASELINE_VERSION = 1;

/**
 * Tree reports kept at once. Each is one tree's diagnostics, small next to a
 * service, and the base and each side of a hot pair are what it is for.
 */
export const DEFAULT_BASELINE_CACHE_SIZE = 64;

export type BaselineTree = 'base' | 'a' | 'b' | 'merge';

/**
 * A diagnostic with the parts of its identity a report does not carry.
 *
 * Identity is what makes one tree's diagnostic the same as another's: line
 * and column move whenever anything above them changes, so they are not part
 * of it. What is: the code, the file, the message, and the text the span
 * covers.
 */
export interface IdentifiedDiagnostic<D extends FileDiagnostic | ConfigDiagnostic> {
  readonly diagnostic: D;
  /** The message with the tree's own path taken out: a pool slot's path is not content. */
  readonly message: string;
  /** A hash of the text the span covers, or null where no span reads from the tree. */
  readonly span: string | null;
}

export interface IdentifiedReport {
  readonly files: readonly IdentifiedDiagnostic<FileDiagnostic>[];
  readonly config: readonly IdentifiedDiagnostic<ConfigDiagnostic>[];
}

export interface MergeInduced {
  readonly files: readonly FileDiagnostic[];
  /**
   * Configuration diagnostics only the merge has: real, since the merge broke
   * its own tsconfig, but not a fault in any file, so never folded in with
   * them.
   */
  readonly config: readonly ConfigDiagnostic[];
}

/** A rename seen between the merge base and one of the other trees: from, then to. */
export type Rename = readonly [from: string, to: string];

/**
 * The merge's diagnostics that the merge base, A and B do not explain.
 *
 * Compared as multisets of identities. Of each identity, the merge's copies
 * are explained up to the most any history without the merge produces: the
 * base's count, A's, B's, or A's and B's additions over the base together. A
 * count past that is merge-induced. Taking the most of four over-explains
 * whenever they disagree, which drops a copy rather than reporting one.
 *
 * Files are compared under one name per rename class, every rename between
 * the base and any tree joined: a rename one tree's diff sees and another's
 * misses — a side edited the file past the similarity threshold — still
 * names one file.
 */
export function mergeInduced(
  trees: Readonly<Record<BaselineTree, IdentifiedReport>>,
  renames: readonly Rename[],
): MergeInduced {
  const canonical = renameClasses(renames);
  const keyOf = (identified: IdentifiedDiagnostic<FileDiagnostic | ConfigDiagnostic>): string =>
    JSON.stringify([
      identified.diagnostic.code,
      identified.diagnostic.file === null ? null : canonical(identified.diagnostic.file),
      identified.message,
      identified.span,
    ]);

  const induced = <D extends FileDiagnostic | ConfigDiagnostic>(
    pick: (report: IdentifiedReport) => readonly IdentifiedDiagnostic<D>[],
  ): D[] => {
    const counts = (report: IdentifiedReport): Map<string, number> => {
      const counted = new Map<string, number>();
      for (const identified of pick(report)) {
        const key = keyOf(identified);
        counted.set(key, (counted.get(key) ?? 0) + 1);
      }
      return counted;
    };
    const base = counts(trees.base);
    const a = counts(trees.a);
    const b = counts(trees.b);
    const seen = new Map<string, number>();
    const found: D[] = [];
    for (const identified of pick(trees.merge)) {
      const key = keyOf(identified);
      const inBase = base.get(key) ?? 0;
      const inA = a.get(key) ?? 0;
      const inB = b.get(key) ?? 0;
      const explained = Math.max(inBase, inA, inB, inA + inB - inBase);
      const copy = (seen.get(key) ?? 0) + 1;
      seen.set(key, copy);
      if (copy > explained) found.push(identified.diagnostic);
    }
    return found;
  };

  return {
    files: induced((report) => report.files),
    config: induced((report) => report.config),
  };
}

/**
 * One name per class of paths joined by renames. Which member names a class
 * does not matter: the name is compared, never shown.
 */
function renameClasses(renames: readonly Rename[]): (path: string) => string {
  const parent = new Map<string, string>();
  const find = (path: string): string => {
    let root = path;
    while (parent.has(root)) root = parent.get(root)!;
    return root;
  };
  for (const [from, to] of renames) {
    const one = find(from);
    const two = find(to);
    if (one !== two) parent.set(one, two);
  }
  return find;
}

/**
 * Why a tree's report cannot be compared, or null when it can.
 *
 * An error in the configuration — a broken tsconfig, a missing `lib` — gates
 * the compiler's semantic check, so the tree's file diagnostics are not an
 * answer about its code. Compared anyway, every error the merge has would be
 * new against a base that was never really checked.
 */
export function unjudgeable(report: IdentifiedReport): string | null {
  const errors = report.config.filter((identified) => identified.diagnostic.category === 'error');
  if (errors.length === 0) return null;
  return `its configuration has ${errors.length} error${errors.length === 1 ? '' : 's'} (${[
    ...new Set(errors.map((identified) => `TS${identified.diagnostic.code}`)),
  ].join(', ')})`;
}

export interface BaselineRequest {
  readonly shadow: ShadowRepo;
  /** The pair's slot, holding the merge. Held for this call alone; the merge is back in it on return. */
  readonly slot: PoolSlot;
  readonly mergeBaseSha: string;
  /** Each side as merged: a branch head, or a snapshot commit in the shadow. */
  readonly commitA: string;
  readonly commitB: string;
  /** The checkout whose installed `node_modules` every tree borrows. */
  readonly dependencyRoot: string;
  /** That checkout's tree, captured into the shadow: each tree's dependency files must match it. */
  readonly dependencyTreeOid: string;
  /** The tsconfig to start from, relative to the tree. */
  readonly project?: string;
  readonly signal?: AbortSignal;
}

export type BaselineOutcome =
  | {
      readonly kind: 'compared';
      readonly induced: MergeInduced;
      /** The trees checked by this call, in the order checked; the others came from the cache. */
      readonly checked: readonly BaselineTree[];
      /** Per tree checked: writing it into the slot and checking it. */
      readonly durationsMs: Readonly<Partial<Record<BaselineTree, number>>>;
    }
  | {
      /**
       * A tree could not be checked, so nothing can be said about the merge.
       * Never an empty comparison: a check that did not happen is not one
       * that found nothing.
       */
      readonly kind: 'unavailable';
      readonly tree: BaselineTree;
      readonly reason: string;
    }
  | { readonly kind: 'cancelled' };

export interface BaselineDifferOptions {
  readonly runner: GitRunner;
  readonly registry: TypecheckRegistry;
  readonly cacheSize?: number;
  readonly logger?: Logger;
}

export interface BaselineDiffer {
  /**
   * Check whichever of the four trees the cache does not hold, in the pair's
   * slot, and compare.
   *
   * @throws InterlockError when the request itself is wrong — an id that is
   *         not one, a tree missing from the shadow. A tree that could not be
   *         checked is an `unavailable` outcome instead.
   */
  compare(request: BaselineRequest): Promise<BaselineOutcome>;
  /** Tree reports held now. */
  readonly cached: number;
}

/**
 * Open a differ over a registry of type-check services.
 *
 * The cache lives in memory, bounded, and not in the store: a report is a
 * pure function of its key, so losing it on a restart costs a check per tree
 * and never a wrong answer, where a stored one would need a migration and
 * a table that outgrows its use.
 */
export function createBaselineDiffer(options: BaselineDifferOptions): BaselineDiffer {
  const { runner, registry } = options;
  const cacheSize = options.cacheSize ?? DEFAULT_BASELINE_CACHE_SIZE;
  const log = (options.logger ?? silentLogger).child('baseline');
  if (!Number.isInteger(cacheSize) || cacheSize < 1) {
    throw new InterlockError('CONFIG_INVALID', 'The baseline cache needs at least one entry', {
      details: { cacheSize },
      remedy: 'Set the baseline cache size to a whole number of 1 or more.',
    });
  }

  // Insertion order is recency: a hit moves an entry to the end.
  const cache = new Map<string, IdentifiedReport>();
  const recall = (key: string): IdentifiedReport | undefined => {
    const found = cache.get(key);
    if (found !== undefined) {
      cache.delete(key);
      cache.set(key, found);
    }
    return found;
  };
  const remember = (key: string, report: IdentifiedReport): void => {
    cache.delete(key);
    cache.set(key, report);
    for (const oldest of cache.keys()) {
      if (cache.size <= cacheSize) break;
      cache.delete(oldest);
    }
  };

  return {
    async compare(request: BaselineRequest): Promise<BaselineOutcome> {
      const { shadow, slot, signal } = request;
      const project = request.project ?? DEFAULT_PROJECT;
      assertObjectId(request.mergeBaseSha, 'mergeBaseSha');
      assertObjectId(request.commitA, 'commitA');
      assertObjectId(request.commitB, 'commitB');
      assertObjectId(request.dependencyTreeOid, 'dependencyTreeOid');
      assertObjectId(slot.commitSha, 'slot.commitSha');
      if (signal?.aborted === true) return { kind: 'cancelled' };

      const commits: Readonly<Record<BaselineTree, string>> = {
        base: request.mergeBaseSha,
        a: request.commitA,
        b: request.commitB,
        merge: slot.commitSha,
      };
      const trees = await treesOf(runner, shadow, commits);
      // The installed packages, not only the tree they were installed from: a
      // checkout whose lockfile moved before its install did is the same tree
      // under two installs, and a report from the first is wrong for the second.
      const install = await installIdentity(
        request.dependencyRoot,
        installRoots(await listTree(runner, shadow, request.dependencyTreeOid)),
      );
      const keyOf = (tree: BaselineTree): string =>
        cacheKey({
          treeOid: trees[tree],
          dependencyTreeOid: request.dependencyTreeOid,
          install,
          project,
        });
      const renames = (
        await Promise.all(
          (['a', 'b', 'merge'] as const).map((tree) =>
            renamesBetween(runner, shadow, trees.base, trees[tree]),
          ),
        )
      ).flat();

      const found: Partial<Record<BaselineTree, IdentifiedReport>> = {};
      for (const tree of ORDER) {
        const hit = recall(keyOf(tree));
        if (hit !== undefined) found[tree] = hit;
      }
      const missing = ORDER.filter((tree) => found[tree] === undefined);
      const refused = refusal(found);
      if (refused !== null) return refused;

      // Before the slot moves: a side whose dependencies differ cannot be
      // checked, and finding out costs a diff, not a cycle. The merge's were
      // compared by the pool before it filled the slot.
      for (const tree of missing) {
        if (tree === 'merge') continue;
        const drift = await dependencyDrift(shadow, runner, request.dependencyTreeOid, trees[tree]);
        if (drift.length > 0) {
          return {
            kind: 'unavailable',
            tree,
            reason: `its dependency files differ from the installed tree (${drift.length})`,
          };
        }
      }

      const checked: BaselineTree[] = [];
      const durationsMs: Partial<Record<BaselineTree, number>> = {};
      let current: BaselineTree = 'merge';

      const move = async (tree: BaselineTree): Promise<void> => {
        if (tree === current) return;
        await runRequired(runner, slot.repo, ['reset', '--hard', '--quiet', commits[tree]]);
        current = tree;
      };

      try {
        for (const tree of missing) {
          const startedAt = Date.now();
          await move(tree);
          const outcome = await registry.check({
            root: slot.path,
            dependencyRoot: request.dependencyRoot,
            // The slot's directory keeps what `reset --hard` leaves behind; the
            // listing is what this tree holds.
            tree: await listTree(runner, shadow, trees[tree]),
            project,
            ...(signal === undefined ? {} : { signal }),
          });
          if (outcome.kind === 'cancelled') return { kind: 'cancelled' };
          if (outcome.kind !== 'checked') {
            const reason = notChecked(outcome);
            log.warn('baseline tree could not be checked', { tree, reason });
            return { kind: 'unavailable', tree, reason };
          }
          const identified = await identify(outcome.report, {
            runner,
            shadow,
            treeOid: trees[tree],
            root: slot.path,
            dependencyRoot: request.dependencyRoot,
          });
          remember(keyOf(tree), identified);
          found[tree] = identified;
          checked.push(tree);
          durationsMs[tree] = Date.now() - startedAt;
          const unusable = refusal(found);
          if (unusable !== null) return unusable;
        }
      } catch (error) {
        if (error instanceof InterlockError && error.infra) {
          log.warn('baseline tree could not be checked', { tree: current, reason: error.message });
          return { kind: 'unavailable', tree: current, reason: error.message };
        }
        throw error;
      } finally {
        // The pool records the slot as holding the merge, and its next fill is
        // a delta from that. A slot left on a side would still be corrected by
        // that fill — `reset --hard` rewrites whatever differs — so a failure
        // here is logged rather than raised over the answer.
        if (current !== 'merge') {
          await move('merge').catch((error: unknown) => {
            log.warn('pool slot not returned to its merge', {
              path: slot.path,
              reason: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }

      const induced = mergeInduced(found as Record<BaselineTree, IdentifiedReport>, renames);
      log.debug('baseline compared', {
        checked,
        files: induced.files.length,
        config: induced.config.length,
      });
      return { kind: 'compared', induced, checked, durationsMs };
    },

    get cached(): number {
      return cache.size;
    },
  };
}

/**
 * The order trees are checked in when the cache misses. The merge last, so the
 * slot ends where the pool expects it without a write of its own; the base
 * first, since it is the tree a cache least often misses, and a cold service
 * pays its full cost on whichever tree comes first.
 */
const ORDER: readonly BaselineTree[] = ['base', 'a', 'b', 'merge'];

/**
 * The first of the base and the sides whose report cannot be compared, as soon
 * as it is known, so a pair whose base is broken costs no further check.
 * The merge is not refused for its configuration: that is its own result.
 */
function refusal(
  found: Partial<Record<BaselineTree, IdentifiedReport>>,
): Extract<BaselineOutcome, { kind: 'unavailable' }> | null {
  for (const tree of ['base', 'a', 'b'] as const) {
    const report = found[tree];
    const why = report === undefined ? null : unjudgeable(report);
    if (why !== null) return { kind: 'unavailable', tree, reason: why };
  }
  return null;
}

/**
 * Why a check that ended without a report says nothing about its tree. A
 * timeout or an exhausted heap is the environment's limit, not the code's
 * verdict, so it is never read as an empty report.
 */
function notChecked(
  outcome: Exclude<TypecheckOutcome, { kind: 'checked' } | { kind: 'cancelled' }>,
): string {
  switch (outcome.kind) {
    case 'timeout':
      return `its check ran past ${outcome.deadlineMs} ms`;
    case 'out-of-memory':
      return `its check ran out of memory at ${outcome.maxHeapMb} MiB`;
    case 'crashed':
      return `the type checker stopped: ${outcome.message}`;
    case 'infra-failure':
      return `its check could not run (${outcome.reason}): ${outcome.message}`;
  }
}

/**
 * What a tree's report is a pure function of. `install` is the dependency
 * checkout's install identity, null where no package manager keeps a record
 * of one.
 */
export function cacheKey(parts: {
  readonly treeOid: string;
  readonly dependencyTreeOid: string;
  readonly install: string | null;
  readonly project: string;
}): string {
  return JSON.stringify([
    BASELINE_VERSION,
    TYPESCRIPT_VERSION,
    parts.treeOid,
    parts.dependencyTreeOid,
    parts.install,
    parts.project,
  ]);
}

async function treesOf(
  runner: GitRunner,
  shadow: ShadowRepo,
  commits: Readonly<Record<BaselineTree, string>>,
): Promise<Record<BaselineTree, string>> {
  const result = await runRequired(runner, shadow, [
    'rev-parse',
    ...ORDER.map((tree) => `${commits[tree]}^{tree}`),
  ]);
  const oids = result.stdout.split('\n').filter((line) => line !== '');
  const trees = Object.fromEntries(ORDER.map((tree, index) => [tree, oids[index] ?? ''])) as Record<
    BaselineTree,
    string
  >;
  for (const tree of ORDER) assertObjectId(trees[tree], `${tree} tree`);
  return trees;
}

/**
 * Renames between two trees, found as a ChangeSet finds them.
 *
 * From the trees actually checked rather than the pair's ChangeSets: a side
 * with no worktree has none, and one computed from a snapshot that has since
 * been replaced describes a tree other than the one in the slot.
 */
async function renamesBetween(
  runner: GitRunner,
  shadow: ShadowRepo,
  from: string,
  to: string,
): Promise<Rename[]> {
  const result = await runRequired(runner, shadow, [
    'diff',
    // Named for the same reason a ChangeSet's diff names them: a repository's
    // own `diff.renames` changes what a rename is.
    '--find-renames',
    '--no-ext-diff',
    '--no-textconv',
    '--name-status',
    '-z',
    from,
    to,
    '--',
  ]);
  return parseNameStatus(result.stdout).flatMap((change) =>
    change.previousPath === null ? [] : [[change.previousPath, change.path] as const],
  );
}

interface IdentifyContext {
  readonly runner: GitRunner;
  readonly shadow: ShadowRepo;
  readonly treeOid: string;
  readonly root: string;
  readonly dependencyRoot: string;
}

/**
 * A report's diagnostics with their identities, read while the tree is known.
 *
 * Span text comes from the tree's object, never the slot's files: by the time
 * a cached report is compared the slot holds another tree, and the object is
 * what the cache is keyed on. A file under `node_modules` is not in the tree;
 * it is the dependency checkout's, the same for all four, and identified
 * without its span.
 */
export async function identify(
  report: TypecheckReport,
  context: IdentifyContext,
): Promise<IdentifiedReport> {
  const texts = new Map<string, Promise<string>>();
  const textOf = (file: string): Promise<string> => {
    let text = texts.get(file);
    if (text === undefined) {
      text = runRequired(context.runner, context.shadow, [
        'cat-file',
        'blob',
        `${context.treeOid}:${file}`,
      ]).then((result) => result.stdout);
      texts.set(file, text);
    }
    return text;
  };
  const message = (text: string): string =>
    withoutPaths(text, [context.root, context.dependencyRoot]);

  const files = await Promise.all(
    report.files.map(async (diagnostic) => ({
      diagnostic,
      message: message(diagnostic.message),
      span: isDependencyFile(diagnostic.file)
        ? null
        : hash(
            (await textOf(diagnostic.file)).slice(
              diagnostic.start,
              diagnostic.start + diagnostic.length,
            ),
          ),
    })),
  );
  const config = report.config.map((diagnostic) => ({
    diagnostic,
    message: message(diagnostic.message),
    span: null,
  }));
  return { files, config };
}

function isDependencyFile(file: string): boolean {
  return file.split('/').includes('node_modules');
}

/**
 * A message with absolute paths of the check's own making taken out.
 *
 * Every tree of a pair is checked at the slot's path, but a cached report may
 * come from another pair's slot, and a message naming one — `rootDir`'s, say —
 * would differ for no reason in the code. The longer path first, so one
 * inside the other is not half replaced.
 */
function withoutPaths(message: string, paths: readonly string[]): string {
  let result = message;
  for (const path of [...paths].sort((a, b) => b.length - a.length)) {
    result = result.split(path).join('<tree>');
  }
  return result;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
