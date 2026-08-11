# M3 — Sandbox, typecheck and build

**Goal:** Catch "merges cleanly but breaks". The headline capability.

**Exit criteria:** branch A renames an exported function, branch B adds a call
to the old name; both build green alone; Interlock flags the pair with a
typecheck Finding and correct dual-branch attribution in under 3 minutes, with
zero false positives on the non-conflicting fixture pairs.

**Depends on:** M2.

## Tasks

- [ ] **Expand this milestone before starting it**
      **Files:** this file
      **What:** the tasks below are one line each. Rewrite them to the depth of `m1-watcher-and-git-core.md` — per-task edge cases, failure modes, the tests each needs, and the constraints it can breach by accident.
      **Done when:** every task below carries a `Done when` naming an observable check, and nothing in it contradicts what earlier milestones learned.

- [ ] **Docker sandbox runner**
      **Files:** `packages/core/src/sandbox/` (create in this milestone, not before)
      **What:** run a command against the merged shadow tree in a container.
      **Done when:** the container has no network, runs non-root, drops capabilities, mounts the tree read-only with a writable tmpfs overlay, and is killed at CPU, memory, PID and wall-clock limits.
      **Constraints:** merged code is agent-written and unreviewed. It never executes on the host, in any code path, including tests.

- [ ] **Toolchain detection**
      **Files:** `packages/core/src/sandbox/toolchain.ts`
      **What:** identify the project's package manager and typechecker from `package.json` and `tsconfig.json`, with a per-repo config override.
      **Done when:** pnpm, npm and yarn TypeScript projects are detected, and anything else reports `TOOLCHAIN_UNSUPPORTED` rather than guessing.

- [ ] **Typecheck analyzer**
      **Files:** `packages/core/src/analyzers/typecheck.ts`
      **What:** run the project's typechecker on the merged tree and map each diagnostic back to the branch that introduced its half of the breakage.
      **Done when:** the Finding says "your rename broke a call site branch B added", not "TS2304". The attribution is what makes it actionable and is the hard part of this task.

- [ ] **Build analyzer**
      **Files:** `packages/core/src/analyzers/build.ts`
      **What:** the same, for the project's build command.
      **Done when:** a merge that typechecks but fails to build produces a Finding with the build output as evidence, redacted.

- [ ] **Infra failure handling**
      **Files:** `packages/core/src/analyzers/analyzer.ts`
      **What:** Docker down, image missing, toolchain unknown, timeout.
      **Done when:** each produces `infra-failure` and is never shown to a user as a conflict. An analyzer that cannot run must not report clean.
