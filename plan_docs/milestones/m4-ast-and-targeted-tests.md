# M4 — AST analysis and targeted tests

**Goal:** Faster, cheaper semantic signals, and deeper explanations.

**Exit criteria:** the AST analyzer flags the M3 demo case in under 10 seconds
without invoking the compiler; on the fixture golden set, AST-layer precision is
at least 0.9, combined recall is reported, and every false positive has an issue.

**Depends on:** M3.

## Tasks

- [ ] **Expand this milestone before starting it**
      **Files:** this file
      **What:** the tasks below are one line each. Rewrite them to the depth of `m1-watcher-and-git-core.md` — per-task edge cases, failure modes, the tests each needs, and the constraints it can breach by accident.
      **Done when:** every task below carries a `Done when` naming an observable check, and nothing in it contradicts what earlier milestones learned.

- [ ] **Decide the parser, and record it**
      **Files:** `plan_docs/decisions/`
      **What:** tree-sitter versus the TypeScript compiler API or ts-morph. tree-sitter is fast, multi-language and tolerant of broken files, but has no symbol table. The compiler API resolves symbols across files, which is what rename-versus-call-site actually needs, and v1 is TypeScript-only.
      **Done when:** an ADR states the choice, what it gives up, and what would reverse it. Do this before writing any matcher.

- [ ] **Symbol extraction**
      **Files:** `packages/core/src/ast/` (create in this milestone)
      **What:** build a symbol table per branch, addressed well enough to compare across branches. `qualifiedName` must stay stable under formatting changes.
      **Done when:** the same symbol in two branches matches after reformatting, and does not match after a rename.

- [ ] **Cross-branch matchers**
      **Files:** `packages/core/src/ast/matchers.ts`
      **What:** rename versus call site; signature or arity change versus caller; deleted or moved export versus import; same-symbol dual edit; duplicate implementation.
      **Done when:** each matcher has a fixture that triggers it and a negative twin that must not.
      **Constraints:** precision beats recall. A matcher that is unsure stays silent — the sandbox analyzers are the safety net, and a false positive costs agent trust that is expensive to win back.

- [ ] **Test impact selection**
      **Files:** `packages/core/src/analyzers/test-targeted.ts`
      **What:** run only tests reaching the union of both diffs, inside the sandbox, with a flaky-test quarantine list.
      **Done when:** a merged tree runs a small subset of tests and still catches the planted breakage.

- [ ] **Ranking**
      **Files:** `packages/core/src/advisor/ranking.ts`
      **What:** already implemented — severity, then confidence, then recency, with `findingWeight` gating the noise budget.
      **Done when:** confirmed against real findings rather than fixtures, and adjusted if the ordering reads wrong in practice.
