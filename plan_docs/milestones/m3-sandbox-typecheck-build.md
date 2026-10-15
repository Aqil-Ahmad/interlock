# M3 — Sandbox, typecheck and build

**Goal:** Catch "merges cleanly but breaks". The headline capability.

**Exit criteria:** branch A renames an exported function, branch B adds a call
to the old name; both build green alone; Interlock flags the pair with a
typecheck Finding and correct dual-branch attribution in under 3 minutes, with
zero false positives on the non-conflicting fixture pairs.

**Depends on:** M2.

The compiler is the detector. A stale call site after a rename is already
reported by `tsc` as `TS2304: Cannot find name 'processRefund'`, with a file and
a line — so there is no hand-built matcher to write for this class of problem.

What that leaves is the part the compiler does not do, and it is the real work of
this milestone: knowing which errors are _new because of the merge_, and knowing
_which branch caused which half_ of each one.

## Tasks

- [ ] **Expand this milestone before starting it**
      **Files:** this file
      **What:** the tasks below are one line each. Rewrite them to the depth of `m1-watcher-and-git-core.md` — per-task edge cases, failure modes, the tests each needs, and the constraints it can breach by accident.
      **Done when:** every task below carries a `Done when` naming an observable check, and nothing in it contradicts what earlier milestones learned.

- [x] **Docker sandbox runner**
      **Files:** `packages/core/src/sandbox/` (the runner and its `index.ts`), `packages/core/src/index.ts`, `packages/core/test/sandbox-runner.test.ts`, `packages/shared/src/config.ts` (default image), `packages/shared/src/errors.ts` (codes), ADR-0007, `docs/threat-model.md` (T2, T9), `docs/architecture.md`
      **What:** the one primitive every execution analyzer uses: run an argument array against a merged tree inside Docker, under fixed isolation and limits, and return what happened. No analyzer is built here.

  The build and test analyzers run merged, agent-written code nobody has
  reviewed. Hard rule 2 says it never runs on the host, so the runner is the
  only way it runs at all. How a check writes — the tree, a tmpfs, a per-slot
  cache — is ADR-0007, written before the code.

  **Done when:**
  - _Isolation,_ each shown by a command run in the container: connecting
    to an outside address fails; the uid is not 0; `CapEff` in
    `/proc/self/status` is 0 and `NoNewPrivs` is 1; a write to the tree gets
    `EROFS` and a write to the tmpfs succeeds; no host environment variable
    reaches the container, and there is no Docker socket in it.
  - _Limits,_ each killing the container and saying which fired: a fork bomb
    is held at the PID limit and reported as it; a memory hog is killed and
    reported as out of memory, read from `docker inspect` before the container
    is removed, since exit 137 alone cannot tell an OOM kill from a kill
    signal; a busy loop is killed at the wall-clock limit as
    `SANDBOX_TIMEOUT`; aborting the run's `AbortSignal` kills the container.
  - _Normal results:_ a non-zero exit is a result — exit code, stdout and
    stderr capped with a flag when either was cut, both redacted — never an
    error. What the exit means is the analyzer's call.
  - _Infrastructure:_ Docker not installed, its daemon down, the image absent
    and a mount Docker cannot reach each raise `SANDBOX_UNAVAILABLE` with a
    remedy. None falls back to the host and none pulls: every run passes
    `--pull=never`.
  - _Orphans:_ every container carries a label naming its owner; one left by a
    crashed daemon is found by that label and removed by `SandboxRunner.reapOrphans`.
  - _Pinning:_ the default image in `config.ts` is pinned by digest, as T9
    already claims.

  **Edge cases and the tests they need:**
  - A command string — a `.interlock.json` toolchain override — reaches Docker
    only as `['sh', '-c', command]`, run inside the container. A test runs one
    full of shell metacharacters and shows nothing on the host changed.
  - A mount path with a comma or a quote: `--mount` is CSV, so fields are
    quoted rather than joined. A test mounts such a path.
  - A writable mount of anything the host later reads or runs is refused:
    writable mounts only under the caller's cache root, which must not overlap
    the tree or any read-only source. A socket or device is never a source.
  - Dependency mounts sit read-only at their tree-relative positions under the
    tree's mount point, so a relative pnpm workspace link resolves into the
    merged tree, not the user's. The layout calculation is not built here.
  - The daemon running as root: refused with a remedy rather than run as a
    fixed uid, since a fixed uid cannot read the 0700 data dir without
    loosening it (ADR-0007).
  - Output over the cap, an aborted run, an orphan reaped, a command that
    exits non-zero: each its own test.
  - Containers made by tests carry the label and are removed in `afterEach`,
    even when the test failed. The test image is pinned by digest too.

  **Failure modes:** a container left running after its run — the runner
  removes it on every path, including create and start failures; a limit
  reported as an ordinary exit — classification reads `docker inspect` before
  removal; an unreachable Docker reported as a clean run — it is an infra
  error, never a result.

  **Constraints:**
  - Hard rule 2, including tests: no test runs a command outside Docker "to
    compare".
  - Hard rule 8: where flags differ from ADR-0004, raise it rather than choose.
  - No shell on the host: `execFile` and `spawn` with argument arrays only.
  - Hard rule 7: no new dependency in `core`; the Docker CLI is driven
    directly. The runner is the second process call site, listed beside the
    git runner in `test/support/call-sites.ts`.
  - No silent skips: the sandbox suite reports why it skipped, and fails on
    Linux CI when Docker is missing.
  - Not built here: wiring `SandboxRunner.reapOrphans` into daemon start, the
    per-slot cache's eviction wipe, and the dependency mount layout. Each is
    the first task that needs it: the build analyzer for the first two, the
    typecheck runner's sandboxed counterpart for the third.

- [x] **Toolchain detection**
      **Files:** `packages/core/src/sandbox/toolchain.ts`, `sandbox/index.ts`, `src/index.ts`, `sandbox/toolchain.test.ts`, `packages/core/test/toolchain.test.ts`, `docs/architecture.md`
      **What:** from a tree in the shadow, work out the package manager (and the version `packageManager` pins), the install command a slow path would use, the TypeScript projects to typecheck and the build script — answered per capability, with the repository's `.interlock.json` `toolchain` override replacing detection for each command it sets.

  Read from the object database by tree id through `GitRunner` — `ls-tree -r -l`
  once, then `cat-file blob` — never from disk. It needs no pool slot, so it
  answers for the merge, either side and the merge base alike; and a symlink is a
  blob holding a path, so a `package.json` linked at a key file is refused by its
  mode (`120000`) and never followed, where `fs.readFile` would have read the key.
  A submodule entry is refused the same way.

  The package manager comes from Corepack's `packageManager` first, then the
  lockfile. `pnpm-lock.yaml` is pnpm, `package-lock.json` and
  `npm-shrinkwrap.json` npm, `yarn.lock` Yarn: Berry when `packageManager` names
  major 2 or later, when `.yarnrc.yml` exists, or when `yarn.lock` opens with
  `__metadata:`, asked with `git grep` so a megabyte lockfile is never read into
  memory. Berry is supported only with `nodeLinker: node-modules`; unset, it is
  Plug'n'Play. Install is `pnpm install --frozen-lockfile`, `npm ci`,
  `yarn install --frozen-lockfile` or `yarn install --immutable`; build is
  `<manager> run build` when the root has a `build` script, and `none` when it has
  not.

  Typecheck needs `typescript` among the root's or a workspace package's
  dependencies, and projects: a root `tsconfig.json`, unless it is a solution
  (`"files": []` plus `references`), whose referenced projects are taken instead,
  nested solutions expanded; with no root tsconfig, each workspace package's own.
  Workspace packages come from each manager's own source — `pnpm-workspace.yaml`'s
  `packages:` for pnpm, the `workspaces` field for npm and Yarn — so a package the
  manager would not install is never named. The YAML is read by a small reader
  that takes a block list of plain or quoted scalars, or a one-line flow list,
  and refuses anything richer rather than reading part of it.

  Edge cases and failure modes, each reported as `TOOLCHAIN_UNSUPPORTED` with a
  reason naming what was found: no `package.json` (naming `deno.json` when that
  is what stands in for one); Deno; Bun by lockfile or by `packageManager`;
  `.pnp.cjs`; two managers' lockfiles that `packageManager` does not settle; a
  `packageManager` that disagrees with the only lockfile; neither a lockfile nor
  `packageManager` — never a guess at npm; a malformed or unknown
  `packageManager`; a manifest over the size cap, malformed, not an object, a
  symlink or a submodule; JSONC the reader cannot parse; a reference that leaves
  the tree, names nothing in it, has no path, or nests past eight; a workspace
  tsconfig that is a symlink, which the language service would follow on disk;
  and JavaScript with no tsconfig, or no `typescript` dependency, for typecheck
  alone. A reason never carries a value, key or nested path a file chose.

  **Done when:** each of pnpm, npm, Yarn classic and Yarn Berry with
  `node_modules` linking is detected with its manager, version, typecheck
  projects, build and install command; each unsupported case above answers its
  reason, and JavaScript without a tsconfig still detects its build; a
  solution-style root yields its referenced projects and a monorepo without one
  yields its workspace packages' tsconfigs; detection on a fixture built from this
  repository's own manifests names its five referenced packages; an override of
  one command changes that command alone and each answer says whether it was
  detected or overridden; an oversized `package.json` is refused with no
  `cat-file` run; `__proto__` keys cannot supply a field; JSONC comments and
  trailing commas in `tsconfig.json` parse; a symlinked `package.json` or
  `tsconfig.json` is refused and its target never appears in the answer; and a
  second detection of a tree whose manifests did not change runs one `ls-tree`
  and nothing else.
  **Constraints:** detection never executes anything — no `pnpm --version`, no
  `node -e`, no config file evaluated, here or anywhere. Override commands are
  opaque: validation in `shared` proves they are strings, and here they are
  carried whole, never split or interpreted, to reach execution only through the
  sandbox runner. No new dependency in `core` (hard rule 7), so no YAML parser.
  Workspace globs are matched by scanning, never translated to a regular
  expression, because a pattern is repository content. The cache keys on the
  blob ids of what was read and of every manifest whose mere presence changes
  the answer; keying on the tree id would miss every check, since almost every
  tree is new.

- [ ] **Typecheck runner**
      **Files:** `packages/core/src/analyzers/typecheck.ts`, `packages/core/src/analyzers/typecheck-service.ts`, `packages/core/src/analyzers/typecheck-worker.ts`, `packages/core/src/git/worktree-pool.ts`, `packages/core/package.json`, `packages/daemon/src/scheduler/run-pipeline.ts`, `packages/daemon/src/store/verdict-key.ts`, ADR-0008
      **What:** host the TypeScript language service inside the daemon, one live instance per hot pool slot (ADR-0005), each in a worker thread of its own (ADR-0008). A check of a slot returns structured diagnostics; later checks of the same slot reuse the service's incremental state. Do not spawn `tsc` per check: the measured process floor is 436 ms, against 350 ms of real work for an incremental check. And make the daemon run `ANALYZER_PIPELINE` generically. This task adds no typecheck analyzer to that list: raw diagnostics include every pre-existing error, and reporting them before the baseline differ exists would blow the false-positive budget on day one.

  Rewritten before starting, from the issue. **Diagnostics** are code,
  category, the flattened message, the file relative to the slot, start and
  length, and one-based line and column, as `tsc` prints them. Option and
  global diagnostics — a broken tsconfig, a missing `lib` — are a separate
  list from file diagnostics: they say the project cannot be judged, not that
  the code is wrong, and the baseline differ and infra handling treat them
  differently. A diagnostic in a file outside the slot (a default `lib` file)
  describes the environment and goes with them. **The comparison is `tsc`'s
  own order and gates**: syntax errors stop the semantic check, options and
  global errors stop it too, and declaration diagnostics are reported under
  `--noEmit` only when `declaration` or `composite` is on and nothing else
  was found. **A solution-style tsconfig is checked through its references**,
  depth first, each project once, a cycle tolerated; a reference is read as
  its sources, as an editor reads it, since a slot holds no build output. The
  compiler skips a referenced project's sources' semantic check in the
  programs that import them, so each is judged under its own project's
  options, as `tsc -b` judges it; a file two unrelated projects both list is
  reported under each.

  **Incremental state** is the language service's programs and a semantic
  diagnostics builder per project, the propagation `tsc --incremental` uses.
  A file's version is its inode, size, modification and change times —
  `reset --hard` writes a changed file anew, so a rewrite moves at least one,
  while an unchanged file's stat costs no read — plus an epoch a cold fill
  bumps, since a tree written whole may hold a file whose stat matches the old
  one. A tsconfig is read again on every check, as an added file changes what
  `include` matches, and a reading equal to the last is answered with the last
  one's object: the language service compares a reference's reading by
  identity, and a fresh one rebuilds every program on every check. Declaration
  diagnostics are cached per file and forgotten for each file the builder says
  a change affected; left uncached, they type-check every file on every check.

  **Read confinement** is explicit in the host, never through `ts.sys`. The
  compiler sees one tree: the slot, with `node_modules` in it answered from the
  same path in the dependency checkout. A link in the dependency checkout to a
  path inside it but outside any `node_modules` — a pnpm workspace link —
  resolves back into the slot, so a sibling package is checked as merged, not
  as the user has it. Anything else outside the slot, the dependency
  checkout's `node_modules` and Interlock's own `lib` directory does not exist:
  a `..` or absolute path in `include`, `files`, `paths` or `typeRoots`, a link
  in the slot pointing out of it, a link in `node_modules` pointing out of the
  checkout. Include patterns are expanded by `ts.matchFiles`, over the
  confined listings, so the file set is `tsc`'s.

  **The registry** keeps one service per tree path, at most
  `DEFAULT_LIVE_SERVICES` (the pool size) live, least recently used stopped
  first and a busy one never; one check per service at a time. A service is
  rooted at a path, not at a slot, so a later task can root one at a merge base
  or one side. The pool calls `onEvict` before it removes a slot's files, and
  awaits it; a failing hook is logged and the eviction goes ahead. The pool's
  slot carries how its fill wrote it, for the cold epoch. The daemon stopping
  is `close()`, which stops every worker.

  **Cancellation** crosses threads through one shared `Int32`, polled by the
  compiler's cancellation token, since the check is synchronous and nothing
  posted to the worker is read until it returns. A cancelled check keeps the
  service; the next check is whole.

  **The generic pipeline** runs every entry of `ANALYZER_PIPELINE` in order,
  each with a `run.analyzer-completed` caused by the merge. An analyzer that
  does not apply is `clean`, as a clean merge always was for the textual one.
  The first `infra-failure` fails the run as `analyzer:<name>`; a run
  superseded between analyzers stops there. The run's key is a fingerprint of
  every analyzer's name and version and the tools; each analyzer's verdict is
  cached under its own fingerprint, and a hit needs every analyzer's verdict
  from one run. A pipeline of one analyzer keeps the key it had, so verdicts
  already stored stay valid.

  **Done when:**
  - a slot's diagnostics equal `tsc --noEmit -p` on the same tree, on
    fixtures: a cross-branch call that no longer fits, a syntax error that
    stops the semantic check, a declaration error, a solution of two projects,
    a broken tsconfig; and this repository, checked through its solution
    tsconfig, reports nothing, as `pnpm typecheck` does, and an error a merge
    adds to `shared` is found warm;
  - the same slot checked twice reuses the live service and is faster, with
    cold, warm-unchanged and warm-one-file times recorded in `log.md` on this
    repository and on archestra;
  - evicting a slot stops its service; the number of live services is bounded;
    memory per instance on archestra is recorded, and a service whose heap
    passes its bound is not kept;
  - a superseded run's signal cancels a check in progress through the
    compiler's token, and the service survives it;
  - a plugin in a tsconfig reached through `extends` from `node_modules`, which
    would write a marker file when loaded, never writes it, and `plugins` is
    absent from the resolved options;
  - `include`, `files`, `typeRoots` and `paths` pointing outside the slot, and
    a link in the slot pointing out of it, read nothing: each target is a FIFO,
    which any read would hang on, and a recording file system shows no call
    outside the three roots;
  - a pnpm workspace link resolves into the slot: a fixture whose user copy
    and merged copy of a sibling package differ reports the merged one's error;
  - the longest event-loop stall during a large check is measured both in the
    daemon's thread and in a worker, and the choice recorded in ADR-0008;
  - a stub second analyzer in the pipeline runs, is recorded, is fingerprinted
    — adding it, or bumping its version, is a miss — and the existing run
    pipeline and cache tests pass unchanged.

  **Constraints:** hard rule 2. A plugin is code the host process loads, so
  `plugins` is stripped after the whole `extends` chain is resolved; if plugins
  are ever needed the service moves to a subprocess, never back into the
  daemon. The compiler is Interlock's own pinned `typescript`, never the
  repository's `node_modules` copy, which is files an agent can write. Hard
  rule 7: `typescript` in `core` is ADR-0008. T3: nothing reads outside the
  three roots. Do not add a typecheck analyzer to `ANALYZER_PIPELINE` here;
  when one joins with the baseline differ it needs reconciliation keys for its
  Findings — reconciliation matches textual Findings only — and its toolchain
  fingerprint must name the TypeScript version.

- [x] **Baseline differ**
      **Files:** `packages/core/src/analyzers/baseline.ts`, `analyzers/index.ts`, `analyzers/typecheck-paths.ts` (the compiler's version), `packages/core/test/baseline.test.ts`, `packages/core/test/support/semantic-fixtures.ts`, ADR-0005 (an amendment), `docs/architecture.md`
      **What:** a merged tree is often already broken for reasons that have nothing to do with the merge: `main` has type errors, or one branch is broken on its own. Typecheck four trees of a pair — the merge base, A alone, B alone and the merge — and keep only the diagnostics the merge has and none of the other three has. That set is what the merge caused. Not built here: attributing a diagnostic to a branch (the attribution engine), and an analyzer in `ANALYZER_PIPELINE` (the typecheck analyzer).

  **Where the trees come from.** The pair's slot and its service, cycled:
  each of the merge base, A and B that the cache does not hold is written into
  the slot by `reset --hard` and checked, then the merge. Each step is an
  incremental check proportional to the difference between two trees, not a
  cold one. The slot is back on the merge before the callback returns, on every
  path, including a cancel and a failure. That changes what ADR-0005 says a slot
  holds, so the amendment comes before the code. Every tree is checked from the
  shadow and the pool, never from a user's worktree.

  **Identity.** Line and column move between trees, so they are not part of it.
  A diagnostic is its code, its file, its flattened message with the tree's own
  path taken out, and the text of the span it covers, read from the tree's
  object, never from disk. Files are compared under one name per rename class:
  every rename between the merge base and each of A, B and the merge, found by
  the same rename-detecting diff a ChangeSet is made with, run in the shadow
  over the trees actually checked. The ChangeSet itself is null for a side with
  no worktree, and can describe another snapshot than the one checked.

  **Comparison.** Multisets, per identity: the merge's copies less the most any
  explanation without the merge allows — the base's, A's, B's, or A's and B's
  additions together. Over-explaining only drops a copy, which is the
  direction the false-positive rule wants.

  **Configuration diagnostics** stay apart from file diagnostics. An error in
  the configuration of the base, A or B means that tree cannot be judged. One
  only in the merge is returned as its own list, for the analyzer to report as
  its own rule; it is never folded into the file set.

  **The cache** holds each tree's report by its tree id, the dependency
  checkout's tree, the compiler's version, the project and the comparison's
  version: in memory and bounded, so no migration; a daemon restart pays one
  check per tree again.

  **Done when:**
  - a repository whose `main` already has type errors yields no merge-induced
    diagnostic for a merge that adds none, and a merge-induced error beside
    them is still reported;
  - a diagnostic already in A alone, or in B alone, is not merge-induced, even
    when it moved lines in the merge;
  - the three semantic pairs of `eval/fixtures/semantic.ts`, mirrored in
    core's own test fixtures — a rename against a call to the old name, a
    required parameter against a call without it, a moved export against an
    import from the old module — each yield exactly one merge-induced
    diagnostic, and their twins none;
  - a diagnostic whose line moved because unrelated lines were added above it
    is the same diagnostic;
  - two copies of an error in the merge against one in the base leave one
    merge-induced;
  - a file renamed on one side is compared under its old name in the trees
    that have it;
  - each tree that cannot be checked — deps-dirty, a broken tsconfig in the
    base, a worker crash — makes the whole result unavailable, never "nothing
    merge-induced", and names the tree;
  - checking the pair again with only B changed rechecks B and the merge and
    neither the base nor A, shown by a counter, with the four-tree and B-only
    timings on this repository in `log.md`;
  - a configuration error only in the merge is returned apart from the files.

  **Failure modes:** a pre-existing error reported as new because its identity
  moved — a line number in the key, a path embedding the slot, a rename seen by
  one tree's diff and not another's; a cached report served for a tree checked
  under another dependency tree or compiler; a slot left holding a side after a
  cancel or a failure, so the next delta fill starts from the wrong tree; an
  unavailable tree read as an empty report.

  **Constraints:** the false-positive rule — when the comparison is unsure a
  diagnostic is new, it is not new; missing a real one is the lesser failure.
  Hard rule 1: `test:untouched` keeps passing. Hard rule 2: the compiler stays
  the confined service; nothing here runs repository code. No test of the
  typecheck runner is weakened to make room. No new dependency in `core`.
  `eval/` is read, never imported or edited.

- [ ] **Attribution engine**
      **Files:** `packages/core/src/analyzers/`
      **What:** turn a new diagnostic into a statement about two branches. Intersect the error's location and the symbol it names against each branch's ChangeSet to decide which side removed or renamed the thing and which side referenced it.
      **Done when:** the M3 demo case produces "branch A renamed `processRefund`; branch B added a call to the old name" with both spans, rather than a compiler message with a line number.
      **Constraints:** this is the difference between a useful warning and a compiler dump, and it is the hardest engineering in the milestone. When attribution is ambiguous, report the finding with lower confidence rather than guessing a branch — a wrong accusation costs more agent trust than a vague one. **Rule names and span attribution follow the labels in `eval/fixtures/semantic.ts`,** which were written first and are read-only: the rules are `rename-vs-callsite`, `signature-vs-caller` and `moved-export-vs-import` — never a compiler code such as `TS2554` — and the spans put the branch that changed a declaration on that declaration, and the branch holding the stale reference on the reference. An analyzer that names its findings otherwise scores recall 0 against a set nobody can edit, and looks broken when it is not.

- [ ] **Typecheck analyzer in the pipeline**
      **Files:** `packages/core/src/analyzers/` (the analyzer), `analyzers/index.ts`, `packages/daemon/src/scheduler/run-pipeline.ts`, `eval/` (its floor)
      **What:** the analyzer that combines the baseline differ with the attribution engine and joins `ANALYZER_PIPELINE`: a merge-induced diagnostic becomes a Finding with both spans, a configuration error only in the merge one of its own rule, and an unavailable tree `infra-failure`. Its toolchain fingerprint names the TypeScript version, and its Findings carry reconciliation keys. The daemon constructs the registry and the differ, wires the pool's `onEvict` to `release` and stops both on `close()`.
      **Done when:** the M3 demo case is a Finding in a daemon run, the twins are clean, and its floor is in the fixture suite.
      **Constraints:** adding a floor edits `eval/` and needs a human's approval (hard rule 6) before it is made.

- [ ] **Build analyzer**
      **Files:** `packages/core/src/analyzers/build.ts`
      **What:** the same three steps for the project's build command.
      **Done when:** a merge that typechecks but fails to build produces a Finding with the build output as evidence, redacted.

- [ ] **Infra failure handling**
      **Files:** `packages/core/src/analyzers/analyzer.ts`
      **What:** Docker down, image missing, toolchain unknown, timeout, dependencies unavailable because the lockfile changed.
      **Done when:** each produces `infra-failure` and is never shown to a user as a conflict. An analyzer that cannot run must not report clean.

## Deferred — measure before building

Options considered and not taken, with what would justify them. None is a task:
each stays here until a measurement shows the problem it solves.

- **Copy-on-write slot fills.** Start a pool slot as a filesystem clone of the
  user's checkout (`clonefile` on APFS, `cp --reflink` on btrfs and xfs), then
  `reset --hard` to the merged commit, so only the files that differ are
  written. Saves disk, not time: four slots of a 276 MB checkout drop from
  about 1.1 GB to tens of MB, while a cold fill goes from about 1.6 s to about
  0.2 s — and cold fills are rare, since slots are sticky and updated by delta.
  Costs two code paths, the clone and an ext4 fallback, with CI on ext4 never
  testing the clone; and the clone carries the user's untracked files — build
  output, `.env` — which must be removed or excluded, a new way to run a check
  on a dirty slot or leak a secret into the sandbox. Revisit when the pool's
  disk use is a measured complaint on large repositories.
- **Copy-on-write dependencies.** A clone of `node_modules` per check instead
  of a mount. Gains nothing while the sandbox mounts dependencies read-only,
  which costs no disk either; worth it only if a check needs to write them.
  Credential files are excluded from any copy, as from everything else.
- **Forked VM snapshots for the sandbox.** Snapshot a booted sandbox with
  dependencies installed and the compiler warm, and fork it per check: a start
  in milliseconds, isolation stronger than a container — the residual risk
  threat-model T2 names — and no port clashes. Needs Linux with KVM, so not
  macOS, where the daemon runs; a fit for a hosted mode, not the local one.
