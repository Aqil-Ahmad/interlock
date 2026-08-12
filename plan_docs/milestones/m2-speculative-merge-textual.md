# M2 — Speculative merge and textual detection

**Goal:** Early warning for textual conflicts. This is the first real demo.

**Exit criteria:** two live agent sessions edit the same function; Interlock
raises a textual-conflict Finding in under 60 seconds while both sessions are
still running.

**Depends on:** M1.

Two different costs get solved in two different places, and confusing them is
the fastest way to build the wrong thing:

- **Merge cost** is solved by `git merge-tree --write-tree`. It merges in the
  object database with no checkout, no working directory and no index lock.
- **Typecheck cost** is solved by the scheduler, and only by the scheduler.
  A semantic conflict is by definition a merge that came out _clean_, so
  `merge-tree` never filters those out — every clean pair is a typecheck
  candidate. Deciding which of them is worth the compiler is the whole problem.

Typecheck cost is the budget that decides whether this product runs on a laptop.

## Tasks

- [ ] **Shadow clone lifecycle**
      **Files:** `packages/core/src/git/shadow.ts`
      **What:** `ensureShadow` — one clone per user repo under the data dir, sharing the origin's object store.
      **Done when:** a second call returns the existing shadow rather than re-cloning, and the shadow's objects are shared, not copied.
      **Constraints:** `ensureShadow` is the only way to obtain a `ShadowRepo`, and a `ShadowRepo` is the only thing mutating functions accept. Keep it that way — the type split is what makes a write to a user repo a compile error.

- [ ] **Snapshot commits**
      **Files:** `packages/core/src/git/worktree.ts`
      **What:** `commitSnapshotInShadow` — turn an M1 dirty-state tree into a real commit inside the shadow, so uncommitted work can be merged.
      **Done when:** a conflict between two sets of uncommitted changes is detectable before either side has committed anything. This is the capability that makes Interlock different from a merge queue.

- [ ] **Pairwise merge with `merge-tree`**
      **Files:** `packages/core/src/merge/speculative-merge.ts`
      **What:** merge two commits with `git merge-tree --write-tree` inside the shadow. Returns the merged tree id when clean, and the conflicted paths with their stages when not. No worktree, no checkout.
      **Done when:** a clean pair returns a tree id and a conflicting pair returns its conflicted paths; neither creates a working directory; and the timing per pair is recorded in `log.md`.
      **Constraints:** a conflict is a result, not an error — throw only when the merge could not be attempted at all. `merge-tree` needs git 2.38+; detect and report `TOOLCHAIN_UNSUPPORTED` on older git rather than silently falling back.

- [ ] **Textual conflict classification**
      **Files:** `packages/core/src/merge/conflict-classifier.ts`, `packages/core/src/analyzers/textual.ts`
      **What:** turn `merge-tree`'s conflict output into Findings carrying file and hunk spans on both branches.
      **Done when:** each Finding names both branches, both spans and the merge-base, and a fixture suite covers add/add, edit/edit, edit/delete and rename/edit.
      **Constraints:** evidence is machine-checkable — spans and tool output, never prose alone.

- [ ] **Reusable scratch worktree**
      **Files:** `packages/core/src/git/shadow.ts`
      **What:** one scratch directory per repo, reused for every pair that needs a real filesystem. Materialise a merged tree into it on demand, symlink `node_modules` from the user's checkout rather than installing, and reset it between uses.
      **Done when:** materialising a merged tree is measured and recorded; running two different pairs in sequence reuses the same directory; and the directory is left clean if a run is aborted midway.
      **Constraints:** one scratch directory, not one per pair — that was the original design and it is what made the cost look impossible. If either branch changed `package.json` or the lockfile, the symlinked `node_modules` is wrong for that pair: detect it and route to a slower path that installs, or skip the semantic check and say why.

- [ ] **Scheduler v1**
      **Files:** `packages/daemon/src/scheduler/`
      **What:** decide which pairs get merged, and which clean merges are worth a semantic check. Debounce, mark pairs stale when a branch moves, abort superseded runs, cap concurrency. Rank candidates by file overlap first, then symbol overlap.
      **Done when:** with 5 branches under continuous edit, work stays inside the CPU budget, no pair is analysed twice for the same snapshot pair, and the proportion of clean merges that get escalated to a typecheck is reported.
      **Constraints:** this is where the project succeeds or fails. `notes.md` beside this code explains the algorithm — update it in the same change. Never analyse all N² pairs eagerly, and never escalate a clean merge to the compiler without an overlap reason.

- [ ] **Analyzer result caching**
      **Files:** `packages/daemon/src/store/`
      **What:** cache verdicts on `(snapshotA, snapshotB, analyzer, toolchain)`.
      **Done when:** re-running an unchanged pair does no work at all.

- [ ] **False-positive budget**
      **Files:** `packages/daemon/src/store/`, `packages/core/src/advisor/`
      **What:** count findings raised, findings delivered, and findings later dismissed or resolved as wrong. Expose the ratio.
      **Done when:** the daemon can report its own false-positive rate for a time window, and `interlock status` shows it.
      **Constraints:** the design rule is **when unsure, say nothing**. A tool that catches 60% of conflicts and never lies is a product; one that catches 95% and cries wolf twice a day is uninstalled within a week. Every false positive is a bug with an issue, not a tuning parameter.

- [ ] **`interlock check A B`**
      **Files:** `packages/cli/src/commands/`
      **What:** force an immediate merge of a named pair and print the findings.
      **Done when:** it reports a planted conflict in a fixture repo with usable output.

- [ ] **Fixture suite**
      **Files:** `eval/fixtures/`
      **What:** small synthetic repos with planted, labelled conflicts, built programmatically in temp dirs.
      **Done when:** each fixture states which pair conflicts, which analyzer should catch it, and which file and symbol. Include negative twins — pairs that look similar and are genuinely independent.
      **Constraints:** the fixture lands before the rule it exercises. Once written, `eval/` is read-only to coding sessions.

- [ ] **Turn the coverage gate on**
      **Files:** `vitest.config.ts`
      **What:** restore the `packages/core/src/**` threshold at 80% lines and functions.
      **Done when:** CI enforces it. It was switched off while `core` was mostly declarations; by now it has an implementation to measure.
