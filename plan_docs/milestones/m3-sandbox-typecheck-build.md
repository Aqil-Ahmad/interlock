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

- [ ] **Docker sandbox runner**
      **Files:** `packages/core/src/sandbox/` (create in this milestone, not before)
      **What:** run a command against a materialised merged tree in a container.
      **Done when:** the container has no network, runs non-root, drops capabilities, mounts the tree read-only with a writable tmpfs overlay, and is killed at CPU, memory, PID and wall-clock limits.
      **Constraints:** merged code is agent-written and unreviewed. It never executes on the host, in any code path, including tests.

- [ ] **Toolchain detection**
      **Files:** `packages/core/src/sandbox/toolchain.ts`
      **What:** identify the project's package manager and typechecker from `package.json` and `tsconfig.json`, with a per-repo config override.
      **Done when:** pnpm, npm and yarn TypeScript projects are detected, and anything else reports `TOOLCHAIN_UNSUPPORTED` rather than guessing.
      **Constraints:** the override's commands come from `.interlock.json`, which is repository content — a command string chosen by whoever writes the repository. Validation there proves it is a string and nothing more. It runs in the sandbox or it does not run.

- [ ] **Typecheck runner**
      **Files:** `packages/core/src/analyzers/typecheck.ts`, `packages/core/src/analyzers/typecheck-service.ts`, `packages/core/src/analyzers/typecheck-worker.ts`, `packages/core/src/git/worktree-pool.ts`, `packages/core/package.json`, `packages/daemon/src/scheduler/run-pipeline.ts`, `packages/daemon/src/store/verdict-key.ts`, ADR-0007
      **What:** host the TypeScript language service inside the daemon, one live instance per hot pool slot (ADR-0005), each in a worker thread of its own (ADR-0007). A check of a slot returns structured diagnostics; later checks of the same slot reuse the service's incremental state. Do not spawn `tsc` per check: the measured process floor is 436 ms, against 350 ms of real work for an incremental check. And make the daemon run `ANALYZER_PIPELINE` generically. This task adds no typecheck analyzer to that list: raw diagnostics include every pre-existing error, and reporting them before the baseline differ exists would blow the false-positive budget on day one.

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
  its sources, as an editor reads it, since a slot holds no build output; and
  a file listed by a project is reported once, from that project, as `tsc -b`
  reports it.

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
    daemon's thread and in a worker, and the choice recorded in ADR-0007;
  - a stub second analyzer in the pipeline runs, is recorded, is fingerprinted
    — adding it, or bumping its version, is a miss — and the existing run
    pipeline and cache tests pass unchanged.

  **Constraints:** hard rule 2. A plugin is code the host process loads, so
  `plugins` is stripped after the whole `extends` chain is resolved; if plugins
  are ever needed the service moves to a subprocess, never back into the
  daemon. The compiler is Interlock's own pinned `typescript`, never the
  repository's `node_modules` copy, which is files an agent can write. Hard
  rule 7: `typescript` in `core` is ADR-0007. T3: nothing reads outside the
  three roots. Do not add a typecheck analyzer to `ANALYZER_PIPELINE` here;
  when one joins with the baseline differ it needs reconciliation keys for its
  Findings — reconciliation matches textual Findings only — and its toolchain
  fingerprint must name the TypeScript version.

- [ ] **Baseline differ**
      **Files:** `packages/core/src/analyzers/`
      **What:** a merged tree may already be broken for reasons that have nothing to do with the merge. Check the merge-base, branch A alone, branch B alone and the merged tree, then report only diagnostics present in the merge and absent from all three.
      **Done when:** a repository whose `main` already has type errors produces zero findings for a merge that introduces none, and a genuinely merge-induced error is still reported.
      **Constraints:** without this every finding is polluted by pre-existing noise, and the false-positive budget is blown on day one. Four compiler runs per pair is also four times the cost, so cache aggressively — A and B alone change only when their own snapshots change.

- [ ] **Attribution engine**
      **Files:** `packages/core/src/analyzers/`
      **What:** turn a new diagnostic into a statement about two branches. Intersect the error's location and the symbol it names against each branch's ChangeSet to decide which side removed or renamed the thing and which side referenced it.
      **Done when:** the M3 demo case produces "branch A renamed `processRefund`; branch B added a call to the old name" with both spans, rather than a compiler message with a line number.
      **Constraints:** this is the difference between a useful warning and a compiler dump, and it is the hardest engineering in the milestone. When attribution is ambiguous, report the finding with lower confidence rather than guessing a branch — a wrong accusation costs more agent trust than a vague one. **Rule names and span attribution follow the labels in `eval/fixtures/semantic.ts`,** which were written first and are read-only: the rules are `rename-vs-callsite`, `signature-vs-caller` and `moved-export-vs-import` — never a compiler code such as `TS2554` — and the spans put the branch that changed a declaration on that declaration, and the branch holding the stale reference on the reference. An analyzer that names its findings otherwise scores recall 0 against a set nobody can edit, and looks broken when it is not.

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
