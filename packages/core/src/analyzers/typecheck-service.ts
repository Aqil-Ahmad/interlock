import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import ts from 'typescript';

/**
 * A TypeScript language service over one tree on disk, kept warm between
 * checks.
 *
 * Runs wherever it is loaded — in a worker thread in the daemon, in the test
 * process under test — and imports nothing of Interlock's at run time, because
 * a worker loads it by path from `src` as well as from `dist`, and type
 * stripping cannot follow a `.js` specifier back to a `.ts` file.
 *
 * Two things here are security boundaries rather than plumbing:
 *
 *  - **Nothing from the repository executes.** The compiler is Interlock's own
 *    pinned `typescript`, imported here, never the tree's `node_modules`
 *    copy, which is files an agent can write. `plugins` is deleted from every
 *    project's options once its `extends` chain is resolved: a language-service
 *    plugin is code the host process loads, and an `extends` into
 *    `node_modules` can introduce one.
 *  - **Reads stay confined.** Every path the compiler asks about goes through
 *    {@link Confinement}: files inside the tree, `node_modules` answered from
 *    the dependency checkout, and Interlock's own `lib` files. Anything else —
 *    a `../../.ssh` in `include`, an absolute path in `paths`, a symlink in
 *    the tree pointing out of it — does not exist as far as the compiler can
 *    tell. `ts.sys` is never consulted, so no default can widen it.
 */

/** Where a check's diagnostics came from: the configuration, or the code. */
export interface ConfigDiagnostic {
  readonly code: number;
  readonly category: DiagnosticCategory;
  /** Flattened: a chain's lines joined with newlines. */
  readonly message: string;
  /** Relative to the tree, when the diagnostic points into a file there — a tsconfig, usually. */
  readonly file: string | null;
  readonly start: number | null;
  readonly length: number | null;
}

export interface FileDiagnostic {
  readonly code: number;
  readonly category: DiagnosticCategory;
  readonly message: string;
  /** Relative to the tree. A dependency's file is under `node_modules/`, as the compiler saw it. */
  readonly file: string;
  readonly start: number;
  readonly length: number;
  /** One-based, as `tsc` prints them. */
  readonly line: number;
  readonly column: number;
}

export type DiagnosticCategory = 'error' | 'warning' | 'suggestion' | 'message';

/**
 * What one check found.
 *
 * Configuration diagnostics are kept apart from file diagnostics: a broken
 * tsconfig or a missing `lib` says the project cannot be judged, not that the
 * code is wrong, and whatever reads this treats the two differently.
 */
export interface TypecheckReport {
  readonly config: readonly ConfigDiagnostic[];
  readonly files: readonly FileDiagnostic[];
  /** Every project checked, as tsconfig paths relative to the tree, in the order checked. */
  readonly projects: readonly string[];
}

export type TypecheckResult =
  { readonly kind: 'checked'; readonly report: TypecheckReport } | { readonly kind: 'cancelled' };

/** The file system calls the service makes, all of them. Injected by tests to watch them. */
export interface HostFileSystem {
  readFile(path: string): string | undefined;
  stat(path: string): HostStat | undefined;
  readdir(path: string): readonly Dirent[];
  realpath(path: string): string | undefined;
}

export interface HostStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
}

export interface TypecheckServiceOptions {
  /** The tree to check: a pool slot, today. Absolute. */
  readonly root: string;
  /** The checkout whose installed `node_modules` the tree borrows. Absolute. */
  readonly dependencyRoot: string;
  /** The tsconfig to start from, relative to `root`. */
  readonly project?: string;
  readonly fileSystem?: HostFileSystem;
}

export interface CheckOptions {
  /**
   * The tree was written whole since the last check, so no file's version can
   * be trusted to have changed with its content.
   */
  readonly cold?: boolean;
  /** Polled by the compiler as it works; true stops the check where it stands. */
  readonly isCancelled?: () => boolean;
}

export interface TypecheckService {
  check(options?: CheckOptions): TypecheckResult;
  dispose(): void;
}

/** As `typecheck-paths`, which this module cannot import. */
export const DEFAULT_PROJECT = 'tsconfig.json';

/** Node's file system, quietly: an unreadable path is an absent one. */
export const NODE_FILE_SYSTEM: HostFileSystem = {
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  stat: (path) => {
    try {
      const found = statSync(path);
      return {
        isFile: found.isFile(),
        isDirectory: found.isDirectory(),
        size: found.size,
        mtimeMs: found.mtimeMs,
        ctimeMs: found.ctimeMs,
        ino: found.ino,
      };
    } catch {
      return undefined;
    }
  },
  readdir: (path) => {
    try {
      return readdirSync(path, { withFileTypes: true });
    } catch {
      return [];
    }
  },
  realpath: (path) => {
    try {
      // One system call: the JavaScript `realpathSync` stats every component
      // of the path, which was most of what a warm check spent.
      return realpathSync.native(path);
    } catch {
      return undefined;
    }
  },
};

/**
 * `ts.matchFiles`, which expands `include` and `exclude` exactly as `tsc`
 * does, over directory listings the caller supplies. Not in the public
 * declarations; a host that walks the disk itself would answer `include`
 * with a different file set from `tsc`'s, which is the comparison this
 * service is held to.
 */
type MatchFiles = (
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => {
    readonly files: readonly string[];
    readonly directories: readonly string[];
  },
  realpath: (path: string) => string,
) => string[];

/** The module's `matchFiles`, refused rather than guessed at if a TypeScript upgrade drops it. */
export function matchFilesOf(module: unknown): MatchFiles {
  const found = (module as { readonly matchFiles?: unknown }).matchFiles;
  if (typeof found !== 'function') {
    throw new Error('this TypeScript does not provide matchFiles, which reading a tsconfig needs');
  }
  return found as MatchFiles;
}

const matchFiles = matchFilesOf(ts);

/** Interlock's own compiler's `lib` directory: the one place outside the tree the service reads. */
const LIB_DIR = dirname(ts.getDefaultLibFilePath({}));

const NODE_MODULES = 'node_modules';

/**
 * The read policy, and the mapping from what the compiler asks for to what is
 * read.
 *
 * The compiler sees one tree: the slot, with a `node_modules` in it. Nothing
 * of the kind is on disk — a slot holds tracked files only — so a path with a
 * `node_modules` segment is answered from the same place in the dependency
 * checkout. Every answer stays in the slot's terms, so a diagnostic in a
 * dependency is still a path the slot would have.
 *
 * A workspace package is the exception that makes the mapping necessary
 * rather than convenient. In a pnpm workspace `node_modules/@scope/pkg` links
 * to `../../packages/pkg`: followed in the dependency checkout, it would
 * type-check the merge against the user's copy of the sibling package rather
 * than the merged one. So a link whose target is inside the dependency
 * checkout but outside any `node_modules` resolves back into the slot.
 */
export class Confinement {
  readonly #fs: HostFileSystem;
  readonly #root: string;
  readonly #dependencies: string;
  readonly #lib: string;
  readonly #realpaths = new Map<string, string | undefined>();
  readonly #stats = new Map<string, HostStat | undefined>();

  constructor(root: string, dependencyRoot: string, fileSystem: HostFileSystem) {
    this.#fs = fileSystem;
    this.#root = canonical(root, fileSystem);
    this.#dependencies = canonical(dependencyRoot, fileSystem);
    this.#lib = canonical(LIB_DIR, fileSystem);
  }

  /**
   * Forget what the disk said. Answers are remembered within a check, where
   * the compiler asks after the same few thousand paths many times over and
   * the tree holds still; between checks it does not.
   */
  forget(): void {
    this.#realpaths.clear();
    this.#stats.clear();
  }

  #realpathOf(path: string): string | undefined {
    if (this.#realpaths.has(path)) return this.#realpaths.get(path);
    const real = this.#fs.realpath(path);
    this.#realpaths.set(path, real);
    return real;
  }

  /** The tree, as every path the compiler is given starts. */
  get root(): string {
    return this.#root;
  }

  /** The real file behind a path the compiler asked for, or null where it may not look. */
  physical(path: string): string | null {
    const absolute = resolve(this.#root, path);
    if (within(this.#lib, absolute)) return absolute;
    if (!within(this.#root, absolute)) return null;
    const inTree = relative(this.#root, absolute);
    if (!hasNodeModules(inTree)) return this.#inTree(absolute);
    const real = this.#realpathOf(join(this.#dependencies, inTree));
    if (real === undefined || !within(this.#dependencies, real)) return null;
    const inCheckout = relative(this.#dependencies, real);
    return hasNodeModules(inCheckout) ? real : this.#inTree(join(this.#root, inCheckout));
  }

  /**
   * A path's identity as the compiler should see it: where its links lead, in
   * the slot's terms. A path that may not be read is its own identity; reading
   * it still finds nothing.
   */
  realpath(path: string): string {
    const absolute = resolve(this.#root, path);
    if (!within(this.#root, absolute)) return absolute;
    const inTree = relative(this.#root, absolute);
    if (!hasNodeModules(inTree)) {
      const real = this.#realpathOf(absolute);
      return real !== undefined && within(this.#root, real) ? real : absolute;
    }
    const real = this.#realpathOf(join(this.#dependencies, inTree));
    if (real === undefined || !within(this.#dependencies, real)) return absolute;
    return join(this.#root, relative(this.#dependencies, real));
  }

  readFile(path: string): string | undefined {
    const physical = this.physical(path);
    return physical === null ? undefined : this.#fs.readFile(physical);
  }

  stat(path: string): HostStat | undefined {
    const physical = this.physical(path);
    if (physical === null) return undefined;
    if (this.#stats.has(physical)) return this.#stats.get(physical);
    const found = this.#fs.stat(physical);
    this.#stats.set(physical, found);
    return found;
  }

  fileExists(path: string): boolean {
    return this.stat(path)?.isFile === true;
  }

  directoryExists(path: string): boolean {
    return this.stat(path)?.isDirectory === true;
  }

  /** A directory's entries by name, each classified by where it leads, links included. */
  entries(path: string): { readonly files: string[]; readonly directories: string[] } {
    const files: string[] = [];
    const directories: string[] = [];
    const physical = this.physical(path);
    if (physical === null) return { files, directories };
    for (const entry of this.#fs.readdir(physical)) {
      let isFile = entry.isFile();
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        const target = this.stat(join(path, entry.name));
        isFile = target?.isFile === true;
        isDirectory = target?.isDirectory === true;
      }
      if (isFile) files.push(entry.name);
      else if (isDirectory) directories.push(entry.name);
    }
    return { files: files.sort(), directories: directories.sort() };
  }

  /** A checkout path that is not a link out of the tree. */
  #inTree(path: string): string | null {
    const real = this.#realpathOf(path);
    if (real === undefined) return path;
    return within(this.#root, real) ? real : null;
  }
}

/**
 * Resolve a project's tsconfig through the confinement, with every option
 * that would load code removed.
 *
 * `plugins` is deleted after `extends` has been resolved — the only point at
 * which every link of the chain, `node_modules` ones included, has been read
 * into it. The options are otherwise the file's own: a project read as
 * another's reference must not say it emits nothing (TS6310), so `noEmit` is
 * added only where a project is checked as itself.
 */
export function readProject(configPath: string, confinement: Confinement): ts.ParsedCommandLine {
  const unrecoverable: ts.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    getCurrentDirectory: () => confinement.root,
    fileExists: (path) => confinement.fileExists(path),
    readFile: (path) => confinement.readFile(path),
    readDirectory: (root, extensions, excludes, includes, depth) =>
      readDirectory(confinement, root, extensions, excludes, includes, depth),
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => unrecoverable.push(diagnostic),
  });
  const result: ts.ParsedCommandLine = parsed ?? {
    options: {},
    fileNames: [],
    errors: unrecoverable,
  };
  delete result.options.plugins;
  return result;
}

function readDirectory(
  confinement: Confinement,
  root: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  depth: number | undefined,
): string[] {
  return matchFiles(
    root,
    extensions,
    excludes,
    includes,
    ts.sys.useCaseSensitiveFileNames,
    confinement.root,
    depth,
    (path) => confinement.entries(path),
    (path) => confinement.realpath(path),
  );
}

/** One project's live state: its language service and the builder its diagnostics are cached in. */
interface Project {
  readonly configPath: string;
  parsed: ts.ParsedCommandLine;
  /** The project's options as `tsc --noEmit -p` checks it. */
  settings: ts.CompilerOptions;
  readonly service: ts.LanguageService;
  program: ts.Program | undefined;
  builder: ts.SemanticDiagnosticsBuilderProgram | undefined;
  /** The builder has files it has not yet said were affected by the last change. */
  pending: boolean;
  /**
   * Declaration diagnostics by file, for files no change since has affected.
   * The builder caches semantic diagnostics and not these, and computing them
   * for one file type-checks it: left uncached, a check with nothing changed
   * re-checks the whole project.
   */
  readonly declarations: Map<string, readonly ts.Diagnostic[]>;
}

export function createTypecheckService(options: TypecheckServiceOptions): TypecheckService {
  const confinement = new Confinement(
    options.root,
    options.dependencyRoot,
    options.fileSystem ?? NODE_FILE_SYSTEM,
  );
  const rootConfig = join(confinement.root, options.project ?? DEFAULT_PROJECT);
  const registry = ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, confinement.root);
  const projects = new Map<string, Project>();
  /**
   * Bumped by a cold check, and part of every file's version: a tree written
   * whole may hold a file whose size and timestamps happen to match what was
   * there before, and only this says otherwise.
   */
  let epoch = 0;
  /** Configs read during the current check, so a project referenced twice is parsed once. */
  let configs = new Map<string, ts.ParsedCommandLine>();
  /**
   * Files whose imports the last check could not resolve, or every file when
   * it did not get as far as finding out.
   *
   * The language service re-resolves a file's imports only when the file
   * changes or the root files do, and nothing watches the paths a failed
   * lookup tried. So an import of a file outside `include` stays unresolved
   * after a merge adds the file, unless its importer is named here: each check
   * resolves these again, which costs only the files that were already broken.
   */
  let suspect: ReadonlySet<string> | 'all' = new Set();
  /** Being gathered by the check in progress, for the next one. */
  let gathering: Set<string> | 'all' = new Set();

  /** Each project's last reading, handed back while it reads the same. */
  const lastRead = new Map<string, ts.ParsedCommandLine>();

  /**
   * A project's configuration, read once per check.
   *
   * Read again on every check, since an added file changes what `include`
   * matches; but a reading equal to the last one is answered with the last
   * one's object. The language service compares a referenced project's
   * reading by identity, so a fresh object would rebuild every program that
   * references it, on every check, with nothing changed.
   */
  const projectOf = (configPath: string): ts.ParsedCommandLine => {
    const known = configs.get(configPath);
    if (known !== undefined) return known;
    const read = readProject(configPath, confinement);
    const previous = lastRead.get(configPath);
    const parsed = previous !== undefined && sameReading(previous, read) ? previous : read;
    lastRead.set(configPath, parsed);
    configs.set(configPath, parsed);
    return parsed;
  };

  const versionOf = (path: string): string => {
    const found = confinement.stat(path);
    // Every field a rewrite moves: `reset --hard` writes a changed file anew,
    // which is a new inode and a new change time even within one tick.
    return found === undefined
      ? `${epoch}:absent`
      : `${epoch}:${found.ino}:${found.size}:${found.mtimeMs}:${found.ctimeMs}`;
  };

  const createProject = (configPath: string): Project => {
    // The last two members are read from the host by the language service, as
    // tsserver's projects supply them, though the public declarations list
    // them only on the compiler and watch hosts.
    const host: ts.LanguageServiceHost & {
      useSourceOfProjectReferenceRedirect(): boolean;
      hasInvalidatedResolutions(path: string): boolean;
    } = {
      // These read `project`, assigned below, and are called only once a
      // check asks the service for its program.
      getCompilationSettings: () => project.settings,
      getScriptFileNames: () => project.parsed.fileNames,
      getProjectReferences: () => project.parsed.projectReferences,
      getScriptVersion: versionOf,
      getScriptSnapshot: (path) => {
        const text = confinement.readFile(path);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => confinement.root,
      getDefaultLibFileName: (settings) => ts.getDefaultLibFilePath(settings),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      fileExists: (path) => confinement.fileExists(path),
      readFile: (path) => confinement.readFile(path),
      directoryExists: (path) => confinement.directoryExists(path),
      getDirectories: (path) => confinement.entries(path).directories,
      realpath: (path) => confinement.realpath(path),
      // Read by the service in place of parsing a reference itself, which
      // would need the host to list directories too.
      getParsedCommandLine: projectOf,
      // A slot holds no build output, so a reference is read as its sources,
      // as an editor reads it, rather than as declarations nobody built.
      useSourceOfProjectReferenceRedirect: () => true,
      hasInvalidatedResolutions: (path) => suspect === 'all' || suspect.has(canonicalName(path)),
    };
    const parsed = projectOf(configPath);
    const project: Project = {
      configPath,
      parsed,
      settings: { ...parsed.options, noEmit: true },
      service: ts.createLanguageService(host, registry),
      program: undefined,
      builder: undefined,
      pending: false,
      declarations: new Map(),
    };
    return project;
  };

  /** The root project and everything it references, depth first, each once. */
  const projectsToCheck = (): string[] => {
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (configPath: string): void => {
      if (seen.has(configPath)) return;
      seen.add(configPath);
      for (const reference of projectOf(configPath).projectReferences ?? []) {
        visit(ts.resolveProjectReferencePath(reference));
      }
      order.push(configPath);
    };
    visit(rootConfig);
    return order;
  };

  const check = (checkOptions: CheckOptions = {}): TypecheckResult => {
    if (checkOptions.cold === true) epoch += 1;
    confinement.forget();
    configs = new Map();
    gathering = new Set();
    const token: ts.CancellationToken = {
      isCancellationRequested: checkOptions.isCancelled ?? (() => false),
      throwIfCancellationRequested: () => {
        if (!token.isCancellationRequested()) return;
        // TypeScript's own signal, which is not an `Error`: the compiler drops
        // a checker interrupted mid-check only on seeing exactly this.
        const exception: unknown = new ts.OperationCanceledException();
        throw exception;
      },
    };
    try {
      const report = checkAll(token);
      suspect = gathering;
      return { kind: 'checked', report };
    } catch (error) {
      // Cut short, it found out about only some files: the next check
      // resolves every file again rather than trust what it did not reach.
      suspect = 'all';
      if (error instanceof ts.OperationCanceledException) return { kind: 'cancelled' };
      throw error;
    }
  };

  const checkAll = (token: ts.CancellationToken): TypecheckReport => {
    token.throwIfCancellationRequested();
    const order = projectsToCheck();
    for (const [configPath, project] of projects) {
      if (order.includes(configPath)) continue;
      project.service.dispose();
      projects.delete(configPath);
    }

    const config: ts.Diagnostic[] = [];
    const files: ts.Diagnostic[] = [];
    for (const configPath of order) {
      let project = projects.get(configPath);
      if (project === undefined) {
        project = createProject(configPath);
        projects.set(configPath, project);
      } else {
        const parsed = projectOf(configPath);
        project.parsed = parsed;
        project.settings = { ...parsed.options, noEmit: true };
      }
      checkProject(project, token, config, files);
    }
    // One in a file outside the tree — a default `lib` file at odds with
    // something — describes the environment, and is reported with the
    // configuration's.
    // Syntactic, semantic and declaration diagnostics of a source file always
    // carry their location.
    const [code, environment] = partition(
      files as ts.DiagnosticWithLocation[],
      (diagnostic) => inTree(diagnostic.file.fileName) !== null,
    );
    return {
      config: ts
        .sortAndDeduplicateDiagnostics([...config, ...environment])
        .map((diagnostic) => toConfig(diagnostic)),
      files: ts.sortAndDeduplicateDiagnostics(code).map((diagnostic) => toFile(diagnostic)),
      projects: order.map((configPath) => relative(confinement.root, configPath)),
    };
  };

  /**
   * One project's diagnostics, in `tsc`'s order and with its gates: a syntax
   * error anywhere stops the semantic check, and an options or global error
   * stops it too, since a program `tsc` would not check is not checked here.
   */
  const checkProject = (
    project: Project,
    token: ts.CancellationToken,
    config: ts.Diagnostic[],
    files: ts.Diagnostic[],
  ): void => {
    config.push(...project.parsed.errors);
    // Undefined only for a service made in syntactic mode, which this is not.
    const program = project.service.getProgram()!;
    if (program !== project.program) {
      project.builder = ts.createSemanticDiagnosticsBuilderProgram(
        program,
        { createHash: (data) => createHash('sha256').update(data).digest('hex') },
        project.builder,
      );
      project.program = program;
      project.pending = true;
    }
    const builder = project.builder!;
    // A referenced project's sources are in every program that imports them;
    // the compiler skips their semantic check there, as `tsc -b` leaves them
    // to their own project, and what else they report is reported the same
    // way twice and deduplicated.
    const sources = program.getSourceFiles();

    const syntactic = sources.flatMap((file) => program.getSyntacticDiagnostics(file, token));
    files.push(...syntactic);
    const environment =
      syntactic.length > 0
        ? []
        : [...program.getOptionsDiagnostics(token), ...program.getGlobalDiagnostics(token)];
    config.push(...environment);
    if (syntactic.length > 0 || environment.length > 0) {
      gathering = 'all';
      return;
    }
    if (project.pending) drainAffected(project, builder, token);
    const semantic = sources.flatMap((file) => builder.getSemanticDiagnostics(file, token));
    files.push(...semantic);
    for (const diagnostic of semantic) {
      if (gathering !== 'all' && UNRESOLVED.has(diagnostic.code)) {
        gathering.add(canonicalName(diagnostic.file!.fileName));
      }
    }
    const options = program.getCompilerOptions();
    if (semantic.length === 0 && options.noEmit === true && emitsDeclarations(options)) {
      for (const file of sources) {
        let found = project.declarations.get(file.fileName);
        if (found === undefined) {
          found = program.getDeclarationDiagnostics(file, token);
          project.declarations.set(file.fileName, found);
        }
        files.push(...found);
      }
    }
  };

  /**
   * Walk the builder through every file the last change affected, forgetting
   * their declaration diagnostics as it names them — the same propagation
   * `tsc --incremental` uses to decide what to check again.
   *
   * A walk cut short by cancellation has already consumed files nobody wrote
   * down, so it forgets every file instead.
   */
  const drainAffected = (
    project: Project,
    builder: ts.SemanticDiagnosticsBuilderProgram,
    token: ts.CancellationToken,
  ): void => {
    try {
      for (
        let next = builder.getSemanticDiagnosticsOfNextAffectedFile(token);
        next !== undefined;
        next = builder.getSemanticDiagnosticsOfNextAffectedFile(token)
      ) {
        if ('getSourceFiles' in next.affected) project.declarations.clear();
        else project.declarations.delete(next.affected.fileName);
      }
      project.pending = false;
    } catch (error) {
      project.declarations.clear();
      throw error;
    }
  };

  const toConfig = (diagnostic: ts.Diagnostic): ConfigDiagnostic => {
    const file = diagnostic.file === undefined ? null : inTree(diagnostic.file.fileName);
    return {
      code: diagnostic.code,
      category: categoryOf(diagnostic.category),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      file,
      start: file === null ? null : (diagnostic.start ?? null),
      length: file === null ? null : (diagnostic.length ?? null),
    };
  };

  /** A diagnostic about code, in a file in the tree. */
  const toFile = (diagnostic: ts.DiagnosticWithLocation): FileDiagnostic => {
    const { file, start } = diagnostic;
    const position = file.getLineAndCharacterOfPosition(start);
    return {
      code: diagnostic.code,
      category: categoryOf(diagnostic.category),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      file: inTree(file.fileName)!,
      start,
      length: diagnostic.length,
      line: position.line + 1,
      column: position.character + 1,
    };
  };

  const inTree = (fileName: string): string | null => {
    const absolute = resolve(confinement.root, fileName);
    return within(confinement.root, absolute) ? relative(confinement.root, absolute) : null;
  };

  return {
    check,
    dispose: () => {
      for (const project of projects.values()) project.service.dispose();
      projects.clear();
    },
  };
}

function emitsDeclarations(options: ts.CompilerOptions): boolean {
  return options.declaration === true || options.composite === true;
}

/** The enum's own names, lowercased: `Warning`, `Error`, `Suggestion`, `Message`. */
function categoryOf(category: ts.DiagnosticCategory): DiagnosticCategory {
  return ts.DiagnosticCategory[category].toLowerCase() as DiagnosticCategory;
}

function partition<T>(items: readonly T[], test: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const item of items) (test(item) ? yes : no).push(item);
  return [yes, no];
}

/** Two readings of one tsconfig that would build the same program. */
function sameReading(a: ts.ParsedCommandLine, b: ts.ParsedCommandLine): boolean {
  const essence = (parsed: ts.ParsedCommandLine): string => {
    const { configFile: _configFile, ...options } = parsed.options;
    return JSON.stringify([
      parsed.fileNames,
      options,
      parsed.projectReferences ?? [],
      parsed.errors.map((error) => [error.code, error.start, error.messageText]),
    ]);
  };
  return essence(a) === essence(b);
}

/**
 * Codes of a module the compiler looked for and did not find, or found
 * without types: each one a lookup that a file appearing could change.
 */
const UNRESOLVED: ReadonlySet<number> = new Set([2307, 2792, 7016]);

/** A path as the compiler keys files: folded on a file system that ignores case. */
function canonicalName(path: string): string {
  return ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase();
}

function canonical(path: string, fileSystem: HostFileSystem): string {
  return fileSystem.realpath(path) ?? resolve(path);
}

/** On whole segments: `relative('/a', '/a/..b')` is `..b`, which is inside. */
function within(root: string, path: string): boolean {
  const between = relative(root, path);
  return (
    between === '' || (between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between))
  );
}

function hasNodeModules(path: string): boolean {
  return path.split(sep).includes(NODE_MODULES);
}

/** The worker's side of the protocol {@link ./typecheck.ts} speaks. */
export interface WorkerInit {
  readonly root: string;
  readonly dependencyRoot: string;
  readonly project: string;
}

export type WorkerRequest =
  | {
      readonly type: 'check';
      readonly id: number;
      readonly cold: boolean;
      /** One `Int32`, set non-zero by the other thread to cancel this check. */
      readonly cancel: SharedArrayBuffer;
    }
  | { readonly type: 'dispose' };

export type WorkerResponse =
  | { readonly type: 'started'; readonly id: number }
  | {
      readonly type: 'result';
      readonly id: number;
      readonly result: TypecheckResult;
      readonly durationMs: number;
      /** This thread's V8 heap once the check is done: what keeping the service alive costs. */
      readonly heapBytes: number;
    };

/** The parts of a `MessagePort` the protocol uses, so a test can serve it in-process. */
export interface Port {
  on(event: 'message', listener: (message: WorkerRequest) => void): unknown;
  postMessage(message: WorkerResponse): void;
  close(): void;
}

/**
 * Serve checks of one tree over a port, one at a time, in the order asked.
 *
 * Cancellation crosses threads through shared memory because the check is
 * synchronous: nothing posted to this thread is read until it returns, and the
 * compiler polls the flag as it goes.
 */
export function serveTypecheck(port: Port, init: WorkerInit, fileSystem?: HostFileSystem): void {
  const service = createTypecheckService({
    root: init.root,
    dependencyRoot: init.dependencyRoot,
    project: init.project,
    ...(fileSystem === undefined ? {} : { fileSystem }),
  });
  port.on('message', (request) => {
    if (request.type === 'dispose') {
      service.dispose();
      port.close();
      return;
    }
    const flag = new Int32Array(request.cancel);
    port.postMessage({ type: 'started', id: request.id });
    const startedAt = performance.now();
    // Not caught: a compiler that throws has state nobody can vouch for, and
    // the thread dying is how the registry learns to start a new one.
    const result = service.check({
      cold: request.cold,
      isCancelled: () => Atomics.load(flag, 0) !== 0,
    });
    port.postMessage({
      type: 'result',
      id: request.id,
      result,
      durationMs: performance.now() - startedAt,
      heapBytes: getHeapStatistics().used_heap_size,
    });
  });
}
