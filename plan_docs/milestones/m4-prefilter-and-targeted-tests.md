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

- [x] **Decide what catches the two `ast-semantic` cases**
      **Files:** `plan_docs/decisions/`, `plan_docs/evaluation.md`, `eval/fixtures/semantic.ts`
      **What:** the golden set labelled `same-symbol-dual-edit` and `duplicate-implementation` for an `ast-semantic` analyzer no milestone plans. Settle which analyzer each belongs to, or that none does, and make the labels, the metrics and this milestone agree.

  Decided in ADR-0006, approved by the owner before the set merged. The dual
  edit is a behavioural conflict, relabelled for the targeted tests under
  `merge-breaks-test`: its fixture's branches fix one function in
  contradictory ways, each with a test that passes on its branch, and only the
  merge fails one — checked by building the fixture and running `node --test`
  on each branch and on the merge. The first version was two edits that were
  correct together, which only a "both touched one function" matcher would have
  flagged. A new twin makes two compatible edits to the same function whose
  tests pass merged. The duplicate implementation breaks nothing any analyzer
  here can see; it is kept with `notDetected` and its reason, reported apart.
  `evaluation.md` measures the AST layer as a pre-filter.

- [ ] **Overlap pre-filter**
      **Files:** `packages/core/src/ast/` (create in this milestone), consumed by `packages/daemon/src/scheduler/`
      **What:** answer two cheap questions about a clean merge, so the scheduler can skip the compiler. Did either branch touch an exported declaration at all? Do the symbols the two branches touched intersect?
      **Done when:** it answers in milliseconds per changed file, and on the golden set it never filters out a pair that the typecheck analyzer would have flagged.
      **Constraints:** a false negative here is invisible — the conflict is simply never looked for. Bias the filter toward letting pairs through: when it cannot parse a file, or cannot tell, the pair escalates. Report the escalation rate so the filter's value is measurable rather than assumed. The golden set labels two cases for `ast-semantic` — `same-symbol-dual-edit` and `duplicate-implementation`, in `eval/fixtures/semantic.ts` — which compile, so the compiler cannot catch them, and which this milestone, with the AST layer a pre-filter, plans no detector for. They report recall 0 until one exists. What catches them is settled in ADR-0006: the dual edit is the targeted tests', the duplicate nobody's. The pre-filter's own target is to filter out none of the labelled semantic conflicts. Any detector for them names its rules and places its spans as those labels do.

- [ ] **Targeted test analyzer**
      **Files:** `packages/core/src/analyzers/test-targeted.ts`
      **What:** run only the tests reaching the union of both diffs, inside the sandbox, with a flaky-test quarantine list.
      **Done when:** a merged tree runs a small subset of the suite and still catches a planted behavioural conflict — two changes that compile perfectly together and do the wrong thing.
      **Constraints:** this is the only analyzer that can see behavioural conflicts, and the literature puts that category at a meaningful share of merge scenarios. It stays in the pipeline even though it is the slowest thing here. Its Finding's rule is `merge-breaks-test`, and it spans each branch's copy of the function the failing test exercises, as `same-symbol-dual-edit` in `eval/fixtures/semantic.ts` is labelled; that fixture's `test` script is `node --test`, which runs the TypeScript tests with nothing installed, and its twin is two edits to the same function whose tests pass merged. Add the analyzer's floor to the fixture suite's regression test when it lands.

- [ ] **Ranking**
      **Files:** `packages/core/src/advisor/ranking.ts`
      **What:** already implemented — severity, then confidence, then recency, with `findingWeight` gating the noise budget.
      **Done when:** confirmed against real findings rather than fixtures, and adjusted if the ordering reads wrong in practice.
