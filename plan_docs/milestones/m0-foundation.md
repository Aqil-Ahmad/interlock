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
      **What:** on a real mid-size TypeScript repo, time `git merge-tree --write-tree`, materialising the merged tree into a scratch directory, and an incremental `tsc` over it. Measure a pair that merges **cleanly** — that is the case that costs money, since a conflicted merge stops at the textual finding.
      **Done when:** the median of ten runs for each step is in `log.md`. The typecheck number is the one that matters: it sets how aggressive the M2 scheduler has to be, and whether continuous checking is affordable at all.

- [ ] **Obtain the AgenticFlict dataset**
      **Files:** `eval/README.md`
      **What:** confirm it exists, get it, document its schema and licence.
      **Done when:** the schema is written down, or the doc states plainly that the dataset could not be obtained and names what is being used instead.
