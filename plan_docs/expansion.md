# INTERLOCK — Expansion & Fallback Roadmap (Plans B, C, D…)

**Purpose:** Interlock's core bet (early conflict detection for parallel agents) could be threatened by (a) incumbents shipping basic conflict warnings, (b) multi-agent workflows growing slower than expected, or (c) the parallel pattern being absorbed into platforms. This document lists expansion features that reuse the same engine so the product survives — and can be _sold_ — even if the core wedge weakens. These are not new projects; each is a feature that becomes a headline product under a different market scenario.

**Strategy in one line:** we are not building "a conflict detector" — we are building a **continuously-verifying integration engine** (watch everything in flight → speculatively combine → execute safely → analyze semantically → attribute → advise). Conflict detection is only the _first_ product that engine powers.

---

## 0. Shared Asset Inventory (why these pivots are cheap)

Everything below reuses assets the core plan (plan.md) already builds:

| Asset                                                  | Built in | Reused by  |
| ------------------------------------------------------ | -------- | ---------- |
| Watcher: live map of branches/worktrees/sessions       | M1       | F3, F4, F6 |
| Session ↔ branch ↔ change attribution + event log      | M1       | F3, F6     |
| Shadow worktrees + speculative merge engine            | M2       | F1, F2, F4 |
| Docker sandbox (build/typecheck/targeted tests)        | M3       | F1, F2     |
| AST/symbol graph + cross-branch matchers               | M4       | F1, F4, F5 |
| MCP server + agent feedback channel                    | M5       | F1, F2, F5 |
| Advisor (ranking, merge-order) + auto-rebase-in-shadow | M7       | F2         |

Rule of thumb: a feature belongs in this file only if ≥60% of it is already built by the core milestones. Anything else is a new project and doesn't belong here.

---

## F1 — Pre-Merge Verification Reports ("Evidence Packs") → PLAN B (primary fallback)

**What:** For every in-flight branch (even with only ONE agent running), Interlock produces a continuously-updated verification report before a PR exists: what changed at the symbol level, whether it builds/typechecks against latest main, which impacted tests pass/fail, diff coverage, risky patterns (test weakening, hardcoded values, swallowed errors), and a risk score. Attached automatically to the PR when opened ("Verified by Interlock" check + human-readable report).

**Why workflows are heading here:** the industry's #1 bottleneck is verification capacity — humans can't review the volume agents produce. Review is shifting from "read all the code" to "audit the evidence." Every agent user has this problem from the first session; it does not require the parallel workflow at all.

**Scenario where it becomes the headline:** multi-agent adoption stalls, but single-agent usage keeps growing (near-certain). TAM is _every_ agent user, not just fleet users.

**Reuses:** sandbox analyzers (M3), AST semantic diff (M4), scheduler — pointed at (branch × main) instead of (branch × branch). New work: report generator, PR integration, risky-pattern detectors.

**Buyer & pricing:** individual devs (per-seat, coding-tool pricing) and teams (required PR check). Sales line: "your agent's PR arrives with proof, not promises."

---

## F2 — Agent-Native Merge Queue ("Landing Orchestrator") → PLAN C

**What:** Graduate the M7 advisor from _suggesting_ order to _executing_ it: a local/team merge queue that lands agent branches one by one — auto-rebase in shadow, re-verify (build/typecheck/impacted tests) against the exact post-rebase state, land if green, notify the owning agent to fix if red. Batching and reordering to minimize total verification time.

**Why workflows are heading here:** when agents produce 10–50 branches/day per team, landing becomes the choke point regardless of whether branches _conflict_ — ordering, freshness, and re-verification are eternal coordination problems (GitHub merge queue exists for exactly this reason, but is textual, CI-bound, server-side, and agent-blind).

**Scenario where it becomes the headline:** conflicts turn out to be rarer than expected (good task decomposition), but branch _volume_ is still high. Coordination revenue survives even in a low-conflict world.

**Reuses:** advisor + auto-rebase + full analyzer pipeline + MCP notify channel. New work: queue state machine, landing policies, failure handoff protocol.

**Buyer & pricing:** teams (per-repo or per-seat). Sales line: "your agents open the PRs; Interlock lands them safely in the right order."

---

## F3 — Provenance & Audit Trail ("Who did what, and why") → PLAN D

**What:** Interlock already knows which session (which tool, model, prompt-context window of time) produced which change on which branch. Productize it: a queryable timeline linking every landed line of code to its originating agent session; "AI-blame" alongside git-blame; incident forensics ("this bug landed in commit X — show me the session, what the agent was told, and what it claimed"); exportable audit reports for compliance (AI-governance policies, EU AI Act-era customer questionnaires, SOC2 evidence).

**Why workflows are heading here:** as AI-written code approaches the majority of changes, organizations are being asked — by regulators, security teams, and their own customers — to answer "which code did AI write, under whose supervision, and how was it reviewed?" Almost nobody can answer today; the event log Interlock keeps _is_ the answer.

**Scenario where it becomes the headline:** enterprises adopt agents but compliance/insurance pressure spikes; detection features commoditize while attribution becomes mandatory. Compliance budgets are the most durable budgets in software.

**Reuses:** session↔branch mapping + append-only event log (M1) + ChangeSets. New work: query UI, git-trailer/commit annotation, report exporter, retention policies.

**Buyer & pricing:** engineering leadership / platform & security teams (team tier). Sales line: "git blame tells you who committed; Interlock tells you which agent, which session, and what it was asked."

---

## F4 — Team Activity Radar ("Semantic presence for codebases") → PLAN E

**What:** Generalize the live branch map beyond agents: a real-time radar of _everything_ in flight across a team — humans and agents alike. Who/what is touching which files and symbols right now, hot-zone heatmaps, "heads-up: Sara's branch is mid-refactor of the module you're about to edit" warnings for humans, and daily digest of overlapping work. Google-Docs-style presence, but at the semantic level of a codebase.

**Why workflows are heading here:** hybrid teams (humans + agents) multiply concurrent activity far beyond what standups and Slack can coordinate. Multi-_human_ concurrent work is eternal — it existed before agents and survives any agent trend. Research on proactive conflict awareness (Palantír, "crystal ball" studies) validated the value years ago; the volume problem finally makes it commercial.

**Scenario where it becomes the headline:** the multi-agent trend itself fades (the user's stated fear). If agents vanish tomorrow, every multi-developer team still collides — same engine, human-only market.

**Reuses:** watcher (M1), heatmap UI (M6), AST symbol overlap (M4) — with agents optional rather than required. New work: multi-machine sync (first genuinely server-side component), privacy controls (opt-in visibility, aggregate-only modes).

**Buyer & pricing:** team tier. Sales line: "know about the collision before the standup, not after the merge."

---

## F5 — Change Intelligence: Breaking-Change & Blast-Radius Detection → PLAN F

**What:** Point the symbol graph at a _single_ change instead of a pair of branches: for any diff, compute its blast radius — which internal/external APIs changed shape, which downstream callers/repos/services are affected, is this change breaking (semver advice for libraries), who owns the affected surface (reviewer routing), and auto-drafted release notes from semantic diffs. Exposed to agents via MCP ("before you change this signature, 14 call sites in 3 packages depend on it") and to humans as a PR annotation.

**Why workflows are heading here:** agents make sweeping changes casually; the expensive failures are downstream breakages nobody predicted. Impact analysis is a decades-old enterprise need (monorepo "affected targets", API-diff tools) that becomes acute when change volume is agent-scale.

**Scenario where it becomes the headline:** conflict detection commoditizes, but per-change risk understanding remains unsolved; also opens the library/platform-team segment (they care about API stability, not parallel agents).

**Reuses:** AST/symbol graph + matchers (M4), ChangeSets, MCP (M5). New work: cross-package dependency resolution, ownership mapping, semver rule engine.

**Buyer & pricing:** platform/library teams; per-repo. Sales line: "every change ships with its blast radius."

---

## F6 — Fleet Analytics: Rework, Waste & ROI Attribution → PLAN G

**What:** The event log already records the full lifecycle of every branch: created → conflicted → reworked → verified → landed/abandoned. Aggregate it into the dashboard engineering leaders are currently begging for: rework rate per model/tool/config, tokens & hours lost to integration failures, conflict cost per module, landed-vs-abandoned ratio per agent setup, and trend lines proving (or disproving) that the AI spend is working.

**Why workflows are heading here:** 2026's budget pressure is brutal — companies blowing AI budgets with no measurable productivity gain, leadership demanding ROI evidence. Nobody can currently attribute _waste_ (duplicated/conflicting/abandoned agent work) because nobody records the integration lifecycle. Interlock does, as a side effect of its core job.

**Scenario where it becomes the headline:** agents are widely used but under CFO scrutiny; measurement outsells prevention. Pairs naturally with F3 (same data, leadership-facing vs compliance-facing).

**Reuses:** event log + session attribution (M1) + Findings history. New work: metrics definitions (reuse docs/evaluation.md rigor), aggregation jobs, exec dashboard/exports.

**Buyer & pricing:** engineering leadership; team/org tier. Sales line: "the first dashboard that shows what your agent fleet wastes, not just what it costs."

---

## F7 — Beyond TypeScript: per-language toolchain adapters

**What:** Semantic detection for Python, Go, Rust or Java. The pipeline already works on any language for textual conflicts; what is missing per language is a toolchain adapter (how to install dependencies, typecheck, build and test) and a diagnostic parser (turn that tool's error output into a Finding with a span).

**Why workflows are heading here:** agents are not a TypeScript phenomenon, and the first serious enterprise conversation will be about a language Interlock does not support.

**Scenario where it becomes the headline:** demand arrives from a language you do not cover, or a competitor ships multi-language first.

**Reuses:** the sandbox (M3), the scheduler and its overlap pre-filter (M2, M4) — tree-sitter grammars already cover dozens of languages — plus the baseline differ, which is language-neutral since it only compares diagnostic sets. New work: one adapter and one diagnostic parser per language; attribution needs per-language symbol resolution, which is the expensive part.

**Buyer & pricing:** unchanged; this removes an objection rather than opening a tier.

**Design consequence today:** keeping tree-sitter as the pre-filter, rather than using the TypeScript compiler for that job too, is what keeps this cheap later.

---

## Scenario → Feature Map (which plan activates when)

| Market scenario (watch quarterly)                     | Signal to watch                                           | Activate                                                             |
| ----------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| Incumbent ships same-file conflict warnings           | Claude Code / Cursor release notes                        | Double down on semantic layer + F1, F2 (they won't build these soon) |
| Multi-agent adoption stalls; single-agent still grows | community surveys, our own telemetry-free user interviews | **F1** becomes the headline product                                  |
| High branch volume, low conflict rate                 | our fixture + design-partner data                         | **F2** (landing orchestration)                                       |
| Enterprise compliance pressure on AI code             | EU AI Act enforcement news, customer questionnaires       | **F3** (+ F6)                                                        |
| Agent trend itself declines                           | usage news, design partners reverting to manual           | **F4** (human-only market)                                           |
| Verification commoditizes, risk insight doesn't       | CodeRabbit/Greptile feature creep                         | **F5**                                                               |
| CFO-driven ROI scrutiny dominates                     | budget-cut news, "prove it" posts                         | **F6**                                                               |

## Sequencing & Discipline

1. Core (M0–M8) ships first. No expansion feature starts before M5 is done — the shared assets must exist.
2. First expansion pick should be **F1**: largest market, highest asset reuse, and it de-risks the "multi-agent stalls" scenario, which is the most likely threat.
3. One expansion feature at a time, chosen by the Scenario Map + design-partner pull, recorded as an ADR ("why F_x now").
4. Each feature must pass the same bar as the core: a measurable claim, an eval protocol in docs/evaluation.md, and a scripted demo in docs/demo/.
5. Revisit this file at every milestone review; delete or demote features whose scenario has expired. A fallback list that never changes is a fallback list nobody is reading.
