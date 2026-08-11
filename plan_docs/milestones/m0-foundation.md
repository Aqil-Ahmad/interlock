# M0 — Foundation

**Goal:** Working skeleton, and a first-hand understanding of the problem.

**Exit criteria:** `pnpm verify` green in CI, and both manual conflict
walkthroughs reproducible by someone else from the doc alone.

## Tasks

- [x] **Monorepo scaffold**
      **Files:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.*.json`, `eslint.config.js`, `vitest.config.ts`
      **What:** pnpm workspaces, strict TypeScript with project references, type-aware ESLint carrying the layering rules, Prettier, Vitest.
      **Done when:** `pnpm verify` passes from a clean clone with no prior build output.

- [x] **`shared` models and event vocabulary**
      **Files:** `packages/shared/src/models/`, `packages/shared/src/events/`
      **What:** Repo, BranchRef, AgentSession, ChangeSet, MergePair, SpeculativeRun, Finding, Advice, EventRecord, plus the event type union.
      **Done when:** every model is JSON-serializable and `shared` imports no sibling package.

- [x] **Event bus**
      **Files:** `packages/daemon/src/bus/`
      **What:** typed pub/sub carrying `causedBy`, so any Finding can be walked back to the edit that caused it.
      **Done when:** publishing an event with a cause produces a chain a test can follow end to end.

- [x] **CI**
      **Files:** `.github/workflows/ci.yml`
      **What:** build, lint, format, typecheck, test on Node 24 and 26, Linux and macOS.
      **Done when:** green on a pull request from a fresh checkout.

- [x] **ADR-0001…0004**
      **Files:** `plan_docs/decisions/`
      **What:** monorepo, licence, SQLite store, security posture.
      **Done when:** each is `accepted` and its consequences are written, not just its decision.

- [ ] **Research spike: reproduce a textual conflict by hand**
      **Files:** `plan_docs/demo/00-manual-conflict.md`
      **What:** two worktrees, same function edited both sides, merged manually. Record every command and its output.
      **Done when:** someone else follows the doc on a clean machine and gets the same conflict.

- [ ] **Research spike: reproduce a semantic conflict by hand**
      **Files:** `plan_docs/demo/00-manual-conflict.md`
      **What:** branch A renames an exported function and fixes its call sites; branch B adds a call to the old name. Both branches typecheck alone. Show the merge is clean and the merged tree fails.
      **Done when:** the failure is reproducible from the doc, and the typecheck error output is captured verbatim — that output is what M3 has to parse and attribute.

- [ ] **Measure what a single pair actually costs**
      **Files:** `plan_docs/log.md`
      **What:** on a real mid-size TypeScript repo, time `git merge-tree --write-tree` against a worktree checkout plus merge, and time an incremental `tsc` on the merged tree.
      **Done when:** four numbers are in `log.md`. This decides whether the scheduler in M2 is a small problem or the whole project — ten pairs at 90 seconds does not fit any laptop CPU budget.

- [ ] **Obtain the AgenticFlict dataset**
      **Files:** `eval/README.md`
      **What:** confirm it exists, get it, document its schema and licence.
      **Done when:** the schema is written down, or the doc states plainly that the dataset could not be obtained and names what is being used instead.
