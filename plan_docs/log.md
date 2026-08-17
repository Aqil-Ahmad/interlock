# Log

Short entries: done, decided, blocked. Newest first.

---

## 2026-08-05 (later)

- **Found:** agent-warning test, runs 1–2 of 5. Claude Code (Opus 5) on the archestra codebase, mid-task, given a true warning that a function it calls had been renamed by another session. Both runs **adapted**: verified the claim before acting, fixed import and call site, left the peer's file untouched, then resumed the original task. Run 2 narrated it — "let me verify that rename before changing the call site", then "confirmed, the rename landed in the working tree".
- **Implication:** the core bet has two positive data points. Agents verify before acting, so a false positive costs a file read rather than broken code; and they treat a peer's change as authoritative rather than reverting it, so Interlock only has to inform, not arbitrate.
- **Watch:** in run 2 the agent then moved to "check whether other call sites still reference the old name" — widening from its own file to the whole repository. In a real multi-agent setting that means editing files another branch owns. MCP payloads should scope the expected action to the caller's own work.
- **Caveat:** n=2, one agent, and the rename was visible in the same working tree. Real warnings describe changes in another worktree the agent cannot check. Behaviour on an unverifiable claim is still untested.

- **Measured:** pair cost on archestra (793,784 lines of backend TypeScript, 644 MB of history), git 2.39.3, medians.
  - `git merge-tree --write-tree` on a clean pair: **12.8 ms** (10 runs, 11.7–16.2). The merge is free at real scale — the Atlassian figure holds.
  - Materialising the merged tree into a scratch directory via `git archive | tar`: **1.62 s** (5 runs, 276 MB, 6,605 files). This is 127× the merge and is unavoidable before any semantic check.
  - Typecheck: **not measured on a real repo.** archestra has no `node_modules` installed, so the only available number is interlock itself at 2,781 lines — 1.09 s cold, 0.45 s warm — against a codebase 285× smaller. It says nothing useful about a mid-size project.
- **Implication:** the cost story is not "merge cheap, typecheck expensive". It is "merge free, _materialisation_ significant, typecheck unknown". Extracting the full tree per pair would dominate the budget on its own. M2's scratch worktree should update the previous tree by diff rather than re-extracting from scratch — that turns 1.6 s into roughly the size of the change.
- **Measured:** typecheck decomposition on interlock (2,781 lines, 1,073 dependency `.d.ts`), medians.
  - Floor, `tsc --version`: **436 ms**. Process start and compiler load, fixed regardless of project size.
  - Cold, no build info: **1084 ms** — so 648 ms of actual checking.
  - Warm, nothing changed: **443 ms**, i.e. the floor. Real work ≈ 0.
  - Warm, one file changed: **786 ms** — 350 ms of work. This is Interlock's real case.
- **Implication:** 40% of the small-repo number is fixed startup, which is why extrapolating by line count would have been badly wrong. Cold cost scales with dependency `.d.ts` volume and source size; incremental cost scales with the size of the change and its dependents, not the repository.
- **Estimate, not measured:** a cold `tsc` on a repo the size of archestra is likely 30 s – 3 min, which rules out cold-checking every pair continuously. A one-file incremental there is plausibly 2–10 s, which does not.
- **Design consequence:** continuous semantic checking is viable only if incremental state survives between checks. The scratch worktree must persist `.tsbuildinfo`, and the scheduler should prefer re-checking the same pair over rotating pairs, because every rotation throws away incremental state and pays the cold cost again. This contradicts the single shared scratch worktree recorded earlier today — M2 likely needs sticky per-pair scratch state or a small pool. Resolve before building the scheduler.

- **Decided (ADR-0005):** per-pair worktree pool replaces the single shared scratch worktree decided earlier the same day. Small LRU pool, default 4, entered only after the overlap filter. Each check updates a slot by delta — `merge-tree --write-tree` → `commit-tree` → `reset --hard` — instead of extracting the tree, which turns the measured 1.62 s into the size of the change. `.tsbuildinfo` persists per slot; eviction is expensive and the scheduler must prefer hot pairs over rotating new ones.
- **Decided:** M3 hosts the TypeScript LanguageService in-process, one per hot pair, rooted at its pool slot — justified by the 436 ms spawn floor against 350 ms of real incremental work. **Caveat found while writing it up:** tsconfig `plugins` are loaded and executed by the language-service host, and the tsconfig comes from an agent-written merged tree, so plugins must be stripped from the resolved config or the daemon executes repository code and breaks hard rule 2 in the one place the sandbox does not cover.

- **Verified:** ADR-0005's load-bearing assumption holds. TypeScript keys `.tsbuildinfo` on content, not mtime — rewriting every source file with identical bytes costs 439 ms against 437 ms untouched and 1036 ms cold. A `reset --hard` therefore invalidates only genuinely changed files, which is what makes the pool's delta update worth doing.

- **Verified:** symlinked `node_modules` satisfies `tsc` from a tree at a different path — root and per-package links, clean build, correct emit. ADR-0005's other load-bearing assumption holds. Gotcha found doing it: `pnpm exec tsc` fails in the scratch tree because pnpm verifies dependencies first and tries to `pnpm install` there. The pool must invoke `node_modules/.bin/tsc` directly and never shell through a package manager.

- **Measured (the missing number):** typecheck cost on openselfservice — 85,224 lines of TypeScript across a 39-package turbo monorepo, npm workspaces. Medians.
  - `git merge-tree --write-tree`: **12.1 ms**, against archestra's 12.8 ms on a repo 9× larger. Merge cost is effectively constant — it tracks the diff, not the repository.
  - Materialise merged tree: **590 ms** (58 MB, 2,131 files), against archestra's 1.62 s (276 MB). Scales with tree size, sub-linearly.
  - Full cold build: **88.8 s** (38 of 39 packages; the Next.js app failed on skipped native install scripts).
  - Warm build, nothing changed: **1.85 s** — all cache hits.
  - **Warm build, one file changed in a mid-graph package: 12.28 s.** This is the realistic per-check cost.
  - Raw `tsc` once internal dependencies are built: 0.94 s for a 4.3k-line workspace, 2.31 s for an 11.3k-line one.
- **Found — this changes M3:** in a monorepo you cannot typecheck a merged tree by running `tsc`. Raw `tsc` fails with `TS2307: Cannot find module '@o2s/utils.logger'` because internal workspace packages resolve through their `dist/`, which does not exist until they are built. The semantic check is therefore "build the internal dependency graph, then typecheck" — 12.28 s incrementally, not the 0.94 s the compiler alone suggests. M3's toolchain detection has to discover and run the build orchestrator, not just find the typechecker.
- **Implication:** 12.28 s per check sits comfortably inside the stated 3-minute budget for a typecheck finding, but four hot pooled pairs is roughly 50 s of CPU per round, so pool size and check frequency are now tunable against a real number rather than a guess. Cold is 88.8 s here and would be far worse on a repo the size of archestra, which is the whole argument for the pool.
- **Design consequence:** the pool slot must persist the **build orchestrator's cache** as well as `.tsbuildinfo` — turbo's `.turbo` directory was 54 MB here, and losing it is the difference between 1.85 s and 88.8 s. Add it to ADR-0005's list of state that eviction destroys, and count it in the disk quota.

## 2026-08-05

- **Decided:** merges use `git merge-tree --write-tree` in the shadow object database, not a worktree per pair. Merged trees materialise into one reusable scratch worktree with `node_modules` symlinked from the user's checkout; a `package.json` or lockfile change routes that pair to a slow install path.
- **Decided:** `merge-tree` solves merge cost; the scheduler solves typecheck cost, and typecheck cost is the budget that matters. A semantic conflict is a merge that came out clean, so the merge step never filters those out — overlap does.
- **Decided:** the TypeScript compiler is the semantic detector. M3 gains a baseline differ (report only diagnostics absent from base, A and B alone) and an attribution engine (which branch caused which half). The hand-built rename and signature matchers are dropped.
- **Decided:** M4 becomes overlap pre-filter plus targeted tests. tree-sitter has no symbol table and cannot resolve names across files, so it pre-filters and never detects. Targeted tests stay — the compiler cannot see behavioural conflicts.
- **Decided:** false-positive rate is a tracked metric from M2. When unsure, say nothing.

## 2026-08-04 (later)

- **Done:** deleted the M3+ stub modules and the barrel/`exports` entries pointing at them; dashboard out of the workspace, solution tsconfig and Vitest projects until it declares react/vite; coverage threshold off; Dependabot docker entry removed; CONTRIBUTING and the issue/PR templates dropped.
- **Done:** git repo initialised on `main`. Licensing in place: `LICENSE_AGPL`, `LICENSE.md` router, `CLA.md` and its workflow.
- **Decided:** AGPL-3.0-only plus commercial terms (ADR-0002, accepted). `notImplemented` is for gaps inside a path being built now, not for pre-creating later milestones.
- **Done:** dependencies installed and **`pnpm verify` is green for the first time**. Fixes it took: `@eslint/js` was pinned to a version that does not exist; `@types/node` declared per package and `types: ["node"]` set, since nothing resolved Node globals; `ShadowRepo` imported from its owning module; ULID `bumpRandom` incremented bytes while the encoder reduced mod 32, so every 32nd id went backwards lexicographically — which the event-log replay order depends on; two redundant type assertions and an empty function body.
- **Done:** `tsconfig.check.json` added. Tests, `scripts/` and `eval/` were in no tsconfig, so they were neither typechecked nor type-aware linted; they are both now, and `format:check` joined `pnpm verify` to match CI.
- **Decided:** findings rank by severity, then confidence, then recency — severity no longer multiplies into confidence. A high-severity finding we are unsure of outranks a low-severity one we are certain of, because agents see only a handful of warnings per hour. `findingWeight` still gates the noise budget via `minWeight`.
- **Open:** `CLA.md` and `LICENSE.md` have unfilled entity/contact blanks and need review; CLA workflow needs a signature repo and `CLA_SIGNATURES_TOKEN`. tree-sitter vs the TypeScript compiler API wants an ADR before M4. `node:sqlite` likely closes ADR-0003. Coverage threshold is off until M2.
- **Decided:** `dev` is the integration branch and repository default; `main` is release-only and carries the tags. CI now runs on pushes to both. Recorded in `CONTRIBUTING.md` and `CLAUDE.md`.
- **Decided:** CLA signatures live on a `cla-signatures` branch of this repo rather than a separate one — outside contributors have no write access, so a maintainer merge is still the only way to change the record. Drops the second repo and the PAT.
- **Decided:** no company exists yet, so the CLA Entity is a natural person. `CLA.md` §8 assigns the granted rights to a successor entity, so incorporating later does not mean re-collecting signatures.
- **Next:** create the GitHub repo, push, set `dev` as default, add rulesets for both branches, then reproduce a textual and a semantic conflict by hand for `docs/demo/00-manual-conflict.md`.

## 2026-08-04

- **Done:** monorepo scaffold — workspaces, strict TS with project references, lint with layering rules, Vitest, CI; `shared` models and event vocabulary; event bus; docs set (architecture, evaluation, threat model); ADR-0001…0004.
- **Decided:** monorepo (ADR-0001); SQLite store (ADR-0003); security posture enforced by types and tests (ADR-0004).
- **Open:** license pending IP-policy confirmation (ADR-0002); native SQLite driver choice; AgenticFlict dataset not yet obtained.
- **Next:** install dependencies and get `pnpm verify` green; reproduce a textual and a semantic conflict by hand and write up `docs/demo/00-manual-conflict.md`.
