# M2 — Speculative merge and textual detection

**Goal:** Early warning for textual conflicts. This is the first real demo.

**Exit criteria:** two live agent sessions edit the same function; Interlock
raises a textual-conflict Finding in under 60 seconds while both sessions are
still running.

**Depends on:** M1.

## Tasks

- [ ] **Shadow clone lifecycle**
      **Files:** `packages/core/src/git/shadow.ts`
      **What:** `ensureShadow` — one clone per user repo under the data dir, sharing the origin's object store.
      **Done when:** a second call returns the existing shadow rather than re-cloning, and the shadow's objects are shared, not copied.
      **Constraints:** `ensureShadow` is the only way to obtain a `ShadowRepo`, and a `ShadowRepo` is the only thing mutating functions accept. Keep it that way — the type split is what makes a write to a user repo a compile error.

- [ ] **Shadow worktrees**
      **Files:** `packages/core/src/git/shadow.ts`
      **What:** `createShadowWorktree`, `collectGarbage` — a disposable worktree per speculative merge, under a disk quota.
      **Done when:** worktrees are reclaimed when their run completes or is superseded, and total disk stays under the configured quota with 5 branches in flight.

- [ ] **Snapshot commits**
      **Files:** `packages/core/src/git/worktree.ts`
      **What:** `commitSnapshotInShadow` — turn an M1 dirty-state tree into a real commit inside the shadow, so uncommitted work can be merged.
      **Done when:** a conflict between two sets of uncommitted changes is detectable before either side has committed anything. This is the capability that makes Interlock different from a merge queue.

- [ ] **Speculative merge**
      **Files:** `packages/core/src/merge/speculative-merge.ts`
      **What:** merge two commits inside a throwaway shadow worktree, using the `ort` strategy.
      **Done when:** a clean pair reports clean, a conflicting pair reports its conflicted paths, and neither leaves a worktree behind.
      **Constraints:** a conflict is a result, not an error. Only throw when the merge could not be attempted at all. Benchmark `git merge-tree --write-tree` against a worktree checkout here — if it is fast enough, most of the worktree machinery above becomes unnecessary and should be removed rather than kept.

- [ ] **Textual conflict classification**
      **Files:** `packages/core/src/merge/conflict-classifier.ts`, `packages/core/src/analyzers/textual.ts`
      **What:** read the conflict blocks git produced and turn them into Findings carrying file and hunk spans on both branches.
      **Done when:** each Finding names both branches, both spans, and the merge-base, and a fixture suite covers add/add, edit/edit, edit/delete and rename/edit.
      **Constraints:** evidence is machine-checkable — spans and tool output, never prose alone.

- [ ] **Scheduler v1**
      **Files:** `packages/daemon/src/scheduler/`
      **What:** decide which pairs to re-analyse. Debounce, mark pairs stale when a branch moves, abort superseded runs, prioritise pairs with overlapping touched files, and cap concurrency.
      **Done when:** with 5 branches under continuous edit, work stays inside the CPU budget and no pair is analysed twice for the same snapshot pair.
      **Constraints:** this is where the project succeeds or fails on cost. `notes.md` next to this code explains the algorithm — update it in the same change, not afterwards. Never analyse all N² pairs eagerly.

- [ ] **Analyzer result caching**
      **Files:** `packages/daemon/src/store/`
      **What:** cache verdicts on `(snapshotA, snapshotB, analyzer, toolchain)`.
      **Done when:** re-running an unchanged pair does no work at all.

- [ ] **`interlock check A B`**
      **Files:** `packages/cli/src/commands/`
      **What:** force an immediate speculative merge of a named pair and print the findings.
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
