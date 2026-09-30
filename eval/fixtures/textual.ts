import type { Fixture } from './format.js';

/**
 * Textual conflicts: what `git merge` would stop on, found before it does.
 *
 * Every conflict sits beside its twin, and every twin touches the same file in
 * the same way the conflict does, one step further apart. The spans are each
 * branch's conflicting lines in its own file, as the classifier reads them.
 */

const pricing = [
  'export function subtotal(items) {',
  '  return items.reduce((n, i) => n + i.price, 0);',
  '}',
  '',
  'export function tax(amount) {',
  '  return amount * 0.2;',
  '}',
  '',
].join('\n');

const config = [
  'export const retries = 3;',
  'export const backoffMs = 100;',
  'export const jitter = true;',
  'export const logLevel = "info";',
  'export const timeoutMs = 5000;',
  '',
].join('\n');

const router = ['import { home } from "./home";', '', 'export const routes = [home];', ''].join(
  '\n',
);

const cacheA = ['export function evict(key) {', '  return key.length;', '}', ''].join('\n');
const cacheB = ['export function evict(key) {', '  return key.trim();', '}', ''].join('\n');

const legacy = ['export function migrate(row) {', '  return row;', '}', ''].join('\n');

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

export const TEXTUAL: readonly Fixture[] = [
  {
    id: 'overlap-signature',
    title: 'both branches change the same function signature',
    covers: 'textual-overlap',
    base: { 'src/pricing.ts': pricing },
    a: {
      committed: [
        {
          op: 'write',
          path: 'src/pricing.ts',
          content: pricing.replace('subtotal(items)', 'subtotal(items, discount)'),
        },
      ],
      uncommitted: [],
    },
    b: {
      committed: [
        {
          op: 'write',
          path: 'src/pricing.ts',
          content: pricing.replace('subtotal(items)', 'subtotal(items, currency)'),
        },
      ],
      uncommitted: [],
    },
    expected: [
      {
        analyzer: 'textual',
        class: 'overlapping-edit',
        path: 'src/pricing.ts',
        symbol: 'subtotal',
        spanA: { path: 'src/pricing.ts', start: 1, end: 1 },
        spanB: { path: 'src/pricing.ts', start: 1, end: 1 },
      },
    ],
    twinOf: null,
  },
  {
    id: 'overlap-signature-twin-neighbouring-functions',
    title: 'the branches change the bodies of two neighbouring functions',
    covers: 'textual-overlap',
    base: { 'src/pricing.ts': pricing },
    a: {
      committed: [
        {
          op: 'write',
          path: 'src/pricing.ts',
          content: pricing.replace('n + i.price', 'n + i.price * i.qty'),
        },
      ],
      uncommitted: [],
    },
    b: {
      committed: [{ op: 'write', path: 'src/pricing.ts', content: pricing.replace('0.2', '0.21') }],
      uncommitted: [],
    },
    expected: [],
    twinOf: 'overlap-signature',
  },
  {
    id: 'overlap-uncommitted',
    title: 'one branch commits a change to a line the other has edited and not committed',
    covers: 'textual-overlap',
    base: { 'config.ts': config },
    a: {
      committed: [{ op: 'write', path: 'config.ts', content: config.replace('5000', '8000') }],
      uncommitted: [],
    },
    b: {
      committed: [],
      uncommitted: [{ op: 'write', path: 'config.ts', content: config.replace('5000', '2500') }],
    },
    expected: [
      {
        analyzer: 'textual',
        class: 'overlapping-edit',
        path: 'config.ts',
        symbol: 'timeoutMs',
        spanA: { path: 'config.ts', start: 5, end: 5 },
        spanB: { path: 'config.ts', start: 5, end: 5 },
      },
    ],
    twinOf: null,
  },
  {
    id: 'overlap-uncommitted-twin-far-lines',
    title: 'one committed and one uncommitted edit, three lines apart',
    covers: 'textual-overlap',
    base: { 'config.ts': config },
    a: {
      committed: [
        { op: 'write', path: 'config.ts', content: config.replace('retries = 3', 'retries = 4') },
      ],
      uncommitted: [],
    },
    b: {
      committed: [],
      uncommitted: [{ op: 'write', path: 'config.ts', content: config.replace('5000', '2500') }],
    },
    expected: [],
    twinOf: 'overlap-uncommitted',
  },
  {
    id: 'adjacent-imports',
    title: 'both branches add an import at the same place',
    covers: 'adjacent-addition',
    base: { 'src/router.ts': router },
    a: {
      committed: [
        {
          op: 'write',
          path: 'src/router.ts',
          content: router.replace('"./home";\n', '"./home";\nimport { about } from "./about";\n'),
        },
      ],
      uncommitted: [],
    },
    b: {
      committed: [
        {
          op: 'write',
          path: 'src/router.ts',
          content: router.replace(
            '"./home";\n',
            '"./home";\nimport { contact } from "./contact";\n',
          ),
        },
      ],
      uncommitted: [],
    },
    expected: [
      {
        analyzer: 'textual',
        class: 'adjacent-addition',
        path: 'src/router.ts',
        symbol: 'import',
        spanA: { path: 'src/router.ts', start: 2, end: 2 },
        spanB: { path: 'src/router.ts', start: 2, end: 2 },
      },
    ],
    twinOf: null,
  },
  {
    id: 'adjacent-imports-twin-opposite-ends',
    title: 'the branches add imports at opposite ends of the file',
    covers: 'adjacent-addition',
    base: { 'src/router.ts': router },
    a: {
      committed: [
        {
          op: 'write',
          path: 'src/router.ts',
          content: `import { about } from "./about";\n${router}`,
        },
      ],
      uncommitted: [],
    },
    b: {
      committed: [
        {
          op: 'write',
          path: 'src/router.ts',
          content: `${router}import { contact } from "./contact";\n`,
        },
      ],
      uncommitted: [],
    },
    expected: [],
    twinOf: 'adjacent-imports',
  },
  {
    id: 'adjacent-imports-twin-same-line',
    title: 'both branches add the same import at the same place',
    covers: 'adjacent-addition',
    base: { 'src/router.ts': router },
    a: {
      committed: [
        {
          op: 'write',
          path: 'src/router.ts',
          content: router.replace('"./home";\n', '"./home";\nimport { about } from "./about";\n'),
        },
      ],
      uncommitted: [],
    },
    b: {
      committed: [],
      uncommitted: [
        {
          op: 'write',
          path: 'src/router.ts',
          content: router.replace('"./home";\n', '"./home";\nimport { about } from "./about";\n'),
        },
      ],
    },
    expected: [],
    twinOf: 'adjacent-imports',
  },
  {
    id: 'add-add',
    title: 'both branches create the same file, one of them still uncommitted',
    covers: 'add-add',
    base: { 'README.md': 'readme\n' },
    a: {
      committed: [{ op: 'write', path: 'src/cache.ts', content: cacheA }],
      uncommitted: [],
    },
    b: {
      committed: [],
      uncommitted: [{ op: 'write', path: 'src/cache.ts', content: cacheB }],
    },
    expected: [
      {
        analyzer: 'textual',
        class: 'add-add',
        path: 'src/cache.ts',
        symbol: 'evict',
        // With no base to compare against, the whole file is one region.
        spanA: { path: 'src/cache.ts', start: 1, end: 3 },
        spanB: { path: 'src/cache.ts', start: 1, end: 3 },
      },
    ],
    twinOf: null,
  },
  {
    id: 'add-add-twin-different-paths',
    title: 'the branches create files of the same shape at different paths',
    covers: 'add-add',
    base: { 'README.md': 'readme\n' },
    a: {
      committed: [{ op: 'write', path: 'src/cache.ts', content: cacheA }],
      uncommitted: [],
    },
    b: {
      committed: [],
      uncommitted: [{ op: 'write', path: 'src/queue.ts', content: cacheB }],
    },
    expected: [],
    twinOf: 'add-add',
  },
  {
    id: 'edit-delete',
    title: 'one branch edits a file the other has deleted and not committed',
    covers: 'edit-delete',
    base: { 'src/legacy.ts': legacy, 'src/other.ts': 'export const other = 1;\n' },
    a: {
      committed: [
        {
          op: 'write',
          path: 'src/legacy.ts',
          content: legacy.replace('return row;', 'return migrateRow(row);'),
        },
      ],
      uncommitted: [],
    },
    b: { committed: [], uncommitted: [{ op: 'delete', path: 'src/legacy.ts' }] },
    expected: [
      {
        analyzer: 'textual',
        class: 'delete-vs-modify',
        path: 'src/legacy.ts',
        symbol: 'migrateRow',
        spanA: { path: 'src/legacy.ts', start: 2, end: 2 },
        spanB: null,
      },
    ],
    twinOf: null,
  },
  {
    id: 'edit-delete-twin-other-file',
    title: 'one branch edits a file while the other deletes a different one',
    covers: 'edit-delete',
    base: { 'src/legacy.ts': legacy, 'src/other.ts': 'export const other = 1;\n' },
    a: {
      committed: [
        {
          op: 'write',
          path: 'src/legacy.ts',
          content: legacy.replace('return row;', 'return migrateRow(row);'),
        },
      ],
      uncommitted: [],
    },
    b: { committed: [], uncommitted: [{ op: 'delete', path: 'src/other.ts' }] },
    expected: [],
    twinOf: 'edit-delete',
  },
  {
    id: 'rename-edit',
    title: 'one branch renames and edits a file, the other edits the same line in place',
    covers: 'rename-edit',
    base: { 'src/parser.ts': parser },
    a: {
      committed: [
        { op: 'rename', from: 'src/parser.ts', to: 'src/parse.ts' },
        {
          op: 'write',
          path: 'src/parse.ts',
          content: parser.replace('input.split(" ")', 'input.split(",")'),
        },
      ],
      uncommitted: [],
    },
    b: {
      committed: [
        {
          op: 'write',
          path: 'src/parser.ts',
          content: parser.replace('input.split(" ")', 'input.split("\\t")'),
        },
      ],
      uncommitted: [],
    },
    expected: [
      {
        analyzer: 'textual',
        class: 'overlapping-edit',
        path: 'src/parse.ts',
        symbol: 'split',
        spanA: { path: 'src/parse.ts', start: 2, end: 2 },
        spanB: { path: 'src/parser.ts', start: 2, end: 2 },
      },
    ],
    twinOf: null,
  },
  {
    id: 'rename-edit-twin-other-line',
    title: 'one branch renames and edits a file, the other edits a line further down',
    covers: 'rename-edit',
    base: { 'src/parser.ts': parser },
    a: {
      committed: [
        { op: 'rename', from: 'src/parser.ts', to: 'src/parse.ts' },
        {
          op: 'write',
          path: 'src/parse.ts',
          content: parser.replace('input.split(" ")', 'input.split(",")'),
        },
      ],
      uncommitted: [],
    },
    b: {
      committed: [
        {
          op: 'write',
          path: 'src/parser.ts',
          content: parser.replace('tokens.join(" ")', 'tokens.join("")'),
        },
      ],
      uncommitted: [],
    },
    expected: [],
    twinOf: 'rename-edit',
  },
  {
    id: 'rename-delete',
    title: 'one branch renames and edits a file the other deletes',
    covers: 'rename-delete',
    base: { 'src/util.ts': util, 'src/other.ts': 'export const other = 1;\n' },
    a: {
      committed: [
        { op: 'rename', from: 'src/util.ts', to: 'src/helpers.ts' },
        {
          op: 'write',
          path: 'src/helpers.ts',
          content: util.replace('Math.max(0, n)', 'Math.max(-1, n)'),
        },
      ],
      uncommitted: [],
    },
    b: { committed: [{ op: 'delete', path: 'src/util.ts' }], uncommitted: [] },
    expected: [
      {
        analyzer: 'textual',
        class: 'rename-vs-delete',
        path: 'src/helpers.ts',
        symbol: 'max',
        spanA: { path: 'src/helpers.ts', start: 2, end: 2 },
        spanB: null,
      },
    ],
    twinOf: null,
  },
  {
    id: 'rename-delete-twin-other-file',
    title: 'one branch renames a file while the other deletes a different one',
    covers: 'rename-delete',
    base: { 'src/util.ts': util, 'src/other.ts': 'export const other = 1;\n' },
    a: {
      committed: [{ op: 'rename', from: 'src/util.ts', to: 'src/helpers.ts' }],
      uncommitted: [],
    },
    b: { committed: [{ op: 'delete', path: 'src/other.ts' }], uncommitted: [] },
    expected: [],
    twinOf: 'rename-delete',
  },
];
