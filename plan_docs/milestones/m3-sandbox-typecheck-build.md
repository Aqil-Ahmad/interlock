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

- [ ] **Typecheck runner**
      **Files:** `packages/core/src/analyzers/typecheck.ts`
      **What:** run the TypeScript compiler over a tree and return structured diagnostics — code, message, file, span. Use the compiler API with incremental reuse rather than shelling out and parsing text.
      **Done when:** the same tree checked twice reuses prior state and is measurably faster the second time.

- [ ] **Baseline differ**
      **Files:** `packages/core/src/analyzers/`
      **What:** a merged tree may already be broken for reasons that have nothing to do with the merge. Check the merge-base, branch A alone, branch B alone and the merged tree, then report only diagnostics present in the merge and absent from all three.
      **Done when:** a repository whose `main` already has type errors produces zero findings for a merge that introduces none, and a genuinely merge-induced error is still reported.
      **Constraints:** without this every finding is polluted by pre-existing noise, and the false-positive budget is blown on day one. Four compiler runs per pair is also four times the cost, so cache aggressively — A and B alone change only when their own snapshots change.

- [ ] **Attribution engine**
      **Files:** `packages/core/src/analyzers/`
      **What:** turn a new diagnostic into a statement about two branches. Intersect the error's location and the symbol it names against each branch's ChangeSet to decide which side removed or renamed the thing and which side referenced it.
      **Done when:** the M3 demo case produces "branch A renamed `processRefund`; branch B added a call to the old name" with both spans, rather than a compiler message with a line number.
      **Constraints:** this is the difference between a useful warning and a compiler dump, and it is the hardest engineering in the milestone. When attribution is ambiguous, report the finding with lower confidence rather than guessing a branch — a wrong accusation costs more agent trust than a vague one.

- [ ] **Build analyzer**
      **Files:** `packages/core/src/analyzers/build.ts`
      **What:** the same three steps for the project's build command.
      **Done when:** a merge that typechecks but fails to build produces a Finding with the build output as evidence, redacted.

- [ ] **Infra failure handling**
      **Files:** `packages/core/src/analyzers/analyzer.ts`
      **What:** Docker down, image missing, toolchain unknown, timeout, dependencies unavailable because the lockfile changed.
      **Done when:** each produces `infra-failure` and is never shown to a user as a conflict. An analyzer that cannot run must not report clean.
