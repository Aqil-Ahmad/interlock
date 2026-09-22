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

- [x] **An unreadable directory blinds only that directory**
      **Files:** `packages/daemon/src/watcher/worktree-watcher.ts`
      **What:** one directory losing read permission must not cost the whole worktree its watch.

  An `EACCES` from anywhere under a watched tree degraded the entire target to
  polling, trading a live watcher for a timer over one folder. Verified on
  Linux that the watch keeps delivering events for every sibling after such an
  error, so the reaction was heavier than the failure: the error is now scoped
  to the directory it names, and the target keeps its watch.

  The change is still announced, and unnamed — what is inside the directory is
  exactly what cannot be read, so the sweep asks git rather than guessing.
  Scoping requires a path, and only `EACCES`: an error carrying none, one
  naming the watched root, one naming a sibling that merely shares its prefix,
  and a machine-wide budget failure that happens to name a path inside the
  tree all still degrade the target.

  **Done when:** an unreadable subdirectory leaves the worktree watched and
  named events still arriving, on a real tree on Linux; the watched root itself
  becoming unreadable still falls back to polling.

- [ ] **Drop the Node recursive-watcher constraint**
      **Files:** `README.md`, `.github/workflows/ci.yml`, `.node-version`
      **What:** remove the documented Node version limit once upstream is fixed.

  Node 26.9.0 rewrote `lib/internal/fs/recursive_watch.js`; its
  `#onFolderEvent` calls `lstatSync` on a path inside the directory an event
  named with only `ENOENT` suppressed, so a directory that just became
  unreadable throws `EACCES` from inside Node's own callback, past every
  `'error'` listener, and the process dies. Measured across the line: 26.4.0,
  26.5.1, 26.6.0, 26.7.0 and 26.8.2 survive; 26.9.0 does not, and is the
  newest 26.x. Not worked around — there are no users to protect, a workaround
  would be a permanent shape carried for a temporary bug, and the one thing
  that reliably prevented the crash was closing the watch, which is the very
  over-reaction the task above removes. Recorded in `README.md` instead.

  The durable alternative, if upstream stalls and this starts costing real
  users: own the recursion on Linux — one `fs.watch` per directory, added as
  directories appear and dropped as they go, ignore rules applied to what is
  walked. That also stops `node_modules` being watched at all, which Node's
  recursive watcher does today whatever the ignore rules say, so it earns its
  place on cost rather than on this bug. It is a rewrite of the most
  load-bearing subsystem in the daemon and wants its own measurements.

  **Done when:** the regression is filed upstream and fixed, the `README.md`
  paragraph is gone, and the required CI cells run a Node that has the fix.
  **Constraints:** hard rule 5 — the test that trips this is correct and stays.

- [x] **Shadow clone lifecycle**
      **Files:** `packages/core/src/git/shadow.ts`
      **What:** `ensureShadow` — one clone per user repo under the data dir, sharing the origin's object store.

  Bare, because nothing here needs a checkout and the per-pair worktrees come
  later from `git worktree add`. Sharing is `objects/info/alternates` naming the
  user's object directory, asked of git as `rev-parse --git-path objects` rather
  than joined by hand: a linked worktree's git dir is
  `<main>/.git/worktrees/<name>` and holds no objects, and that one command
  resolves both shapes. The user's branches are fetched with `--prune` into
  `refs/remotes/user/*`, leaving `refs/heads/*` free for the speculative refs
  this clone exists to carry.

  The clone takes a `repoId` rather than deriving a path of its own, so the
  location discovery recorded and the location this creates cannot disagree.
  Identity (`user.name`, `user.email`) is set in the clone's config because
  there is no other channel — the runner strips inherited `GIT_*`, neutralises
  global config and refuses a caller's `-c` — and `commit-tree` needs one.

  An existing directory is rebuilt rather than repaired when it is not a bare
  repository or borrows a different object store; both are cheaper to recreate
  than to reason about. The rebuild is a recursive delete, so it refuses any
  path that is not a direct child of `<dataDir>/shadows/` — which is what a
  malformed id reaching it would produce.

  **Done when:** a second call returns the existing shadow rather than
  re-cloning, and the shadow's objects are shared, not copied.
  **Constraints:** `ensureShadow` is the only way to obtain a `ShadowRepo`, and
  a `ShadowRepo` is the only thing mutating functions accept. Keep it that way —
  the type split is what makes a write to a user repo a compile error.

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

- [ ] **Per-pair worktree pool**
      **Files:** `packages/core/src/git/shadow.ts`
      **What:** an LRU pool of persistent per-pair worktrees under the data dir, default size 4, configurable. A pair enters only after the overlap filter marks it worth watching. Update a slot by delta: `merge-tree --write-tree` → `commit-tree` → `reset --hard` inside that pair's worktree, so only changed files are rewritten. See ADR-0005.
      **Done when:** a second check of the same pair rewrites only the files that differ and is measurably faster than the first; `.tsbuildinfo` survives between checks of a slot; eviction is logged with its cost; and an aborted run leaves the slot usable rather than half-written.
      **Constraints:** pool worktrees keep a **detached HEAD** so no branch ref moves. `reset --hard` is a mutating command and is permitted here only because pool worktrees belong to the shadow clone — the runtime `isMutatingCommand` check and `user-repo-untouched.test.ts` both still apply unchanged. If either branch or the merge touches `package.json` or the lockfile, mark the pair `deps-dirty` and route to a slow install path, or skip the semantic check and say why; the symlinked `node_modules` is wrong for that pair and typechecking against it produces confident nonsense.

- [ ] **Scheduler v1**
      **Files:** `packages/daemon/src/scheduler/`
      **What:** decide which pairs get merged, and which clean merges are worth a semantic check. Debounce, mark pairs stale when a branch moves, abort superseded runs, cap concurrency. Rank candidates by file overlap first, then symbol overlap.
      **Done when:** with 5 branches under continuous edit, work stays inside the CPU budget, no pair is analysed twice for the same snapshot pair, and both the escalation rate and the pool eviction rate are reported.
      **Constraints:** this is where the project succeeds or fails. `notes.md` beside this code explains the algorithm — update it in the same change. Never analyse all N² pairs eagerly, and never escalate a clean merge to the compiler without an overlap reason. **Prefer re-checking a hot pooled pair over rotating a new one in.** Stickiness is a cost control of the same rank as overlap filtering, because every eviction discards incremental compiler state and the next check of that pair pays the cold cost again — round-robin fairness across pairs is the worst available strategy.

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
      **Files:** `vitest.config.ts`, `.github/workflows/ci.yml`
      **What:** restore the `packages/core/src/**` threshold at 80% lines and functions, and restore the `coverage` CI job that runs it.
      **Done when:** CI fails when `core` drops below the threshold. Both were removed while `core` was mostly declarations — the gate measured nothing and the job discarded its own output. By now there is an implementation to measure.
