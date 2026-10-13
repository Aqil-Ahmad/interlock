import { createHash } from 'node:crypto';
import { InterlockError, silentLogger } from '@interlock/shared';
import type { Logger, RepoConfigOverride } from '@interlock/shared';
import { assertObjectId, runRequired } from '../git/repo-handle.js';
import type { GitRunner, ShadowRepo } from '../git/repo-handle.js';

/**
 * Toolchain detection: which package manager a tree uses, which TypeScript
 * projects make it up, and how it builds — read from the tree, never run.
 *
 * Everything is read out of the shadow's object database by tree id, so the
 * answer exists before any pool slot does and holds for any tree: the merge,
 * either side, or the merge base. Reading objects rather than files is also
 * what keeps a symlink inert: in git a link is a blob holding a path, and a
 * `package.json` linked to a key file is a path string here, where
 * `fs.readFile` would have followed it.
 *
 * Every file read is repository content written by the agents Interlock
 * watches. Each blob's size is checked before it is read, JSON is parsed
 * without trusting its shape, and nothing a file chose — a value, a key, a
 * path — is copied into a reason, because reasons reach the API and the agents.
 */

/** Where an answer came from: this tree, or the repository's `.interlock.json`. */
export type ToolchainOrigin = 'detected' | 'override';

/**
 * The package managers whose projects can be installed and built.
 *
 * Yarn is two: classic and Berry differ in lockfile, install flag and module
 * linking, and only Berry with `node_modules` linking is supported.
 */
export type PackageManagerName = 'pnpm' | 'npm' | 'yarn-classic' | 'yarn-berry';

/** A capability Interlock cannot provide for this tree, and why. */
export interface ToolchainUnsupported {
  readonly status: 'unsupported';
  readonly code: 'TOOLCHAIN_UNSUPPORTED';
  /** Names what was found, never what a file said. */
  readonly reason: string;
}

export type PackageManagerDetection =
  | {
      readonly status: 'supported';
      readonly name: PackageManagerName;
      /** The version `packageManager` pins, without its hash; null when only a lockfile named it. */
      readonly version: string | null;
      /** What settled it: the `packageManager` field, or the only lockfile present. */
      readonly from: 'packageManager' | 'lockfile';
    }
  | ToolchainUnsupported;

/**
 * A command to run in the sandbox.
 *
 * Detected commands are an argument vector Interlock built itself. An override
 * is the repository's string, carried whole: it is never split, interpreted or
 * run here, and only the sandbox runner decides how a string becomes a process.
 */
export type ToolchainCommand =
  | { readonly status: 'supported'; readonly origin: 'detected'; readonly argv: readonly string[] }
  | { readonly status: 'supported'; readonly origin: 'override'; readonly command: string };

/**
 * How a tree is typechecked.
 *
 * Detected, it is the in-process language service over `projects`. An override
 * is a command, which the in-process service cannot run, so the two are told
 * apart by `runner` and the analyzer reading this decides what a command-style
 * typecheck means.
 */
export type TypecheckPlan =
  | {
      readonly status: 'supported';
      readonly origin: 'detected';
      readonly runner: 'language-service';
      /** Each project's tsconfig, relative to the tree root, sorted. Never empty. */
      readonly projects: readonly string[];
    }
  | {
      readonly status: 'supported';
      readonly origin: 'override';
      readonly runner: 'command';
      readonly command: string;
    }
  | ToolchainUnsupported;

export type InstallPlan = ToolchainCommand | ToolchainUnsupported;

/** `none` is a project with no build script: nothing to build, which is not a failure. */
export type BuildPlan = ToolchainCommand | { readonly status: 'none' } | ToolchainUnsupported;

/** What a tree needs to be installed, typechecked and built, answered per capability. */
export interface Toolchain {
  readonly packageManager: PackageManagerDetection;
  readonly install: InstallPlan;
  readonly typecheck: TypecheckPlan;
  readonly build: BuildPlan;
}

/**
 * The error an analyzer raises for a capability this tree does not support.
 *
 * Infrastructure, never a Finding: the tree is not wrong for being built with
 * Bun. `details` carries the capability and the reason, both Interlock's own
 * words.
 */
export function toolchainUnsupported(
  capability: 'packageManager' | 'install' | 'typecheck' | 'build',
  unsupported: ToolchainUnsupported,
): InterlockError {
  return new InterlockError(
    'TOOLCHAIN_UNSUPPORTED',
    `Cannot ${capability === 'packageManager' ? 'identify the package manager' : capability}: ${unsupported.reason}`,
    {
      details: { capability, reason: unsupported.reason },
      remedy:
        'Set the command under "toolchain" in .interlock.json, or disable the analyzer for this repository.',
      infra: true,
    },
  );
}

/**
 * Ceiling on any one file detection reads.
 *
 * Every file here is repository content, so its size is chosen by whoever
 * writes the repository. A real `package.json` or `tsconfig.json` is a few
 * kilobytes; a quarter of a megabyte is room for the largest seen with margin,
 * and small enough that reading one never matters.
 */
export const MAX_TOOLCHAIN_FILE_BYTES = 256 * 1024;

/**
 * Ceiling on how deep solution-style references are followed.
 *
 * A reference cycle is caught by remembering what was visited; this bounds a
 * chain that is merely long, each link of which is a read.
 */
const MAX_REFERENCE_DEPTH = 8;

/**
 * Ceiling on workspace patterns, as on ignore patterns, and for the same
 * reason: every pattern is tried against every `package.json` in the tree.
 */
const MAX_WORKSPACE_PATTERNS = 256;
const MAX_WORKSPACE_PATTERN_LENGTH = 200;

/** Longer than any `name@version+sha512.<hash>` Corepack writes. */
const MAX_PACKAGE_MANAGER_LENGTH = 256;

const LOCKFILES = {
  'pnpm-lock.yaml': 'pnpm',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'yarn',
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
} as const;
type LockfileName = keyof typeof LOCKFILES;

const DENO_MARKERS = ['deno.json', 'deno.jsonc', 'deno.lock'] as const;
/**
 * Plug'n'Play resolves modules by executing this file, so a tree carrying one
 * cannot be typechecked or built without running repository code to find its
 * dependencies.
 */
const PNP_MARKERS = ['.pnp.cjs', '.pnp.js', '.pnp.loader.mjs'] as const;

const ROOT_FILES: ReadonlySet<string> = new Set([
  'package.json',
  'tsconfig.json',
  'pnpm-workspace.yaml',
  '.yarnrc.yml',
  ...Object.keys(LOCKFILES),
  ...DENO_MARKERS,
  ...PNP_MARKERS,
]);

/** Regular files only: a link is refused by mode before it could be read as anything. */
const REGULAR_MODES: ReadonlySet<string> = new Set(['100644', '100755']);
const SYMLINK_MODE = '120000';

const INSTALL_ARGV: Readonly<Record<PackageManagerName, readonly string[]>> = {
  pnpm: ['pnpm', 'install', '--frozen-lockfile'],
  npm: ['npm', 'ci'],
  'yarn-classic': ['yarn', 'install', '--frozen-lockfile'],
  'yarn-berry': ['yarn', 'install', '--immutable'],
};

const BINARY: Readonly<Record<PackageManagerName, string>> = {
  pnpm: 'pnpm',
  npm: 'npm',
  'yarn-classic': 'yarn',
  'yarn-berry': 'yarn',
};

export interface DetectToolchainOptions {
  readonly runner: GitRunner;
  readonly shadow: ShadowRepo;
  /** A tree, or a commit whose tree is read. An object id, never a ref. */
  readonly tree: string;
  /** The repository's `toolchain` override; each command it sets replaces detection's. */
  readonly override?: RepoConfigOverride['toolchain'];
  /** Remembers answers by the blobs they were read from. */
  readonly cache?: ToolchainCache;
  readonly logger?: Logger;
}

/**
 * Detect the toolchain of one tree.
 *
 * Nothing is executed: no package manager is asked its version, no config file
 * is evaluated. A capability Interlock cannot provide is answered
 * `unsupported` with its reason rather than guessed at, and the others are
 * still answered — a JavaScript project with no tsconfig cannot be
 * typechecked and can still be built.
 *
 * @throws InterlockError `GIT_COMMAND_FAILED` when the tree cannot be read.
 */
export async function detectToolchain(options: DetectToolchainOptions): Promise<Toolchain> {
  assertObjectId(options.tree, 'tree');
  const log = (options.logger ?? silentLogger).child('toolchain');
  const listing = await listTree(options);
  const overrideKey = JSON.stringify(options.override ?? {});

  const key = cacheKeyOf(listing, overrideKey);
  const cached = options.cache?.lookup(key, listing);
  if (cached !== undefined) {
    log.debug('toolchain answered from cache', { tree: options.tree });
    return cached;
  }

  const reader = new TreeReader(options.runner, options.shadow, options.tree, listing);
  const detected = await detect(reader);
  const toolchain = applyOverride(detected, options.override);
  options.cache?.store(key, reader.consulted(), toolchain);

  for (const capability of ['packageManager', 'install', 'typecheck', 'build'] as const) {
    const plan = toolchain[capability];
    if (plan.status === 'unsupported') {
      log.info('toolchain capability unsupported', {
        tree: options.tree,
        capability,
        reason: plan.reason,
      });
    }
  }
  return toolchain;
}

/**
 * Answers remembered by the blobs they were read from.
 *
 * Detection runs on every check of a pair, and almost every check is of a tree
 * whose manifests did not change. The key is every `package.json` and
 * tsconfig in the tree, every root file detection looks at, and the override;
 * a hit additionally requires every other file the answer was read from — a
 * tsconfig named by a reference under another name — to hold the same blob.
 * So an unchanged tree costs one `ls-tree` and no reads.
 */
export class ToolchainCache {
  readonly #entries = new Map<
    string,
    { readonly read: ReadonlyMap<string, string | null>; readonly toolchain: Toolchain }
  >();
  readonly #capacity: number;

  /** @param capacity entries kept, least recently used dropped first. */
  constructor(capacity = 64) {
    this.#capacity = capacity;
  }

  /** @internal */
  lookup(key: string, listing: Listing): Toolchain | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    for (const [path, oid] of entry.read) {
      if ((listing.get(path)?.oid ?? null) !== oid) return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.toolchain;
  }

  /** @internal */
  store(key: string, read: ReadonlyMap<string, string | null>, toolchain: Toolchain): void {
    this.#entries.delete(key);
    this.#entries.set(key, { read, toolchain });
    // Insertion order is recency, since a hit re-inserts.
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#capacity) break;
      this.#entries.delete(oldest);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** One entry of the tree, by path from its root. */
interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  /** Bytes; null for anything but a blob. */
  readonly size: number | null;
}

type Listing = ReadonlyMap<string, TreeEntry>;

/**
 * The whole tree, recursively, in one call.
 *
 * Which nested files matter depends on workspace patterns that are only known
 * once the root is read, and every one of them is needed to key the cache, so
 * one listing serves both. `-l` gives each blob's size from the object headers
 * git has open anyway, which is what lets a blob be refused before it is read.
 */
async function listTree(options: DetectToolchainOptions): Promise<Listing> {
  const listing = await runRequired(options.runner, options.shadow, [
    'ls-tree',
    '-r',
    '-z',
    '-l',
    '--full-tree',
    options.tree,
  ]);
  const entries = new Map<string, TreeEntry>();
  for (const record of listing.stdout.split('\0')) {
    // `<mode> SP <type> SP <object> SP+ <size> TAB <path>`; the padding is
    // git's own and never the path's, which starts after the tab.
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode = '', type = '', oid = '', size] = record.slice(0, tab).split(' ').filter(Boolean);
    const bytes = Number(size);
    entries.set(record.slice(tab + 1), {
      mode,
      type,
      oid,
      size: Number.isSafeInteger(bytes) ? bytes : null,
    });
  }
  return entries;
}

function cacheKeyOf(listing: Listing, overrideKey: string): string {
  const hash = createHash('sha256');
  hash.update(overrideKey);
  for (const [path, entry] of listing) {
    if (!isKeyed(path)) continue;
    hash.update('\0');
    hash.update(path);
    hash.update('\0');
    hash.update(entry.mode);
    hash.update(entry.oid);
  }
  return hash.digest('hex');
}

/** The files whose presence alone, not only whose content, decides an answer. */
function isKeyed(path: string): boolean {
  if (ROOT_FILES.has(path)) return true;
  const name = basenameOf(path);
  return name === 'package.json' || (name.startsWith('tsconfig') && name.endsWith('.json'));
}

/** Reads files out of one tree, recording each it consulted for the cache. */
class TreeReader {
  readonly #runner: GitRunner;
  readonly #shadow: ShadowRepo;
  readonly #tree: string;
  readonly listing: Listing;
  readonly #consulted = new Map<string, string | null>();

  constructor(runner: GitRunner, shadow: ShadowRepo, tree: string, listing: Listing) {
    this.#runner = runner;
    this.#shadow = shadow;
    this.#tree = tree;
    this.listing = listing;
  }

  consulted(): ReadonlyMap<string, string | null> {
    return this.#consulted;
  }

  /** The entry at `path`, recorded as consulted whether or not it exists. */
  entry(path: string): TreeEntry | undefined {
    const entry = this.listing.get(path);
    this.#consulted.set(path, entry?.oid ?? null);
    return entry;
  }

  has(path: string): boolean {
    return this.entry(path) !== undefined;
  }

  /**
   * A file's text, or why it cannot be read.
   *
   * A link is refused by its mode rather than read, so what it points at is
   * never even named; its blob would be a path, not the file.
   */
  async text(path: string): Promise<{ text: string } | { refused: string } | null> {
    const entry = this.entry(path);
    if (entry === undefined) return null;
    if (entry.mode === SYMLINK_MODE) return { refused: 'is a symlink' };
    if (entry.type !== 'blob' || !REGULAR_MODES.has(entry.mode)) {
      return { refused: 'is not a regular file' };
    }
    if (entry.size === null || entry.size > MAX_TOOLCHAIN_FILE_BYTES) {
      return { refused: `is larger than ${String(MAX_TOOLCHAIN_FILE_BYTES)} bytes` };
    }
    const blob = await runRequired(this.#runner, this.#shadow, ['cat-file', 'blob', entry.oid]);
    return { text: blob.stdout };
  }

  /**
   * Whether `yarn.lock` opens with Berry's `__metadata` block.
   *
   * Asked of git rather than read: a lockfile is routinely megabytes, far past
   * the ceiling on what is read into memory, and the answer is one line.
   * `grep` exits 1 for no match, which is an answer, not a failure.
   */
  async yarnLockIsBerry(): Promise<boolean> {
    const found = await this.#runner.run(this.#shadow, [
      'grep',
      '-l',
      '-e',
      '^__metadata:',
      this.#tree,
      '--',
      'yarn.lock',
    ]);
    if (found.exitCode === 0) return true;
    if (found.exitCode === 1) return false;
    throw new InterlockError('GIT_COMMAND_FAILED', 'git grep failed', {
      details: { rootPath: this.#shadow.rootPath, command: 'grep', exitCode: found.exitCode },
      remedy: 'Check that the shadow clone is readable and no other git process holds it.',
      infra: true,
    });
  }
}

function unsupported(reason: string): ToolchainUnsupported {
  return { status: 'unsupported', code: 'TOOLCHAIN_UNSUPPORTED', reason };
}

/** What a JSON file held, or why it could not be used. */
type Parsed = { readonly value: Record<string, unknown> } | { readonly problem: string };

/**
 * A JSON file, or why it cannot be used.
 *
 * `label` names the file in a problem. A root file is named by its path, which
 * is Interlock's own constant; a nested one is a path the repository chose, so
 * it is described instead.
 */
async function readJson(
  reader: TreeReader,
  path: string,
  jsonc: boolean,
  label: string = path,
): Promise<Parsed | null> {
  const read = await reader.text(path);
  if (read === null) return null;
  if ('refused' in read) return { problem: `${label} ${read.refused}` };
  const value = parseJson(read.text, jsonc);
  if (value === undefined) return { problem: `${label} is not valid JSON` };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { problem: `${label} is not a JSON object` };
  }
  return { value: value as Record<string, unknown> };
}

function parseJson(source: string, jsonc: boolean): unknown {
  // A leading byte-order mark is not whitespace to `JSON.parse`, and editors
  // on some platforms write one without being asked.
  const text = source.replace(/^\uFEFF/u, '');
  try {
    return JSON.parse(jsonc ? stripJsonc(text) : text);
  } catch {
    return undefined;
  }
}

/**
 * JSONC to JSON: comments become spaces and a trailing comma is dropped.
 *
 * TypeScript reads `tsconfig.json` this way, and real ones lean on it. A
 * single pass with string state, so a `//` inside a string survives and the
 * cost is linear whatever the file holds. A comma counts as trailing when the
 * next character that is not whitespace or a comment closes an object or an
 * array.
 */
export function stripJsonc(source: string): string {
  let out = '';
  let index = 0;
  /** Where the last comma outside a string was written into `out`, until something else follows it. */
  let pendingComma = -1;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '"') {
      const end = endOfString(source, index);
      out += source.slice(index, end);
      index = end;
      pendingComma = -1;
    } else if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
    } else if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      out += ' ';
    } else if (char === ',') {
      pendingComma = out.length;
      out += char;
      index += 1;
    } else if ((char === '}' || char === ']') && pendingComma !== -1) {
      out = out.slice(0, pendingComma) + ' ' + out.slice(pendingComma + 1) + char;
      pendingComma = -1;
      index += 1;
    } else {
      if (!isJsonWhitespace(char)) pendingComma = -1;
      out += char;
      index += 1;
    }
  }
  return out;
}

/** Index just past the string opening at `start`, or the end of input for one never closed. */
function endOfString(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') index += 2;
    else if (char === '"') return index + 1;
    else index += 1;
  }
  return source.length;
}

function isJsonWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

/** An own property only: an inherited one was never in the file. */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Detection proper, before any override is applied. */
async function detect(reader: TreeReader): Promise<Toolchain> {
  const manifest = await readJson(reader, 'package.json', false);
  if (manifest === null) {
    const deno = DENO_MARKERS.find((name) => reader.has(name));
    return everything(
      unsupported(
        deno === undefined
          ? 'no package.json at the root of the tree'
          : `no package.json at the root of the tree; ${deno} marks a Deno project`,
      ),
    );
  }
  if ('problem' in manifest) return everything(unsupported(manifest.problem));

  const pnp = PNP_MARKERS.find((name) => reader.has(name));
  if (pnp !== undefined) {
    return everything(
      unsupported(`${pnp} marks Yarn Plug'n'Play, which resolves modules by executing that file`),
    );
  }

  const packageManager = await detectPackageManager(reader, manifest.value);
  if (packageManager.status === 'unsupported') return everything(packageManager);

  return {
    packageManager,
    install: { status: 'supported', origin: 'detected', argv: INSTALL_ARGV[packageManager.name] },
    typecheck: await detectTypecheck(reader, manifest.value, packageManager.name),
    build: detectBuild(manifest.value, packageManager.name),
  };
}

/** A tree nothing can be done with, for the same reason everywhere. */
function everything(reason: ToolchainUnsupported): Toolchain {
  return { packageManager: reason, install: reason, typecheck: reason, build: reason };
}

/**
 * The package manager: Corepack's `packageManager` first, then the lockfile.
 *
 * When the two disagree, or two lockfiles leave it open, the answer is that it
 * cannot be told — never a pick between them, since installing with the wrong
 * manager resolves a different dependency tree and typechecks against it with
 * confidence.
 */
async function detectPackageManager(
  reader: TreeReader,
  manifest: Record<string, unknown>,
): Promise<PackageManagerDetection> {
  const lockfiles = (Object.keys(LOCKFILES) as LockfileName[]).filter((name) => reader.has(name));
  const managers = [...new Set(lockfiles.map((name) => LOCKFILES[name]))];

  const field = own(manifest, 'packageManager');
  if (field !== undefined) {
    const pinned = parsePackageManager(field);
    if ('problem' in pinned) return unsupported(pinned.problem);
    if (pinned.manager === 'bun') return unsupported('packageManager names Bun');
    if (managers.length > 0 && !managers.includes(pinned.manager)) {
      return unsupported(
        `packageManager names ${pinned.manager}, but the only lockfile is ${lockfiles.join(' and ')}`,
      );
    }
    const name =
      pinned.manager === 'yarn'
        ? majorOf(pinned.version) >= 2
          ? 'yarn-berry'
          : 'yarn-classic'
        : pinned.manager;
    return settle(reader, name, pinned.version, 'packageManager');
  }

  if (managers.length === 0) {
    const deno = DENO_MARKERS.find((marker) => reader.has(marker));
    return unsupported(
      deno === undefined
        ? 'no lockfile and no packageManager field, so the package manager cannot be told'
        : `${deno} marks a Deno project`,
    );
  }
  if (managers.length > 1) {
    return unsupported(
      `lockfiles from more than one package manager (${lockfiles.join(', ')}) and no packageManager field to settle them`,
    );
  }
  const manager = managers[0]!;
  if (manager === 'bun') return unsupported(`${lockfiles.join(' and ')} marks a Bun project`);
  if (manager !== 'yarn') return settle(reader, manager, null, 'lockfile');
  const berry = reader.has('.yarnrc.yml') || (await reader.yarnLockIsBerry());
  return settle(reader, berry ? 'yarn-berry' : 'yarn-classic', null, 'lockfile');
}

/** Yarn Berry is supported only when it links into `node_modules`. */
async function settle(
  reader: TreeReader,
  name: PackageManagerName,
  version: string | null,
  from: 'packageManager' | 'lockfile',
): Promise<PackageManagerDetection> {
  if (name === 'yarn-berry') {
    const problem = await berryLinkerProblem(reader);
    if (problem !== null) return unsupported(problem);
  }
  return { status: 'supported', name, version, from };
}

/**
 * Why a Berry tree cannot be used, or null when `.yarnrc.yml` sets
 * `nodeLinker: node-modules`.
 *
 * Unset, Berry links with Plug'n'Play. Read as one top-level line rather than
 * parsed: the file is YAML, and core takes no YAML parser for one key.
 */
async function berryLinkerProblem(reader: TreeReader): Promise<string | null> {
  const pnp = "Yarn Berry links with Plug'n'Play unless .yarnrc.yml sets nodeLinker: node-modules";
  const read = await reader.text('.yarnrc.yml');
  if (read === null) return pnp;
  if ('refused' in read) return `.yarnrc.yml ${read.refused}`;
  for (const line of read.text.split(/\r?\n/u)) {
    if (!line.startsWith('nodeLinker:')) continue;
    const value = unquote(withoutComment(line.slice('nodeLinker:'.length)).trim());
    return value === 'node-modules'
      ? null
      : 'Yarn Berry links with something other than node-modules';
  }
  return pnp;
}

/** A YAML comment starts at `#` preceded by whitespace, or at the start of the value. */
function withoutComment(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '#' && (index === 0 || value[index - 1] === ' ')) {
      return value.slice(0, index);
    }
  }
  return value;
}

function unquote(value: string): string {
  const first = value[0];
  if ((first === '"' || first === "'") && value.length >= 2 && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}

/** Corepack's `<name>@<version>[+<hash>]`; the version must be exact, as Corepack requires. */
function parsePackageManager(
  field: unknown,
):
  | { readonly manager: 'pnpm' | 'npm' | 'yarn' | 'bun'; readonly version: string }
  | { readonly problem: string } {
  const malformed = { problem: 'packageManager is not of the form <name>@<version>' };
  if (typeof field !== 'string' || field.length > MAX_PACKAGE_MANAGER_LENGTH) return malformed;
  const at = field.indexOf('@');
  if (at <= 0) return malformed;
  const manager = field.slice(0, at);
  const plus = field.indexOf('+', at);
  const version = field.slice(at + 1, plus === -1 ? undefined : plus);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) return malformed;
  if (manager !== 'pnpm' && manager !== 'npm' && manager !== 'yarn' && manager !== 'bun') {
    return { problem: 'packageManager names a manager other than pnpm, npm or Yarn' };
  }
  return { manager, version };
}

function majorOf(version: string): number {
  return Number(version.slice(0, version.indexOf('.')));
}

/** The root's `build` script, run through the package manager that owns the tree. */
function detectBuild(manifest: Record<string, unknown>, manager: PackageManagerName): BuildPlan {
  const scripts = own(manifest, 'scripts');
  if (scripts === undefined) return { status: 'none' };
  if (!isRecord(scripts)) return unsupported('package.json scripts is not a JSON object');
  const build = own(scripts, 'build');
  if (build === undefined) return { status: 'none' };
  if (typeof build !== 'string' || build.trim() === '') {
    return unsupported('package.json scripts.build is not a command');
  }
  return { status: 'supported', origin: 'detected', argv: [BINARY[manager], 'run', 'build'] };
}

/**
 * The tsconfig projects that make up the tree, for the in-process service.
 *
 * A root `tsconfig.json` is the project, unless it is a solution — `files: []`
 * with `references` — whose own project is empty, in which case the referenced
 * projects are. With no root tsconfig, each workspace package's own is.
 */
async function detectTypecheck(
  reader: TreeReader,
  manifest: Record<string, unknown>,
  manager: PackageManagerName,
): Promise<TypecheckPlan> {
  // Workspaces are matched only when the root does not settle both questions:
  // a malformed pattern list in a tree it was never needed for is not a reason
  // to refuse that tree.
  let dirs: readonly string[] | undefined;
  const workspaceDirs = async (): Promise<readonly string[] | string> => {
    if (dirs !== undefined) return dirs;
    const found = await workspaceDirsOf(reader, manifest, manager);
    if ('problem' in found) return found.problem;
    dirs = found.dirs;
    return dirs;
  };

  let projects: Projects;
  if (reader.has('tsconfig.json')) {
    projects = await projectsOf(reader, 'tsconfig.json', 0, new Set());
  } else {
    const found = await workspaceDirs();
    projects = typeof found === 'string' ? { problem: found } : workspaceProjects(reader, found);
  }
  if ('problem' in projects) return unsupported(projects.problem);
  if (projects.paths.length === 0) {
    return unsupported('no tsconfig.json at the root or in any workspace package');
  }

  if (!declaresTypescript(manifest)) {
    const found = await workspaceDirs();
    if (typeof found === 'string') return unsupported(found);
    const typescript = await workspaceDeclaresTypescript(reader, found);
    if (typescript !== true) return unsupported(typescript);
  }

  return {
    status: 'supported',
    origin: 'detected',
    runner: 'language-service',
    projects: [...new Set(projects.paths)].sort(),
  };
}

type Projects = { readonly paths: readonly string[] } | { readonly problem: string };

async function projectsOf(
  reader: TreeReader,
  path: string,
  depth: number,
  visited: Set<string>,
): Promise<Projects> {
  if (visited.has(path)) return { paths: [] };
  visited.add(path);
  const label = path === 'tsconfig.json' ? path : 'a referenced tsconfig';
  const config = await readJson(reader, path, true, label);
  if (config === null) return { problem: 'a project reference names no tsconfig in the tree' };
  if ('problem' in config) return { problem: config.problem };

  const references = own(config.value, 'references');
  const files = own(config.value, 'files');
  const solution =
    Array.isArray(files) &&
    files.length === 0 &&
    Array.isArray(references) &&
    references.length > 0;
  if (!solution) return { paths: [path] };
  if (depth >= MAX_REFERENCE_DEPTH) {
    return { problem: `project references nest deeper than ${String(MAX_REFERENCE_DEPTH)}` };
  }

  const paths: string[] = [];
  for (const reference of references as unknown[]) {
    const target = isRecord(reference) ? own(reference, 'path') : undefined;
    if (typeof target !== 'string' || target === '') {
      return { problem: `${label} has a reference without a path` };
    }
    const resolved = resolveReference(reader, dirnameOf(path), target);
    if (resolved === null) {
      return { problem: `${label} references a project outside the tree or not in it` };
    }
    const found = await projectsOf(reader, resolved, depth + 1, visited);
    if ('problem' in found) return found;
    paths.push(...found.paths);
  }
  return { paths };
}

/**
 * Where a reference points: a tsconfig file, or a directory holding one.
 *
 * Resolved in the tree's own path space and refused when it climbs out of it,
 * since a reference is a path the repository chose.
 */
function resolveReference(reader: TreeReader, from: string, target: string): string | null {
  if (target.startsWith('/')) return null;
  const joined = normalize(from === '' ? target : `${from}/${target}`);
  if (joined === null) return null;
  if (joined.endsWith('.json') && reader.listing.get(joined)?.type === 'blob') return joined;
  const inside = joined === '' ? 'tsconfig.json' : `${joined}/tsconfig.json`;
  return reader.listing.has(inside) ? inside : null;
}

/** Collapse `.` and `..`; null for a path that leaves the root. */
function normalize(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function workspaceProjects(reader: TreeReader, dirs: readonly string[]): Projects {
  const paths: string[] = [];
  for (const dir of dirs) {
    const path = `${dir}/tsconfig.json`;
    const entry = reader.entry(path);
    if (entry === undefined) continue;
    // The language service reads a project from disk, where a link is followed.
    if (entry.mode === SYMLINK_MODE) return { problem: 'a workspace tsconfig.json is a symlink' };
    if (!REGULAR_MODES.has(entry.mode)) {
      return { problem: 'a workspace tsconfig.json is not a regular file' };
    }
    paths.push(path);
  }
  return { paths };
}

/**
 * `typescript` among any workspace package's dependencies.
 *
 * Asked only when the root does not declare it, since each manifest is a read
 * and most monorepos declare the compiler once, at the root.
 */
async function workspaceDeclaresTypescript(
  reader: TreeReader,
  dirs: readonly string[],
): Promise<true | string> {
  for (const dir of dirs) {
    const path = `${dir}/package.json`;
    const workspace = await readJson(reader, path, false, 'a workspace package.json');
    if (workspace === null) continue;
    if ('problem' in workspace) return workspace.problem;
    if (declaresTypescript(workspace.value)) return true;
  }
  return 'typescript is not a dependency of the root or of any workspace package';
}

function declaresTypescript(manifest: Record<string, unknown>): boolean {
  return ['dependencies', 'devDependencies'].some((field) => {
    const deps = own(manifest, field);
    return isRecord(deps) && typeof own(deps, 'typescript') === 'string';
  });
}

/**
 * Workspace package directories, sorted.
 *
 * pnpm reads `pnpm-workspace.yaml` and ignores the `workspaces` field; npm and
 * Yarn read the field. Each manager's own source, so a package the manager
 * would not install is never named as a project.
 */
async function workspaceDirsOf(
  reader: TreeReader,
  manifest: Record<string, unknown>,
  manager: PackageManagerName,
): Promise<{ readonly dirs: readonly string[] } | { readonly problem: string }> {
  const patterns =
    manager === 'pnpm' ? await pnpmWorkspacePatterns(reader) : npmWorkspacePatterns(manifest);
  if ('problem' in patterns) return patterns;
  if (patterns.list.length > MAX_WORKSPACE_PATTERNS) {
    return { problem: `more than ${String(MAX_WORKSPACE_PATTERNS)} workspace patterns` };
  }
  if (patterns.list.some((pattern) => pattern.length > MAX_WORKSPACE_PATTERN_LENGTH)) {
    return {
      problem: `a workspace pattern is longer than ${String(MAX_WORKSPACE_PATTERN_LENGTH)} characters`,
    };
  }

  const include = patterns.list.filter((p) => !p.startsWith('!')).map(splitPattern);
  const exclude = patterns.list
    .filter((p) => p.startsWith('!'))
    .map((p) => splitPattern(p.slice(1)));
  const dirs: string[] = [];
  for (const path of reader.listing.keys()) {
    if (path === 'package.json' || basenameOf(path) !== 'package.json') continue;
    const dir = dirnameOf(path);
    const segments = dir.split('/');
    // A dependency checked into the tree is not a workspace package, whatever
    // a `**` pattern says; pnpm and npm skip it the same way.
    if (segments.includes('node_modules')) continue;
    if (!include.some((p) => matchSegments(p, segments))) continue;
    if (exclude.some((p) => matchSegments(p, segments))) continue;
    dirs.push(dir);
  }
  return { dirs: dirs.sort() };
}

function splitPattern(pattern: string): string[] {
  return pattern.split('/').filter((part) => part !== '' && part !== '.');
}

/**
 * Glob segments against path segments: `*` within a segment, `**` across any
 * number of them.
 *
 * Scanned rather than translated to a regular expression: a pattern is
 * repository content, and a translated glob alternating wildcards with literals
 * backtracks exponentially. Memoised on the two positions, so the worst case
 * is their product.
 */
export function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  const memo = new Map<number, boolean>();
  const at = (p: number, s: number): boolean => {
    const key = p * (path.length + 1) + s;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (p === pattern.length) result = s === path.length;
    else if (pattern[p] === '**') result = at(p + 1, s) || (s < path.length && at(p, s + 1));
    else result = s < path.length && matchSegment(pattern[p]!, path[s]!) && at(p + 1, s + 1);
    memo.set(key, result);
    return result;
  };
  return at(0, 0);
}

/** One segment, `*` matching any run of characters; linear in both lengths. */
export function matchSegment(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      resume = t;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

function npmWorkspacePatterns(
  manifest: Record<string, unknown>,
): { readonly list: readonly string[] } | { readonly problem: string } {
  let field = own(manifest, 'workspaces');
  if (field === undefined) return { list: [] };
  // Yarn classic also accepts `{ "packages": [...] }`.
  if (isRecord(field)) field = own(field, 'packages') ?? [];
  if (!Array.isArray(field) || !field.every((entry) => typeof entry === 'string')) {
    return { problem: 'package.json workspaces is not a list of patterns' };
  }
  return { list: field };
}

/**
 * The `packages:` list of `pnpm-workspace.yaml`, read without a YAML parser.
 *
 * A block list of plain or quoted scalars and a one-line flow list are what
 * pnpm's own documentation and every real file use. Anything else is refused
 * rather than half-read: a list read short names fewer projects, and a
 * typecheck over fewer projects reports a clean tree it never looked at.
 */
export function readPnpmWorkspacePackages(
  source: string,
): { readonly list: readonly string[] } | { readonly problem: string } {
  const unreadable = {
    problem: 'pnpm-workspace.yaml has a packages list in a form this reader does not parse',
  };
  const lines = source.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  const start = lines.findIndex((line) => /^packages\s*:/u.test(line));
  if (start === -1) return { list: [] };

  const inline = withoutComment(lines[start]!.slice(lines[start]!.indexOf(':') + 1)).trim();
  if (inline !== '') {
    if (!inline.startsWith('[') || !inline.endsWith(']')) return unreadable;
    const body = inline.slice(1, -1).trim();
    if (body === '') return { list: [] };
    const list: string[] = [];
    for (const item of body.split(',')) {
      const value = scalar(item.trim());
      if (value === null) return unreadable;
      list.push(value);
    }
    return { list };
  }

  const list: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const content = withoutComment(line).trimEnd();
    if (content.trim() === '') continue;
    // The next top-level key ends the list.
    if (!line.startsWith(' ') && !line.startsWith('-') && !line.startsWith('\t')) break;
    const item = content.trim();
    if (!item.startsWith('- ') && item !== '-') return unreadable;
    const value = scalar(item.slice(1).trim());
    if (value === null) return unreadable;
    list.push(value);
  }
  return { list };
}

/** A plain or quoted YAML scalar without escapes; null for anything richer. */
function scalar(item: string): string | null {
  if (item === '') return null;
  const first = item[0];
  if (first === '"' || first === "'") {
    if (item.length < 2 || !item.endsWith(first)) return null;
    const body = item.slice(1, -1);
    return body.includes(first) || body.includes('\\') ? null : body;
  }
  if ('[]{}&*|>%@`-'.includes(first!) || item.includes(': ')) return null;
  return item;
}

async function pnpmWorkspacePatterns(
  reader: TreeReader,
): Promise<{ readonly list: readonly string[] } | { readonly problem: string }> {
  const read = await reader.text('pnpm-workspace.yaml');
  if (read === null) return { list: [] };
  if ('refused' in read) return { problem: `pnpm-workspace.yaml ${read.refused}` };
  return readPnpmWorkspacePackages(read.text);
}

/**
 * Each command the override sets replaces what detection found for it.
 *
 * Even where detection gave up: an override is the repository saying how it
 * is installed or built, which is exactly what detection could not tell.
 */
function applyOverride(
  detected: Toolchain,
  override: RepoConfigOverride['toolchain'] | undefined,
): Toolchain {
  if (override === undefined) return detected;
  return {
    packageManager: detected.packageManager,
    install:
      override.install === undefined
        ? detected.install
        : { status: 'supported', origin: 'override', command: override.install },
    typecheck:
      override.typecheck === undefined
        ? detected.typecheck
        : {
            status: 'supported',
            origin: 'override',
            runner: 'command',
            command: override.typecheck,
          },
    build:
      override.build === undefined
        ? detected.build
        : { status: 'supported', origin: 'override', command: override.build },
  };
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirnameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}
