import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makePairKey, ulid } from '@interlock/shared';
import type { BranchRefId, RepoId } from '@interlock/shared';
import { createGitRunner } from '../../src/git/repo-handle.js';
import type { ShadowRepo, UserRepo } from '../../src/git/repo-handle.js';
import { ensureShadow } from '../../src/git/shadow.js';
import { createWorktreePool } from '../../src/git/worktree-pool.js';
import type { PoolSlot, WorktreePool, WorktreePoolOptions } from '../../src/git/worktree-pool.js';
import { speculativeMerge } from '../../src/merge/speculative-merge.js';

/**
 * Trees to type-check, the way the daemon will hold them: committed in a
 * user repository built in a temporary directory, merged in its shadow, and
 * written into a pool slot. Nothing here type-checks; it only makes trees.
 */

export type Files = Readonly<Record<string, string>>;

/** Interlock's own `tsc`, the compiler the service is held against. */
export const TSC = createRequire(import.meta.url).resolve('typescript/bin/tsc');

export interface SlotFixture {
  /** The user repository, which doubles as the dependency checkout unless a test says otherwise. */
  readonly user: string;
  readonly base: string;
  readonly dataDir: string;
  readonly pool: WorktreePool;
  /**
   * Merge `one` and `two`, each written over the base on a branch of its own,
   * into the pair's slot, and run `use` against it.
   */
  inSlot<T>(
    pair: { readonly one?: Files; readonly two?: Files; readonly key?: string },
    use: (slot: PoolSlot) => Promise<T>,
  ): Promise<T>;
  /** Write files into the user's checkout without committing them: installed dependencies. */
  install(files: Files): void;
  link(path: string, target: string): void;
  dispose(): void;
}

export async function slotFixture(
  base: Files,
  options: Partial<Pick<WorktreePoolOptions, 'size' | 'onEvict'>> = {},
): Promise<SlotFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-typecheck-')));
  const user = join(root, 'user');
  const dataDir = join(root, 'data');
  const runner = createGitRunner();
  const repoId = ulid<RepoId>();
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', user, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
  const writeAll = (where: string, files: Files): void => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(where, path)), { recursive: true });
      writeFileSync(join(where, path), content);
    }
  };

  execFileSync('git', ['init', '-q', '-b', 'main', user], { stdio: 'pipe' });
  git('config', 'user.name', 'Interlock Test');
  git('config', 'user.email', 'test@example.invalid');
  // Since git 2.47 `commit` detaches a maintenance process that holds
  // `objects/maintenance.lock` after the commit returns.
  git('config', 'maintenance.auto', 'false');
  git('config', 'gc.auto', '0');
  writeAll(user, { '.gitignore': 'node_modules/\n', ...base });
  git('add', '-A');
  git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  const handle: UserRepo = { kind: 'user', rootPath: user, gitDir: join(user, '.git') };
  let shadow: ShadowRepo = await ensureShadow(handle, { runner, dataDir, repoId });
  const pool = createWorktreePool(shadow, { runner, dataDir, repoId, ...options });
  const keys = new Map<string, ReturnType<typeof makePairKey>>();

  const branch = (name: string, files: Files): string => {
    git('checkout', '-q', '-B', name, baseSha);
    writeAll(user, files);
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', name);
    const sha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    return sha;
  };

  return {
    user,
    base: baseSha,
    dataDir,
    pool,
    async inSlot(pair, use) {
      const label = pair.key ?? 'pair';
      const commitA = branch(`${label}-one`, pair.one ?? {});
      const commitB = branch(`${label}-two`, pair.two ?? {});
      shadow = await ensureShadow(handle, { runner, dataDir, repoId });
      const merged = await speculativeMerge(
        { shadow, commitA, commitB, mergeBaseSha: baseSha },
        { runner },
      );
      if (!merged.clean) throw new Error('a typecheck fixture merged with a conflict');
      let key = keys.get(label);
      if (key === undefined) {
        key = makePairKey(ulid<BranchRefId>(), ulid<BranchRefId>());
        keys.set(label, key);
      }
      const outcome = await pool.withSlot(
        // The dependency files are the base's, so the merged tree's must match.
        { key, commitA, commitB, merged, dependencyTreeOid: git('rev-parse', 'HEAD^{tree}') },
        use,
      );
      if (outcome.kind !== 'ran') throw new Error(`the slot was skipped: ${outcome.reason}`);
      return outcome.value;
    },
    install(files) {
      writeAll(user, files);
    },
    link(path, target) {
      mkdirSync(dirname(join(user, path)), { recursive: true });
      symlinkSync(target, join(user, path));
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** One diagnostic as `tsc` prints it, reduced to what both sides can name. */
export interface Printed {
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly code: number;
}

/**
 * What `tsc --noEmit -p <project>` reports for a tree, run with Interlock's
 * own compiler. `tsc` executes nothing of the tree's; the fixtures carry no
 * plugins and no `node_modules`.
 */
export function tscDiagnostics(cwd: string, project: string): Printed[] {
  let output: string;
  try {
    output = execFileSync(process.execPath, [TSC, '--noEmit', '--pretty', 'false', '-p', project], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    output = (error as { stdout: string }).stdout;
  }
  const printed: Printed[] = [];
  for (const line of output.split('\n')) {
    const located = /^(.+)\((\d+),(\d+)\): \w+ TS(\d+): /u.exec(line);
    if (located !== null) {
      printed.push({
        file: located[1]!,
        line: Number(located[2]),
        column: Number(located[3]),
        code: Number(located[4]),
      });
      continue;
    }
    const global = /^\w+ TS(\d+): /u.exec(line);
    if (global !== null)
      printed.push({ file: null, line: null, column: null, code: Number(global[1]) });
  }
  return printed.sort(byPlace);
}

export function byPlace(a: Printed, b: Printed): number {
  return (
    (a.file ?? '').localeCompare(b.file ?? '') ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0) ||
    a.code - b.code
  );
}
