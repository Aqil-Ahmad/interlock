import type { TextualConflictClass } from '../../src/merge/conflict-classifier.js';

/**
 * Planted textual conflicts, each labelled with what should be found.
 *
 * A pair is a base commit and two branches off it. Every conflict has a
 * negative twin: a pair that touches the same files in a similar way and is
 * genuinely independent, because a classifier only ever tested on conflicts
 * cannot show it stays quiet.
 */
export interface TextualFixture {
  readonly name: string;
  readonly base: Readonly<Record<string, string>>;
  readonly one: BranchChange;
  readonly two: BranchChange;
  /** Null for a negative twin: the pair merges cleanly and raises nothing. */
  readonly expected: ExpectedConflict | null;
}

export interface BranchChange {
  /** Applied first, as `git mv`, so git sees the rename. */
  readonly rename?: readonly (readonly [from: string, to: string])[];
  readonly write?: Readonly<Record<string, string>>;
  readonly remove?: readonly string[];
}

export interface ExpectedConflict {
  readonly analyzer: 'textual';
  readonly class: TextualConflictClass;
  /** The path git records the conflict under. */
  readonly path: string;
  /** Named in the conflicting lines, so it appears in every span that has lines. */
  readonly symbol: string;
  /** Each branch's own path for the file; null on the branch that deleted it. */
  readonly pathA: string | null;
  readonly pathB: string | null;
  /** Each branch's conflicting lines, 1-based and inclusive, in its own file. */
  readonly spanA: readonly [number, number] | null;
  readonly spanB: readonly [number, number] | null;
}

const config = [
  'export const retries = 3;',
  'export const backoffMs = 100;',
  'export const jitter = true;',
  'export const logLevel = "info";',
  'export const timeoutMs = 5000;',
  '',
].join('\n');

const parser = [
  'export function parse(input) {',
  '  const tokens = input.split(" ");',
  '  return tokens;',
  '}',
  '',
  'export function format(tokens) {',
  '  return tokens.join(" ");',
  '}',
  '',
].join('\n');

const legacy = ['export function migrate(row) {', '  return row;', '}', ''].join('\n');
const util = [
  'export function clamp(n) {',
  '  return Math.max(0, n);',
  '}',
  '',
  'export function double(n) {',
  '  return n * 2;',
  '}',
  '',
].join('\n');
const imports = ['import { a } from "./a";', '', 'export const main = a;', ''].join('\n');

export const TEXTUAL_FIXTURES: readonly TextualFixture[] = [
  {
    name: 'edit/edit — both change the same line',
    base: { 'config.ts': config },
    one: { write: { 'config.ts': config.replace('retries = 3', 'retries = 4') } },
    two: { write: { 'config.ts': config.replace('retries = 3', 'retries = 5') } },
    expected: {
      analyzer: 'textual',
      class: 'overlapping-edit',
      path: 'config.ts',
      symbol: 'retries',
      pathA: 'config.ts',
      pathB: 'config.ts',
      spanA: [1, 1],
      spanB: [1, 1],
    },
  },
  {
    name: 'edit/edit twin — lines far enough apart to merge',
    base: { 'config.ts': config },
    one: { write: { 'config.ts': config.replace('retries = 3', 'retries = 4') } },
    two: { write: { 'config.ts': config.replace('timeoutMs = 5000', 'timeoutMs = 9000') } },
    expected: null,
  },
  {
    name: 'adjacent edits — neighbouring lines, none in common',
    base: { 'config.ts': config },
    one: { write: { 'config.ts': config.replace('retries = 3', 'retries = 4') } },
    two: { write: { 'config.ts': config.replace('backoffMs = 100', 'backoffMs = 250') } },
    expected: {
      analyzer: 'textual',
      class: 'adjacent-addition',
      path: 'config.ts',
      symbol: 'export const',
      pathA: 'config.ts',
      pathB: 'config.ts',
      spanA: [1, 2],
      spanB: [1, 2],
    },
  },
  {
    name: 'adjacent addition — both add an import at the same place',
    base: { 'index.ts': imports },
    one: {
      write: { 'index.ts': imports.replace('"./a";\n', '"./a";\nimport { b } from "./b";\n') },
    },
    two: {
      write: { 'index.ts': imports.replace('"./a";\n', '"./a";\nimport { c } from "./c";\n') },
    },
    expected: {
      analyzer: 'textual',
      class: 'adjacent-addition',
      path: 'index.ts',
      symbol: 'import',
      pathA: 'index.ts',
      pathB: 'index.ts',
      spanA: [2, 2],
      spanB: [2, 2],
    },
  },
  {
    name: 'adjacent addition twin — imports added at opposite ends',
    base: { 'index.ts': imports },
    one: { write: { 'index.ts': `import { b } from "./b";\n${imports}` } },
    two: { write: { 'index.ts': `${imports}export const c = 1;\n` } },
    expected: null,
  },
  {
    name: 'add/add — both create the same file',
    base: { 'README.md': 'readme\n' },
    one: { write: { 'src/cache.ts': 'export function evict() {\n  return 1;\n}\n' } },
    two: { write: { 'src/cache.ts': 'export function evict() {\n  return 2;\n}\n' } },
    expected: {
      analyzer: 'textual',
      class: 'add-add',
      path: 'src/cache.ts',
      symbol: 'evict',
      pathA: 'src/cache.ts',
      pathB: 'src/cache.ts',
      // With no base to compare against, diff3 does not narrow the region to
      // the differing line: the whole file is in conflict.
      spanA: [1, 3],
      spanB: [1, 3],
    },
  },
  {
    name: 'add/add twin — new files at different paths',
    base: { 'README.md': 'readme\n' },
    one: { write: { 'src/cache.ts': 'export function evict() {\n  return 1;\n}\n' } },
    two: { write: { 'src/queue.ts': 'export function evict() {\n  return 2;\n}\n' } },
    expected: null,
  },
  {
    name: 'edit/delete — one edits a file the other deletes',
    base: { 'legacy.ts': legacy, 'other.ts': 'other\n' },
    one: { write: { 'legacy.ts': legacy.replace('return row;', 'return migrate2(row);') } },
    two: { remove: ['legacy.ts'] },
    expected: {
      analyzer: 'textual',
      class: 'delete-vs-modify',
      path: 'legacy.ts',
      symbol: 'migrate2',
      pathA: 'legacy.ts',
      pathB: null,
      spanA: [2, 2],
      spanB: null,
    },
  },
  {
    name: 'edit/delete twin — the deleted file is another one',
    base: { 'legacy.ts': legacy, 'other.ts': 'other\n' },
    one: { write: { 'legacy.ts': legacy.replace('return row;', 'return migrate2(row);') } },
    two: { remove: ['other.ts'] },
    expected: null,
  },
  {
    name: 'rename/edit — one renames and edits, the other edits the same line',
    base: { 'parser.ts': parser },
    one: {
      rename: [['parser.ts', 'parse.ts']],
      write: { 'parse.ts': parser.replace('input.split(" ")', 'input.split(",")') },
    },
    two: { write: { 'parser.ts': parser.replace('input.split(" ")', 'input.split("\\t")') } },
    expected: {
      analyzer: 'textual',
      class: 'overlapping-edit',
      path: 'parse.ts',
      symbol: 'input.split',
      pathA: 'parse.ts',
      pathB: 'parser.ts',
      spanA: [2, 2],
      spanB: [2, 2],
    },
  },
  {
    name: 'rename/edit twin — the edit is elsewhere, and git follows the rename',
    base: { 'parser.ts': parser },
    one: {
      rename: [['parser.ts', 'parse.ts']],
      write: { 'parse.ts': parser.replace('input.split(" ")', 'input.split(",")') },
    },
    two: { write: { 'parser.ts': parser.replace('tokens.join(" ")', 'tokens.join("")') } },
    expected: null,
  },
  {
    name: 'rename/delete — one renames and edits a file the other deletes',
    base: { 'util.ts': util, 'other.ts': 'other\n' },
    one: {
      rename: [['util.ts', 'helpers.ts']],
      write: { 'helpers.ts': util.replace('Math.max(0, n)', 'Math.max(-1, n)') },
    },
    two: { remove: ['util.ts'] },
    expected: {
      analyzer: 'textual',
      class: 'rename-vs-modify',
      path: 'helpers.ts',
      symbol: 'Math.max',
      pathA: 'helpers.ts',
      pathB: null,
      spanA: [2, 2],
      spanB: null,
    },
  },
  {
    name: 'rename/delete twin — the deleted file is another one',
    base: { 'util.ts': util, 'other.ts': 'other\n' },
    one: { rename: [['util.ts', 'helpers.ts']] },
    two: { remove: ['other.ts'] },
    expected: null,
  },
];
