import type { Fixture } from './format.js';

/**
 * Semantic conflicts: pairs that merge cleanly and are broken together.
 *
 * No analyzer catches these yet. They are labelled for the one that should —
 * the compiler for a stale reference, `ast-semantic` for what compiles and is
 * still wrong — so the report shows that analyzer's recall as 0 until it
 * exists, and it is written against labels that were here first.
 *
 * Each branch compiles on its own; only the merge does not. Every fixture
 * carries a `package.json` and `tsconfig.json` so a compiler can be run on it
 * as it stands. Spans are the lines of each branch's half: the changed
 * declaration on one side, the stale reference on the other — or, where the
 * conflict is a symbol both changed, that symbol on each.
 */

const project = {
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

const lines = (...content: string[]): string => `${content.join('\n')}\n`;

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
/** Branch `a`'s rename, with every call site it knows of updated. */
const renamed = [
  {
    op: 'write',
    path: 'src/payments.ts',
    content: payments.replace('processRefund', 'refundPayment'),
  },
  {
    op: 'write',
    path: 'src/checkout.ts',
    content: checkout.replaceAll('processRefund', 'refundPayment'),
  },
] as const;

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

const utils = lines(
  'export function slugify(text: string): string {',
  '  return text.toLowerCase().replace(/\\s+/g, "-");',
  '}',
  '',
  'export function truncate(text: string, length: number): string {',
  '  return text.slice(0, length);',
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

const discount = lines(
  'export function applyDiscount(price: number, percent: number): number {',
  '  if (percent < 0) {',
  '    return price;',
  '  }',
  '  const cut = price * (percent / 100);',
  '  return price - cut;',
  '}',
  '',
  'export function applyTax(price: number, rate: number): number {',
  '  const tax = price * rate;',
  '  return price + tax;',
  '}',
);

const slug = lines(
  'export function toSlug(text: string): string {',
  '  return text.trim().toLowerCase().replace(/\\s+/g, "-");',
  '}',
);

export const SEMANTIC: readonly Fixture[] = [
  {
    id: 'rename-vs-callsite',
    title: 'one branch renames a function, the other adds a call to the old name',
    covers: 'rename-vs-callsite',
    base: { ...project, 'src/payments.ts': payments, 'src/checkout.ts': checkout },
    a: { committed: renamed, uncommitted: [] },
    b: {
      committed: [],
      uncommitted: [
        {
          op: 'write',
          path: 'src/support.ts',
          content: lines(
            'import { processRefund } from "./payments";',
            '',
            'export function escalate(orderId: string): string {',
            '  return processRefund(orderId);',
            '}',
          ),
        },
      ],
    },
    expected: [
      {
        analyzer: 'typecheck',
        class: 'rename-vs-callsite',
        path: 'src/support.ts',
        symbol: 'processRefund',
        spanA: { path: 'src/payments.ts', start: 1, end: 1 },
        spanB: { path: 'src/support.ts', start: 1, end: 4 },
      },
    ],
    twinOf: null,
  },
  {
    id: 'rename-vs-callsite-twin-no-new-call',
    title: 'one branch renames a function, the other adds a file that never calls it',
    covers: 'rename-vs-callsite',
    base: { ...project, 'src/payments.ts': payments, 'src/checkout.ts': checkout },
    a: { committed: renamed, uncommitted: [] },
    b: {
      committed: [],
      uncommitted: [
        {
          op: 'write',
          path: 'src/support.ts',
          content: lines(
            'export function escalate(orderId: string): string {',
            '  return `escalate:${orderId}`;',
            '}',
          ),
        },
      ],
    },
    expected: [],
    twinOf: 'rename-vs-callsite',
  },
  {
    id: 'signature-vs-caller',
    title: 'one branch adds a required parameter, the other adds a call without it',
    covers: 'signature-vs-caller',
    base: { ...project, 'src/format.ts': format, 'src/cart.ts': cart },
    a: {
      committed: [
        {
          op: 'write',
          path: 'src/format.ts',
          content: lines(
            'export function formatPrice(amount: number, currency: string): string {',
            '  return `${currency} ${amount.toFixed(2)}`;',
            '}',
          ),
        },
        {
          op: 'write',
          path: 'src/cart.ts',
          content: cart.replace('formatPrice(total)', 'formatPrice(total, "EUR")'),
        },
      ],
      uncommitted: [],
    },
    b: { committed: [{ op: 'write', path: 'src/invoice.ts', content: invoice }], uncommitted: [] },
    expected: [
      {
        analyzer: 'typecheck',
        class: 'signature-vs-caller',
        path: 'src/invoice.ts',
        symbol: 'formatPrice',
        spanA: { path: 'src/format.ts', start: 1, end: 1 },
        spanB: { path: 'src/invoice.ts', start: 4, end: 4 },
      },
    ],
    twinOf: null,
  },
  {
    id: 'signature-vs-caller-twin-optional-parameter',
    title: 'one branch adds an optional parameter, the other adds a call without it',
    covers: 'signature-vs-caller',
    base: { ...project, 'src/format.ts': format, 'src/cart.ts': cart },
    a: {
      committed: [
        {
          op: 'write',
          path: 'src/format.ts',
          content: lines(
            'export function formatPrice(amount: number, currency = "USD"): string {',
            '  return `${currency} ${amount.toFixed(2)}`;',
            '}',
          ),
        },
      ],
      uncommitted: [],
    },
    b: { committed: [{ op: 'write', path: 'src/invoice.ts', content: invoice }], uncommitted: [] },
    expected: [],
    twinOf: 'signature-vs-caller',
  },
  {
    id: 'moved-export-vs-import',
    title: 'one branch moves an export to another module, the other imports it from the old one',
    covers: 'moved-export-vs-import',
    base: { ...project, 'src/utils.ts': utils, 'src/post.ts': post },
    a: {
      committed: [
        { op: 'write', path: 'src/strings.ts', content: strings },
        { op: 'write', path: 'src/utils.ts', content: truncateOnly },
        { op: 'write', path: 'src/post.ts', content: post.replace('"./utils"', '"./strings"') },
      ],
      uncommitted: [],
    },
    b: { committed: [], uncommitted: [{ op: 'write', path: 'src/tag.ts', content: tag }] },
    expected: [
      {
        analyzer: 'typecheck',
        class: 'moved-export-vs-import',
        path: 'src/tag.ts',
        symbol: 'slugify',
        spanA: { path: 'src/strings.ts', start: 1, end: 3 },
        spanB: { path: 'src/tag.ts', start: 1, end: 4 },
      },
    ],
    twinOf: null,
  },
  {
    id: 'moved-export-vs-import-twin-re-exported',
    title: 'one branch moves an export and re-exports it, the other imports it from the old module',
    covers: 'moved-export-vs-import',
    base: { ...project, 'src/utils.ts': utils, 'src/post.ts': post },
    a: {
      committed: [
        { op: 'write', path: 'src/strings.ts', content: strings },
        {
          op: 'write',
          path: 'src/utils.ts',
          content: `export { slugify } from "./strings";\n\n${truncateOnly}`,
        },
      ],
      uncommitted: [],
    },
    b: { committed: [], uncommitted: [{ op: 'write', path: 'src/tag.ts', content: tag }] },
    expected: [],
    twinOf: 'moved-export-vs-import',
  },
  {
    id: 'same-symbol-dual-edit',
    title: 'both branches change one function, at lines far enough apart to merge',
    covers: 'same-symbol-dual-edit',
    base: { ...project, 'src/discount.ts': discount },
    a: {
      committed: [
        {
          op: 'write',
          path: 'src/discount.ts',
          content: discount.replace('percent < 0)', 'percent < 0 || percent > 100)'),
        },
      ],
      uncommitted: [],
    },
    b: {
      committed: [],
      uncommitted: [
        {
          op: 'write',
          path: 'src/discount.ts',
          content: discount.replace(
            'return price - cut;',
            'return Math.round((price - cut) * 100) / 100;',
          ),
        },
      ],
    },
    expected: [
      {
        analyzer: 'ast-semantic',
        class: 'same-symbol-dual-edit',
        path: 'src/discount.ts',
        symbol: 'applyDiscount',
        // The whole function on each side: the conflict is the symbol, not
        // either edit alone, and each edit on its own is harmless.
        spanA: { path: 'src/discount.ts', start: 1, end: 7 },
        spanB: { path: 'src/discount.ts', start: 1, end: 7 },
      },
    ],
    twinOf: null,
  },
  {
    id: 'same-symbol-dual-edit-twin-two-functions',
    title: 'the branches change two different functions in the same file',
    covers: 'same-symbol-dual-edit',
    base: { ...project, 'src/discount.ts': discount },
    a: {
      committed: [
        {
          op: 'write',
          path: 'src/discount.ts',
          content: discount.replace('percent < 0)', 'percent < 0 || percent > 100)'),
        },
      ],
      uncommitted: [],
    },
    b: {
      committed: [],
      uncommitted: [
        {
          op: 'write',
          path: 'src/discount.ts',
          content: discount.replace('return price + tax;', 'return Math.round(price + tax);'),
        },
      ],
    },
    expected: [],
    twinOf: 'same-symbol-dual-edit',
  },
  {
    id: 'duplicate-implementation',
    title: 'both branches add the same helper under different names in different files',
    covers: 'duplicate-implementation',
    base: { ...project, 'src/index.ts': 'export {};\n' },
    a: { committed: [{ op: 'write', path: 'src/slug.ts', content: slug }], uncommitted: [] },
    b: {
      committed: [],
      uncommitted: [
        {
          op: 'write',
          path: 'src/urls.ts',
          content: lines(
            'export function makeSlug(value: string): string {',
            '  return value.trim().toLowerCase().replace(/\\s+/g, "-");',
            '}',
          ),
        },
      ],
    },
    expected: [
      {
        analyzer: 'ast-semantic',
        class: 'duplicate-implementation',
        path: 'src/slug.ts',
        symbol: 'toSlug',
        spanA: { path: 'src/slug.ts', start: 1, end: 3 },
        spanB: { path: 'src/urls.ts', start: 1, end: 3 },
      },
    ],
    twinOf: null,
  },
  {
    id: 'duplicate-implementation-twin-different-behaviour',
    title: 'both branches add a string helper of the same shape that does something else',
    covers: 'duplicate-implementation',
    base: { ...project, 'src/index.ts': 'export {};\n' },
    a: { committed: [{ op: 'write', path: 'src/slug.ts', content: slug }], uncommitted: [] },
    b: {
      committed: [],
      uncommitted: [
        {
          op: 'write',
          path: 'src/urls.ts',
          content: lines(
            'export function makeTitle(value: string): string {',
            '  return value.trim().replace(/\\b\\w/g, (c) => c.toUpperCase());',
            '}',
          ),
        },
      ],
    },
    expected: [],
    twinOf: 'duplicate-implementation',
  },
];
