# INTERLOCK — Project Plan

**Title:** Interlock: Early Conflict Detection and Integration Intelligence for Parallel AI Coding Agents
**Team:** [names] | **Supervisor:** [name] | **Duration:** ~2 semesters (36–40 weeks)
**Status of this document:** Living plan. Update the STATUS section and milestone checklists as work progresses. This file is the source of truth for scope and direction; CLAUDE.md should point here.

---

## 1. One-Paragraph Summary (context for any new session)

Developers increasingly run multiple AI coding agents (Claude Code, Codex CLI, Cursor) in parallel, each in an isolated git worktree/branch. Conflicts between these parallel streams — both textual merge conflicts and _semantic_ conflicts (changes that merge cleanly but break the build, types, or tests when combined) — are discovered only at merge time, after hours of agent work and tokens are already wasted (~28% of AI-agent PRs hit merge conflicts per the AgenticFlict dataset). Interlock is a local background service that watches all in-flight branches/worktrees, continuously performs speculative merges between them in hidden shadow worktrees, detects textual and semantic conflicts early, feeds warnings back into the agents themselves via MCP, and recommends a merge order that minimizes conflict cascades.

## 2. Goals

1. Detect textual conflicts between any two in-flight branches within ~1 minute of the conflicting edit (not at PR time).
2. Detect semantic conflicts: merged result fails typecheck/build/targeted tests, or AST analysis finds cross-branch breakage (e.g., rename on branch A + new call to old name on branch B).
3. Close the loop: expose findings to agents via an MCP server and to humans via CLI + dashboard, early enough to change behavior mid-task.
4. Recommend an integration (merge/landing) order across N branches that minimizes conflicts.
5. Produce a rigorous evaluation (precision/recall, lead time, overhead) using fixture repos and replayed OSS branch histories.

## 3. Non-Goals for v1 (scope guardrails — do not drift)

- No automatic conflict _resolution_ that writes to user branches. v1 only detects, explains, and suggests. (LLM-drafted resolution patches are a stretch goal, always behind explicit user approval, applied only in shadow worktrees for preview.)
- No team/server/cloud mode. v1 is single-developer, single-machine, local-first.
- No GitHub App / CI integration in v1 (design for it, don't build it).
- Semantic detection targets TypeScript/JavaScript only in v1; the detector is the TypeScript compiler. Other languages get textual conflict detection, which is language-agnostic because git does not parse anything. The sandbox and scheduler are built so a per-language toolchain adapter can be added later, but none is implemented in v1 and no milestone schedules one — see `expansion.md` F7.
- No Windows support in v1. Linux and macOS only.
- Never modify the user's real worktrees, branches, index, or config. All Interlock git operations happen in shadow clones/worktrees under Interlock's own data directory.

## 4. Architecture Overview (components, not implementation)

```
+------------------------------- Developer machine -------------------------------+
|                                                                                  |
|  Agents (Claude Code / Codex / human)      Dashboard (React)      CLI            |
|        |  hooks / MCP                          |  HTTP (localhost)  |            |
|        v                                       v                    v            |
|  +--------------------------------- daemon ---------------------------------+   |
|  |  Watcher -> Event Bus -> Scheduler -> Merge Engine -> Analyzers -> Store  |   |
|  +---------------------------------------------------------------------------+  |
|        |                         |                        |                      |
|   repo worktrees (read-only)  shadow worktrees (rw)   Docker sandbox (build/    |
|                                                        typecheck/test runs)     |
+----------------------------------------------------------------------------------+
```

Component responsibilities:

- **Watcher:** discovers repos, branches, worktrees, and agent sessions; detects changes (filesystem events + git refs + uncommitted diffs). Read-only with respect to user state.
- **Event Bus:** internal typed pub/sub; every component communicates via events (enables replay/debugging and clean tests).
- **Scheduler:** decides which (branch × branch) pairs need re-analysis, with debouncing, prioritization, and incremental invalidation. This is where performance lives.
- **Merge Engine:** performs speculative pairwise merges with `git merge-tree --write-tree` inside a shadow clone's object database — no checkout per pair (including uncommitted changes via temporary commits in shadow only); classifies textual conflicts. Merged trees are materialised into a per-pair worktree pool slot, by delta rather than extraction, only when a semantic check is warranted — see ADR-0005.
- **Analyzers (pluggable pipeline):**
  - `textual` — git merge conflict classification.
  - `typecheck` / `build` — run in Docker sandbox against merged shadow tree.
  - `test-targeted` — select and run tests impacted by the union of both diffs.
  - `prefilter` — tree-sitter overlap test deciding whether a clean merge is worth the compiler at all. Not a detector: it has no symbol table and cannot resolve names across files.
- **Store:** SQLite persistence of all entities + event log.
- **MCP Server:** exposes tools/resources so agents can ask "is my current work colliding?" and receive injected warnings; also receives session metadata from Claude Code hooks.
- **CLI:** `interlock status | watch | check <branchA> <branchB> | order | daemon start/stop`.
- **Dashboard:** localhost React app; live branch map, conflict heatmap, finding details with evidence, recommended merge order.
- **Advisor (later milestone):** merge-order recommendation; optional LLM-generated explanations/suggestions for findings.

## 5. Repository Strategy

**Decision: single monorepo** (`interlock`), pnpm workspaces. Rationale: 2–4 person team, shared TypeScript types across every package, atomic cross-cutting changes, one CI, one issue tracker, and the packages are not independently useful yet. Split later only if a component gains an external life of its own (likely first candidate: `mcp-server`). Record this and any future change as an ADR.

```
interlock/
├── CLAUDE.md                  # agent entrypoint: points to this plan + conventions
├── plan_docs/                # this file, the log, and per-milestone tasks
├── README.md
├── SECURITY.md
├── CONTRIBUTING.md
├── LICENSE                    # Apache-2.0 (decide via ADR-0002)
├── package.json  pnpm-workspace.yaml  tsconfig.base.json  .github/workflows/
├── packages/
│   ├── shared/                # types, data models, config schema, event definitions, logger, error types. No business logic. Every other package depends on it.
│   ├── core/                  # pure domain logic, no long-running processes:
│   │   ├── git/               #   repo discovery, worktree mgmt, shadow ops, diff extraction
│   │   ├── merge/             #   speculative merge engine + textual conflict classifier
│   │   ├── analyzers/         #   analyzer interface + typecheck/build/test/ast implementations
│   │   ├── ast/               #   tree-sitter overlap pre-filter for the scheduler
│   │   ├── sandbox/           #   Docker sandbox runner (no-network, resource-limited)
│   │   └── advisor/           #   merge-order recommendation, finding ranking
│   ├── daemon/                # long-running service: watcher, event bus, scheduler, store (SQLite), localhost HTTP API for CLI/dashboard
│   ├── mcp-server/            # MCP tools/resources; thin adapter over daemon API
│   ├── cli/                   # user-facing commands; talks to daemon API
│   └── dashboard/             # React + Vite (TypeScript); consumes daemon API/WS
├── eval/                      # evaluation harness — kept OUT of packages/ and out of agent edit scope
│   ├── fixtures/              # small synthetic repos with known planted conflicts (golden set)
│   ├── replay/                # scripts to replay concurrent branch histories from OSS repos
│   └── reports/
├── docs/
│   ├── architecture.md        # kept in sync with reality; diagrams as mermaid
│   ├── evaluation.md          # metrics definitions, experiment protocols
│   ├── threat-model.md
│   ├── adr/                   # 0001-monorepo.md, 0002-license.md, 0003-sqlite.md, ...
│   └── demo/                  # scripted demo walkthroughs per milestone
└── scripts/                   # dev setup, fixture generation, release
```

## 6. Core Data Models (names and meaning only; fields evolve in `packages/shared`)

- **Repo** — a watched repository (root path, default branch, config).
- **BranchRef** — an in-flight line of work: branch or worktree, incl. dirty/uncommitted state snapshot id, and owning `AgentSession` if known.
- **AgentSession** — which tool is driving a branch (claude-code | codex | cursor | human), session id, liveness.
- **ChangeSet** — normalized diff of a BranchRef vs merge-base (files, hunks, symbols touched).
- **MergePair** — unordered pair of BranchRefs + merge-base; unit of scheduling.
- **SpeculativeRun** — one execution of merge+analyzers for a MergePair at specific snapshot ids; stores timings and analyzer verdicts.
- **Finding** — a detected problem. `kind: textual | typecheck | build | test | ast-semantic`, severity, status (open/stale/resolved), and **Evidence** (file/line spans on both branches, compiler/test output excerpt, AST symbol trail). Findings must always carry machine-checkable evidence — no vibes.
- **Advice** — actionable guidance derived from findings (warn-agent payloads, suggested merge order, optional LLM explanation).
- **EventRecord** — append-only log of all bus events (drives replay debugging and the thesis's traceability story).

Conventions: ids are ULIDs; all models JSON-serializable; schema migrations from day one (even in SQLite); never store secrets or full file contents of user repos beyond what evidence requires.

---

## 7. Milestones

Each milestone lists: Goal, Key Deliverables, Exit Criteria (demoable), and Risks to watch. Do not start milestone N+1 before N's exit criteria pass, except documentation/eval work which runs continuously. Weeks are approximate; re-baseline in STATUS if needed.

### M0 — Foundation & Research Spike (Weeks 1–3)

**Goal:** Working skeleton + shared understanding of the problem.

- Monorepo scaffold (pnpm workspaces, strict TS, ESLint/Prettier, Vitest, CI running lint+typecheck+tests on every PR).
- `packages/shared` with first-pass models and event definitions.
- ADR-0001 (monorepo), ADR-0002 (license), ADR-0003 (SQLite), ADR-0004 (security posture: shadow-only writes, sandboxed execution).
- Research spike (throwaway code allowed, keep notes in docs/): manually reproduce (a) a textual conflict and (b) one semantic conflict (rename + stale call site) between two worktrees; write the walkthrough in docs/demo/00-manual-conflict.md.
  **Exit criteria:** `pnpm build && pnpm test` green in CI; the two manual conflict walkthroughs are reproducible by any teammate from the doc.
  **Risks:** over-engineering scaffold; cap M0 at 3 weeks hard.

### M1 — Watcher & Git Core (Weeks 4–7)

**Goal:** Interlock can _see_ everything in flight, without touching it.

- Repo/branch/worktree discovery; uncommitted-change snapshots; merge-base computation; ChangeSet extraction.
- Filesystem + git-ref watching with debouncing; typed event bus; SQLite store with migrations; daemon skeleton with localhost HTTP API; `interlock status` CLI.
- Claude Code hook script that registers session ↔ branch mapping with the daemon (best-effort detection when hooks absent).
  **Exit criteria:** with 3 worktrees under active edit, `interlock status` shows live branches, their dirty state, and touched files, updating within seconds; zero writes to user repos (verified by test that hashes user worktree state before/after).
  **Risks:** watcher performance on large repos — measure now, budget: <2% steady-state CPU.

### M2 — Speculative Merge Engine + Textual Detection (Weeks 8–12) ★ first real demo

**Goal:** Early warning for textual conflicts.

- Shadow worktree lifecycle under Interlock data dir; temporary commits of dirty state (shadow only); pairwise speculative merges; textual conflict classification into Findings with file/hunk evidence; staleness handling when branches move.
- Scheduler v1: re-merge only dirty pairs, debounce, prioritize pairs with overlapping touched files.
- CLI `interlock check A B`; findings visible via API.
  **Exit criteria:** scripted demo — two live Claude Code sessions edit the same function; Interlock raises a textual-conflict Finding in <60s while both sessions are still running; suite of fixture-repo tests for merge/conflict cases passes.
  **Risks:** disk usage of shadow worktrees (use worktrees off a single shadow clone, share object store); correctness of dirty-state snapshotting.

### M3 — Semantic Detection v1: Build & Typecheck (Weeks 13–17)

**Goal:** Catch "merges cleanly but breaks" — the headline capability.

- Docker sandbox runner: no network, CPU/mem/time limits, mounts merged shadow tree read-only + writable overlay; project toolchain detection (tsconfig/package.json) with per-repo config override.
- typecheck/build analyzers producing Findings with compiler-output evidence mapped back to the originating branches (which side introduced which half of the breakage).
- Result caching keyed by (snapshotA, snapshotB, analyzer, toolchain).
  **Exit criteria:** demo — branch A renames an exported function, branch B adds a call to the old name; both branches build green alone; Interlock flags the pair with a typecheck Finding and correct dual-branch attribution in <3 min; false-positive rate on non-conflicting fixture pairs = 0.
  **Risks:** toolchain diversity — support pnpm/npm/yarn TS projects first, document limits honestly.

### M4 — Semantic Detection v2: AST Cross-Branch Analysis + Targeted Tests (Weeks 18–21)

**Goal:** Faster, cheaper semantic signals + deeper explanations.

- tree-sitter overlap pre-filter: did either branch touch an exported declaration, and do the touched symbols intersect? Used by the scheduler to skip typechecks, never to raise a Finding.
- Test-impact selection: run only tests touching files/symbols in the union diff, inside the sandbox; flaky-test quarantine list.
- Finding ranking (severity × confidence) in `core/advisor`.
  **Exit criteria:** AST analyzer flags the M3 demo case in <10s without invoking the compiler; measured on the fixture golden set: AST-layer precision ≥0.9, and combined analyzers' recall reported (target ≥0.8) with every false positive triaged into an issue.
  **Risks:** AST matcher precision — prefer high-precision/lower-recall rules; the sandbox analyzers remain the safety net.

### M5 — Closing the Loop: MCP Server & Agent Feedback (Weeks 22–25)

**Goal:** Agents adapt mid-task instead of colliding blindly.

- MCP server (localhost, token-auth) with tools such as: `get_conflicts_for_my_branch`, `check_file_overlap(paths)`, `get_pending_changes(path)` (peer-branch diff summaries), `propose_merge_order`.
- Claude Code integration recipe: hooks + CLAUDE.md snippet so sessions consult Interlock before large edits and receive warning injections when a Finding involves their branch.
- Advisory payloads designed for LLM consumption (short, evidence-linked, action-oriented).
  **Exit criteria:** recorded A/B demo — same two-agent collision scenario run with and without Interlock MCP enabled; with Interlock, at least one agent visibly adjusts (acknowledges peer change / edits different location / coordinates), and the session transcripts are archived as evaluation artifacts.
  **Risks:** prompt-injection surface and noise — see SECURITY; warnings must be rare, high-precision, and rate-limited or agents/users will ignore them.

### M6 — Dashboard & CLI Polish (Weeks 26–29)

**Goal:** The thing people can see — for demos, supervisor, and the defense.

- React dashboard: live branch map, pairwise conflict heatmap, Finding detail view (evidence, both diffs, analyzer output), event timeline, recommended order view; websocket updates.
- CLI parity for all read paths; `interlock daemon` UX (install, autostart, logs).
- Onboarding: `interlock init` sets up a repo in <2 minutes, including hook installation.
  **Exit criteria:** a stranger (supervisor) follows README quickstart on a fresh machine and reaches the live heatmap in ≤10 minutes; UI updates <1s after a Finding.
  **Risks:** UI scope creep — dashboard is secondary to the daemon; timebox hard.

### M7 — Integration Advisor (Weeks 30–33, stretch-but-planned)

**Goal:** From detection to guidance.

- Merge-order recommendation: model pairwise conflict graph, propose landing order minimizing expected conflicts/rework; auto-rebase simulation in shadow (never on user branches) to validate the proposed order; optional LLM-generated human-readable explanation per Finding and, behind approval, a draft resolution patch previewed in shadow.
  **Exit criteria:** on replayed 3–5-branch scenarios, following Interlock's recommended order yields measurably fewer conflict-hunks/failed merges than naive FIFO order (report the numbers); any LLM feature is off by default and clearly labeled.
  **Risks:** this is research-flavored — if behind schedule, ship order-recommendation only and move LLM resolution to Future Work.

### M8 — Evaluation, Hardening & Thesis (Weeks 34–40)

**Goal:** Numbers that survive a defense.

- Execute evaluation.md protocols (below): golden fixture set, replayed OSS histories; overhead benchmarks; ablations (textual-only vs +typecheck vs +AST vs full).
- Bug-fix freeze weeks; docs completeness pass; demo video; thesis writing (architecture, methodology, results, threats to validity, future work).
  **Exit criteria:** all headline metrics reported with methodology; reproducible eval (`pnpm eval` regenerates reports); thesis draft complete.

---

## 8. Evaluation Plan (summary — full protocols live in docs/evaluation.md)

**Datasets:** (1) synthetic fixture repos with planted conflicts (golden labels), (2) replayed concurrent branch histories from 3–5 real OSS TypeScript repos (label by whether real merge/CI broke).
**Primary metrics:** detection precision & recall per analyzer and combined; **lead time** (minutes between conflict introduction and Finding vs merge-time discovery baseline); false-positive rate per day of normal non-conflicting work (target: <1/day); daemon overhead (CPU %, RAM, disk) and time-to-verdict per pair.
**Baselines:** git merge at integration time (status quo); `git merge --no-commit` dry-run at PR time; optionally GitHub conflict indicator.
**Discipline:** metrics definitions frozen before M8; eval code and datasets are read-only to coding agents; every reported number regenerable by one command.

## 9. Documentation Requirements (maintained continuously, checked at each milestone)

- **README.md** — what/why, 10-minute quickstart, architecture diagram, demo GIF, honest limitations.
- **docs/architecture.md** — components, data flow, lifecycle of a Finding; update in the same PR as any structural change.
- **docs/adr/** — every irreversible decision (repo strategy, license, storage, sandbox tech, MCP design, metric definitions). Short template: Context / Decision / Consequences.
- **docs/evaluation.md**, **docs/threat-model.md**, **SECURITY.md**, **CONTRIBUTING.md** (setup, conventions, review rules), **CHANGELOG.md** (keep-a-changelog style).
- **Code documentation:** TSDoc on all exported APIs of `shared` and `core`; each package has a README stating its responsibility and what it must NOT do; complex logic (scheduler, matchers) gets a `notes.md` explaining the algorithm in prose.
- **docs/demo/** — one scripted, reproducible demo per milestone (these become the defense).
- **Weekly log.md** — 5 lines/week: done, decided, blocked. This is thesis gold and supervisor-meeting fuel.

## 10. Security & Safety Practices (non-negotiable; enforce via tests and review)

1. **Shadow-only writes.** Interlock never mutates user worktrees, branches, index, stash, or git config. CI includes a test asserting user-repo state hashes are unchanged across full Interlock runs.
2. **Sandboxed execution.** Speculatively-merged code is untrusted (agents write it). All builds/typechecks/tests run in Docker: no network, non-root, CPU/mem/time limits, read-only mounts + tmpfs overlay. Never execute merged code on the host.
3. **Secrets hygiene.** Never read/store .env or credential files; redact obvious secret patterns from stored evidence and logs; SQLite lives under the user data dir with 0700 perms.
4. **Local-only services.** Daemon HTTP/WS and MCP server bind 127.0.0.1 only, with a generated bearer token; no telemetry; document any future opt-in analytics in an ADR first.
5. **Prompt-injection awareness.** Content flowing to agents (peer diffs, advice) is data, not instructions: wrap in clearly-delimited blocks, strip/escape instruction-like patterns, keep payloads minimal; document residual risk in threat-model.md. Same caution for any LLM-explanation feature reading repo content.
6. **Supply chain.** pnpm lockfile committed; dependabot/audit in CI; pin Docker base images; minimal dependency policy for `core` (prefer zero-dep).
7. **Resource safety.** Disk quota + GC policy for shadow worktrees and caches; kill-switch (`interlock daemon stop --purge`).

## 11. Engineering Conventions

- TypeScript strict mode everywhere; no `any` in `shared`/`core` public APIs.
- Testing pyramid: unit tests for matchers/classifiers (fixture-driven), integration tests spinning real git repos in temp dirs, small e2e suite driving daemon+CLI. Coverage gate on `core` ≥80% lines; every bug fix lands with a regression test.
- Conventional Commits; PR-based flow even within the team; CI must pass to merge; `main` always demoable.
- Errors are typed and actionable; logs are structured (JSON) with levels; every Finding traceable to the EventRecords that produced it.
- Performance budgets tracked from M2 in a simple benchmark script (`pnpm bench`), run in CI weekly.
- Dogfooding: from M5 onward, develop Interlock while running Interlock on this monorepo; file every false positive as an issue.

## 12. Working Agreement for Claude Code (Opus 4.8) Sessions

- CLAUDE.md points to this file; read §1–§6 + the current milestone before coding. One session = one milestone-scoped task; keep diffs small and reviewed by a human teammate.
- Definition of Done for any task: code + tests + docs touched together; `pnpm lint && pnpm build && pnpm test` green; relevant milestone checklist item ticked in this file; CHANGELOG entry if user-visible.
- Agents must not: edit `eval/` datasets or metric definitions, weaken/delete failing tests to pass, add dependencies to `core` without an ADR note, or change security posture (§10) — flag for human decision instead.
- When something in this plan proves wrong in practice, do not silently diverge: propose the change, record it (ADR or STATUS note), then implement.

## 13. Risk Register (review monthly)

| Risk                                              | Likelihood | Impact | Mitigation                                                                                                  |
| ------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| Speculative merge cost explodes with N branches   | M          | H      | pairwise scheduling on touched-file overlap first; caching; budget & bench from M2                          |
| False positives erode trust                       | M          | H      | precision-first matchers; sandbox verdicts as ground truth; FP metric tracked weekly                        |
| Toolchain diversity (builds fail for env reasons) | H          | M      | narrow v1 to TS/JS + documented toolchains; per-repo config; classify "infra-fail" separately from Findings |
| Anthropic/Cursor ship basic same-file warnings    | M          | M      | our moat is semantic layer + cross-tool + order advisor; keep those front and center                        |
| Team bandwidth / course load                      | H          | M      | milestones sized for ~15 h/wk/person; M7 explicitly droppable                                               |

## 14. STATUS (update weekly)

- **Current milestone:** M0
- **Week:** 1
- **Done last week:** —
- **Next:** scaffold repo, ADR-0001..0004, manual conflict walkthrough
- **Blocked:** —
- **Re-baselines / decisions:** —
