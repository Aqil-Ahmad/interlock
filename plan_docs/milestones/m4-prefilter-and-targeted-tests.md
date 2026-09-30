# M4 — Overlap pre-filter and targeted tests

**Goal:** Make the scheduler cheap to be right, and catch what the compiler
cannot see.

**Exit criteria:** on the golden fixture set, the pre-filter removes a reported
proportion of clean merges from typecheck consideration while missing none of
the labelled semantic conflicts; and the targeted-test analyzer catches at least
one behavioural conflict that typechecks perfectly.

**Depends on:** M3.

This milestone used to own semantic detection through hand-built AST matchers.
It does not any more — the compiler does that job in M3, and a matcher that
re-derives "renamed symbol versus stale call site" would be a worse copy of a
type checker. Two things survive, and they are the two the compiler cannot do.

## Tasks

- [ ] **Expand this milestone before starting it**
      **Files:** this file
      **What:** the tasks below are one line each. Rewrite them to the depth of `m1-watcher-and-git-core.md` — per-task edge cases, failure modes, the tests each needs, and the constraints it can breach by accident.
      **Done when:** every task below carries a `Done when` naming an observable check, and nothing in it contradicts what earlier milestones learned.

- [ ] **Record the parser decision**
      **Files:** `plan_docs/decisions/`
      **What:** the TypeScript compiler API is the semantic detector; tree-sitter is a pre-filter only. tree-sitter parses one file at a time and has no symbol table, so it cannot tell that `processRefund` in one file is the declaration referenced from another — which is exactly what every detection case needs. It is fast, incremental and tolerant of unparseable files, which is exactly what a pre-filter needs.
      **Done when:** an ADR states the split, what it costs (TypeScript and JavaScript only), and what would reverse it.

- [ ] **Decide what catches the two `ast-semantic` cases**
      **Files:** `plan_docs/decisions/`, `plan_docs/evaluation.md`, `eval/fixtures/semantic.ts` (only if the decision relabels)
      **What:** the golden set labels `same-symbol-dual-edit` and `duplicate-implementation` for an `ast-semantic` analyzer, and this milestone plans none: the AST layer is a pre-filter, and a hand-built matcher is what this milestone was rewritten away from. Both cases compile, so the compiler cannot catch them either. Settle which analyzer each belongs to, or that none does, and make the labels, the metrics and this milestone agree.

  The two cases are different. `same-symbol-dual-edit` — both branches change
  one function in lines that merge cleanly — is a behavioural conflict, and this
  milestone's exit criterion already gives those to the targeted-test analyzer.
  Labelled `ast-semantic`, with no test in the fixture, that analyzer can never
  be scored on it. `duplicate-implementation` — both branches add the same
  helper under different names — breaks nothing: no compiler, test or build
  fails, so no analyzer in this architecture reports it, and a detector for it
  would be exactly the similarity matcher the design rejects.

  Options: **(a)** relabel `same-symbol-dual-edit` for the targeted-test
  analyzer, with a test in the fixture that passes on each branch and fails on
  the merge, and record `duplicate-implementation` as out of scope, kept as a
  labelled case the report shows as not detected by design; **(b)** plan an AST
  detector for both, which contradicts the pre-filter design and needs its own
  ADR; **(c)** drop both from the set. (a) keeps the design and gives the test
  analyzer the case it exists for.

  **Done when:** an ADR records the decision; each case's label names the
  analyzer that is meant to catch it, or says none is; `plan_docs/evaluation.md`
  replaces "AST-layer precision ≥ 0.9" with a target for what the AST layer is —
  a pre-filter: none of the labelled semantic conflicts filtered out, and its
  escalation rate reported — and its ablation row matches; and the
  pre-filter's constraint below no longer calls this open.
  **Constraints:** `eval/` is read-only to coding sessions, so relabelling is a
  change the owner approves in the ADR, not one a session makes to move a
  number. Decide before the targeted-test analyzer is built, since its fixture
  is part of the answer, and before M8 freezes the metric definitions.

- [ ] **Overlap pre-filter**
      **Files:** `packages/core/src/ast/` (create in this milestone), consumed by `packages/daemon/src/scheduler/`
      **What:** answer two cheap questions about a clean merge, so the scheduler can skip the compiler. Did either branch touch an exported declaration at all? Do the symbols the two branches touched intersect?
      **Done when:** it answers in milliseconds per changed file, and on the golden set it never filters out a pair that the typecheck analyzer would have flagged.
      **Constraints:** a false negative here is invisible — the conflict is simply never looked for. Bias the filter toward letting pairs through: when it cannot parse a file, or cannot tell, the pair escalates. Report the escalation rate so the filter's value is measurable rather than assumed. The golden set labels two cases for `ast-semantic` — `same-symbol-dual-edit` and `duplicate-implementation`, in `eval/fixtures/semantic.ts` — which compile, so the compiler cannot catch them, and which this milestone, with the AST layer a pre-filter, plans no detector for. They report recall 0 until one exists. Whether one should is the task above. Any detector for them names its rules and places its spans as those labels do.

- [ ] **Targeted test analyzer**
      **Files:** `packages/core/src/analyzers/test-targeted.ts`
      **What:** run only the tests reaching the union of both diffs, inside the sandbox, with a flaky-test quarantine list.
      **Done when:** a merged tree runs a small subset of the suite and still catches a planted behavioural conflict — two changes that compile perfectly together and do the wrong thing.
      **Constraints:** this is the only analyzer that can see behavioural conflicts, and the literature puts that category at a meaningful share of merge scenarios. It stays in the pipeline even though it is the slowest thing here.

- [ ] **Ranking**
      **Files:** `packages/core/src/advisor/ranking.ts`
      **What:** already implemented — severity, then confidence, then recency, with `findingWeight` gating the noise budget.
      **Done when:** confirmed against real findings rather than fixtures, and adjusted if the ordering reads wrong in practice.
