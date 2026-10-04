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
      **Files:** `packages/core/src/analyzers/typecheck.ts`
      **What:** host the TypeScript LanguageService in-process, one instance per hot pooled pair, rooted at that pair's pool slot (ADR-0005). Return structured diagnostics — code, message, file, span. Do not spawn `tsc` per check: the measured process floor is 436 ms, which would dominate an incremental check costing 350 ms of real work.
      **Done when:** the same slot checked twice reuses the live service and is measurably faster; a service is disposed when its pool slot is evicted; and memory per instance is measured and bounded, because four live compiler instances on a large repository is real RSS.
      **Constraints:** **strip `plugins` from the resolved tsconfig before constructing the service.** TypeScript language-service plugins are loaded and executed by the host process, and the tsconfig here comes from an agent-written merged tree — an `extends` chain reaching into `node_modules` can introduce one. Loading it would execute repository code in the daemon, breaking hard rule 2 in the one place the sandbox does not cover. If plugins are ever genuinely needed, the service moves to a subprocess, not to the daemon. **Wire it through `ANALYZER_PIPELINE`, not beside it:** the daemon's `run-pipeline.ts` names `textualAnalyzer` directly — in the run and in the verdict fingerprint — so a second analyzer means folding that into the list the eval runner already reads, and adding the analyzer's floor to the fixture suite's regression test.

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
