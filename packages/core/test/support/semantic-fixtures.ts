import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makePairKey, ulid } from '@interlock/shared';
import type { BranchRefId, RepoId } from '@interlock/shared';
import type { BaselineDiffer, BaselineOutcome } from '../../src/analyzers/baseline.js';
import { createGitRunner } from '../../src/git/repo-handle.js';
import type { ShadowRepo, UserRepo } from '../../src/git/repo-handle.js';
import { ensureShadow } from '../../src/git/shadow.js';
import { createWorktreePool } from '../../src/git/worktree-pool.js';
import type { PoolSlot, WorktreePool } from '../../src/git/worktree-pool.js';
import { speculativeMerge } from '../../src/merge/speculative-merge.js';

/**
 * Pairs for the baseline differ, built the way the daemon holds them:
 * committed in a user repository in a temporary directory, merged in its
 * shadow, and compared in the pair's pool slot.
 */

export type Files = Readonly<Record<string, string>>;

/** One side's change over the base: files written, then files removed. */
export interface Change {
  readonly write?: Files;
  readonly remove?: readonly string[];
}

export interface Pair {
  readonly one?: Change;
  readonly two?: Change;
  /** Same label, same slot: a later compare of the pair with one side moved on. */
  readonly key?: string;
  /** Whose tree the installed dependencies are: the base's unless a side's. */
  readonly dependencies?: 'base' | 'one';
}

export interface BaselineFixture {
  readonly user: string;
  readonly pool: WorktreePool;
  /**
   * Merge the pair, and run `differ.compare` in its slot. `inside` runs in the
   * slot after the comparison, while the check still holds it.
   */
  compare(
    differ: BaselineDiffer,
    pair: Pair,
    options?: {
      readonly signal?: AbortSignal;
      readonly inside?: (slot: PoolSlot, shadow: ShadowRepo) => Promise<void> | void;
    },
  ): Promise<BaselineOutcome>;
  dispose(): void;
}

export async function baselineFixture(base: Files): Promise<BaselineFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-baseline-')));
  const user = join(root, 'user');
  const dataDir = join(root, 'data');
  const runner = createGitRunner();
  const repoId = ulid<RepoId>();
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', user, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
  const writeAll = (files: Files): void => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(user, path)), { recursive: true });
      writeFileSync(join(user, path), content);
    }
  };

  execFileSync('git', ['init', '-q', '-b', 'main', user], { stdio: 'pipe' });
  git('config', 'user.name', 'Interlock Test');
  git('config', 'user.email', 'test@example.invalid');
  // Since git 2.47 `commit` detaches a maintenance process that holds
  // `objects/maintenance.lock` after the commit returns.
  git('config', 'maintenance.auto', 'false');
  git('config', 'gc.auto', '0');
  writeAll({ '.gitignore': 'node_modules/\n', ...base });
  git('add', '-A');
  git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  const handle: UserRepo = { kind: 'user', rootPath: user, gitDir: join(user, '.git') };
  let shadow = await ensureShadow(handle, { runner, dataDir, repoId });
  const pool = createWorktreePool(shadow, { runner, dataDir, repoId });
  const keys = new Map<string, ReturnType<typeof makePairKey>>();

  /** A side's branch, from the base each time: a later commit is the side moved on. */
  const branch = (name: string, change: Change): string => {
    git('checkout', '-q', '-B', name, baseSha);
    for (const path of change.remove ?? []) git('rm', '-q', '--', path);
    writeAll(change.write ?? {});
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', name);
    const sha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    return sha;
  };

  return {
    user,
    pool,
    async compare(differ, pair, options = {}) {
      const label = pair.key ?? 'pair';
      const commitA = branch(`${label}-one`, pair.one ?? {});
      const commitB = branch(`${label}-two`, pair.two ?? {});
      shadow = await ensureShadow(handle, { runner, dataDir, repoId });
      const merged = await speculativeMerge(
        { shadow, commitA, commitB, mergeBaseSha: baseSha },
        { runner },
      );
      if (!merged.clean) throw new Error('a baseline fixture merged with a conflict');
      let key = keys.get(label);
      if (key === undefined) {
        key = makePairKey(ulid<BranchRefId>(), ulid<BranchRefId>());
        keys.set(label, key);
      }
      const dependencyTreeOid = git(
        'rev-parse',
        `${pair.dependencies === 'one' ? commitA : baseSha}^{tree}`,
      );
      const outcome = await pool.withSlot(
        { key, commitA, commitB, merged, dependencyTreeOid },
        async (slot) => {
          const compared = await differ.compare({
            shadow,
            slot,
            mergeBaseSha: baseSha,
            commitA,
            commitB,
            dependencyRoot: user,
            dependencyTreeOid,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          await options.inside?.(slot, shadow);
          return compared;
        },
      );
      if (outcome.kind !== 'ran') throw new Error(`the slot was skipped: ${outcome.reason}`);
      return outcome.value;
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * The semantic pairs of the evaluation fixtures, mirrored: the same trees,
 * written here because `eval/` is read-only and never imported. Each branch
 * compiles alone; the merge does not, or, for a twin, does.
 */

const lines = (...content: string[]): string => `${content.join('\n')}\n`;

export const PROJECT: Files = {
  'package.json': '{\n  "name": "fixture",\n  "private": true,\n  "type": "module"\n}\n',
  'tsconfig.json': [
    '{',
    '  "compilerOptions": {',
    '    "strict": true,',
    '    "noEmit": true,',
    '    "target": "es2022",',
    '    "module": "esnext",',
    '    "moduleResolution": "bundler"',
    '  },',
    '  "include": ["src"]',
    '}',
    '',
  ].join('\n'),
};

const payments = lines(
  'export function processRefund(orderId: string): string {',
  '  return `refund:${orderId}`;',
  '}',
);
const checkout = lines(
  'import { processRefund } from "./payments";',
  '',
  'export function cancel(orderId: string): string {',
  '  return processRefund(orderId);',
  '}',
);
const format = lines(
  'export function formatPrice(amount: number): string {',
  '  return amount.toFixed(2);',
  '}',
);
const cart = lines(
  'import { formatPrice } from "./format";',
  '',
  'export function label(total: number): string {',
  '  return formatPrice(total);',
  '}',
);
const invoice = lines(
  'import { formatPrice } from "./format";',
  '',
  'export function line(amount: number): string {',
  '  return `total ${formatPrice(amount)}`;',
  '}',
);
const truncateOnly = lines(
  'export function truncate(text: string, length: number): string {',
  '  return text.slice(0, length);',
  '}',
);
const strings = lines(
  'export function slugify(text: string): string {',
  '  return text.toLowerCase().replace(/\\s+/g, "-");',
  '}',
);
const utils = `${strings}\n${truncateOnly}`;
const post = lines(
  'import { slugify } from "./utils";',
  '',
  'export function permalink(title: string): string {',
  '  return `/posts/${slugify(title)}`;',
  '}',
);
const tag = lines(
  'import { slugify } from "./utils";',
  '',
  'export function tagUrl(name: string): string {',
  '  return `/tags/${slugify(name)}`;',
  '}',
);

export interface SemanticCase {
  readonly id: string;
  readonly base: Files;
  readonly one: Change;
  readonly two: Change;
  /** The one merge-induced diagnostic, or null for a twin. */
  readonly expected: { readonly file: string; readonly code: number } | null;
}

const renamed: Change = {
  write: {
    'src/payments.ts': payments.replace('processRefund', 'refundPayment'),
    'src/checkout.ts': checkout.replaceAll('processRefund', 'refundPayment'),
  },
};

export const SEMANTIC_CASES: readonly SemanticCase[] = [
  {
    id: 'rename-vs-callsite',
    base: { ...PROJECT, 'src/payments.ts': payments, 'src/checkout.ts': checkout },
    one: renamed,
    two: {
      write: {
        'src/support.ts': lines(
          'import { processRefund } from "./payments";',
          '',
          'export function escalate(orderId: string): string {',
          '  return processRefund(orderId);',
          '}',
        ),
      },
    },
    expected: { file: 'src/support.ts', code: 2305 },
  },
  {
    id: 'rename-vs-callsite-twin-no-new-call',
    base: { ...PROJECT, 'src/payments.ts': payments, 'src/checkout.ts': checkout },
    one: renamed,
    two: {
      write: {
        'src/support.ts': lines(
          'export function escalate(orderId: string): string {',
          '  return `escalate:${orderId}`;',
          '}',
        ),
      },
    },
    expected: null,
  },
  {
    id: 'signature-vs-caller',
    base: { ...PROJECT, 'src/format.ts': format, 'src/cart.ts': cart },
    one: {
      write: {
        'src/format.ts': lines(
          'export function formatPrice(amount: number, currency: string): string {',
          '  return `${currency} ${amount.toFixed(2)}`;',
          '}',
        ),
        'src/cart.ts': cart.replace('formatPrice(total)', 'formatPrice(total, "EUR")'),
      },
    },
    two: { write: { 'src/invoice.ts': invoice } },
    expected: { file: 'src/invoice.ts', code: 2554 },
  },
  {
    id: 'signature-vs-caller-twin-optional-parameter',
    base: { ...PROJECT, 'src/format.ts': format, 'src/cart.ts': cart },
    one: {
      write: {
        'src/format.ts': lines(
          'export function formatPrice(amount: number, currency = "USD"): string {',
          '  return `${currency} ${amount.toFixed(2)}`;',
          '}',
        ),
      },
    },
    two: { write: { 'src/invoice.ts': invoice } },
    expected: null,
  },
  {
    id: 'moved-export-vs-import',
    base: { ...PROJECT, 'src/utils.ts': utils, 'src/post.ts': post },
    one: {
      write: {
        'src/strings.ts': strings,
        'src/utils.ts': truncateOnly,
        'src/post.ts': post.replace('"./utils"', '"./strings"'),
      },
    },
    two: { write: { 'src/tag.ts': tag } },
    expected: { file: 'src/tag.ts', code: 2305 },
  },
  {
    id: 'moved-export-vs-import-twin-re-exported',
    base: { ...PROJECT, 'src/utils.ts': utils, 'src/post.ts': post },
    one: {
      write: {
        'src/strings.ts': strings,
        'src/utils.ts': `export { slugify } from "./strings";\n\n${truncateOnly}`,
      },
    },
    two: { write: { 'src/tag.ts': tag } },
    expected: null,
  },
];
