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

- [x] **Snapshot commits**
      **Files:** `packages/core/src/git/worktree.ts`, `packages/core/src/git/repo-handle.ts`
      **What:** `commitSnapshotInShadow` — turn an M1 dirty-state tree into a real commit inside the shadow, so uncommitted work can be merged.

  Snapshot objects are written into the shadow's store, not the user's. The
  runner gains one capability beside `indexFile` — `objectStore`, which takes a
  `ShadowRepo` and nothing else, so objects can only be redirected into
  something `ensureShadow` produced — and `captureDirtyState` passes it through.
  The shadow borrows the user's objects through alternates, so seeding from
  `HEAD` still reads; everything the capture writes lands where the user's
  `gc` cannot reach it, and nothing at all is written under the user's `.git`.
  A missing-object check at commit time would only protect the instant of the
  commit, leaving the tree unreferenced under a commit that points at it.

  The parent is the commit the snapshot was captured against, not whatever a
  branch ref says when the commit is made: the tree is that commit plus the
  uncommitted work, and parenting it on a branch that has since moved would
  make the new commit's changes look reverted. `WorktreeSnapshot` records that
  commit (`headSha`, null when `HEAD` is unborn), which also answers a detached
  `HEAD` without a ref to look up. The function takes the snapshot rather than
  a tree and a ref name, so the parent cannot be supplied from a different
  moment than the tree.

  The result carries the tree, which is the identity, and the commit, which is
  what a merge takes; the same tree committed twice yields two commits. A clean
  snapshot returns its `headSha` and runs no `commit-tree`. A tree or parent the
  shadow cannot read is `SNAPSHOT_STALE` — not infrastructure, and answered by
  taking the snapshot again — which is what a shadow rebuilt between capture
  and commit produces.

  No ref per snapshot: nothing collects the shadow, since `gc.auto` and
  auto-maintenance are off in its config and on every runner invocation. What
  eventually collects it is the pool's garbage collector, and that task has to
  treat pool-slot commits as roots.

  **Done when:** two worktrees on different branches, each with uncommitted
  edits to the same line, are captured into the shadow and committed, and `git
merge-tree` over the two commits reports the conflict — with neither side
  having committed anything, and the user repository byte-identical afterwards.

- [x] **Pairwise merge with `merge-tree`**
      **Files:** `packages/core/src/merge/speculative-merge.ts`
      **What:** merge two commits with `git merge-tree --write-tree` inside the shadow. Returns the merged tree id when clean, and the conflicted paths with their stages when not. No worktree, no checkout.

  The result is a tree and the conflict data, and nothing is materialised: the
  declared result carried a `ShadowWorktree` for the caller to dispose, which is
  the per-pair checkout this approach exists to avoid. A conflicted merge still
  writes a tree, with markers in the conflicted files, so conflict regions are
  read out of that tree's blobs — never a checkout. The shadow sets
  `merge.conflictStyle=diff3`, which `merge-tree` honours, so each region carries
  its base text: that is what tells two additions beside each other from two
  edits of the same line.

  Output is parsed in its `-z` form, and the informational section is parsed
  too — it carries a stable type token per message (`CONFLICT (contents)`,
  `CONFLICT (binary)`, `CONFLICT (rename/rename)`, …) beside the prose, and the
  classifier keys on the token. A binary conflict is reported as both `contents`
  and `binary`, so a region is only parsed for a path that is the first and not
  the second.

  The base is supplied, which needs git 2.40, and attributes are read from
  `commitA` with `--attr-source`, which needs 2.41: a bare clone has no
  worktree to read `.gitattributes` from, and without it `binary`, merge drivers
  and `conflict-marker-size` are silently ignored — a pair conflicts in the
  shadow that merges cleanly for real. 2.38 accepts `--write-tree` and refuses
  both, so a check for the subcommand or for `--write-tree` passes on a git that
  cannot do this. The
  check is the merge itself — git answers a form it does not understand with
  exit 129, which is `TOOLCHAIN_UNSUPPORTED` — so nothing is paid per pair on a
  git that works. Supplied rather than rediscovered because a Finding names the
  merge base as evidence, and a merge git ran against a base of its own choosing
  — a virtual one, on criss-cross history — would not match it. Two commits with
  no common ancestor never arrive: `mergeBase` answers null for them and the
  request has nowhere to put a null.

  Exit 0 is clean, 1 is conflicted, 129 unsupported. Anything else first asks
  whether all three commits are in the shadow — a missing one is
  `SNAPSHOT_STALE`, answered by capturing again — and otherwise is
  `MERGE_FAILED`. git's stderr names paths and branches, which is repository
  content, and stays out of the error as it does everywhere else.

  **Done when:** a clean pair returns a tree id and a conflicting pair returns
  its conflicted paths, stages, typed messages and conflict regions read from
  the merged tree; the cases that have broken real tools are covered — binary,
  file against symlink, directory against file, rename against rename, a
  submodule, a newline in a path, and a clean merge touching thousands of files;
  nothing is written under the user's repository, per the untouched cycle; and
  the median time per pair on a real repository is in `log.md`.
  **Constraints:** a conflict is a result, not an error. No classifier, analyzer
  wiring or store writes — this task ends at a returned result.

- [x] **Textual conflict classification**
      **Files:** `packages/core/src/merge/conflict-classifier.ts`, `packages/core/src/analyzers/textual.ts`
      **What:** turn `merge-tree`'s conflict output into Findings — one per conflicted path — carrying each branch's hunk spans in that branch's own file, and wire `textualAnalyzer.analyze` to produce them.

  The class comes from structure, never from git's prose: the stage set and the
  `-z` type token. `CONFLICT (modify/delete)` is `delete-vs-modify`,
  `CONFLICT (rename/delete)` is `rename-vs-modify`, a content conflict with no
  base stage is `add-add`, and a content conflict with one is
  `overlapping-edit` when both sides changed a base line in common and
  `adjacent-addition` otherwise — including when the regions cannot be read,
  because when it cannot tell it says the weaker thing. A binary conflict is
  `overlapping-edit` with no span. git merges a rename on one side and an edit
  on the other cleanly unless the edits collide, so rename/edit is a content
  conflict classified by its regions, whose spans sit at each branch's own
  path. Any other type (`rename/rename`, `file/directory`, a submodule) raises
  nothing and is logged by its token.

  A span is located in the stage-2 or stage-3 blob, never in merged-file
  coordinates, and a side whose lines cannot be placed exactly gets no span.
  The merge base and both commits travel on a `merge-conflict` evidence beside
  the spans, with git's type tokens and each side's blob. Severity is by class;
  confidence is 1, since git conflicting is ground truth. `originBranch` is null:
  a textual conflict is symmetric.

  Rewritten from "both spans and the merge-base, and a fixture suite covers
  add/add, edit/edit, edit/delete and rename/edit": the deleting side of an
  edit/delete has no file to hold a span; the Finding model had nowhere to name
  a merge base; git reports no conflict at all for a rename against an edit
  elsewhere in the file; and the Fixture suite task below writes to `eval/`,
  which is read-only to coding sessions — this task's fixtures are integration
  fixtures in `packages/core/test`.

  **Done when:** each Finding names both branches, the merge base and both
  commits, and a span on every branch that has the file, placed in that
  branch's own blob; a labelled fixture suite covers add/add, edit/edit,
  edit/delete, rename/edit, rename/delete and adjacent additions, each with a
  negative twin that raises nothing; a binary conflict yields no span, and a
  newline in a path, CRLF, regions on the first and last line and a pair with
  dozens of conflicted files are covered, the last against a stated bound on
  Findings per run; and an analyzer that cannot read a blob returns
  `infra-failure`, never an empty list.
  **Constraints:** evidence is machine-checkable — spans and tool output, never prose alone. The fixture lands before the rule it exercises. Excerpts are bounded; repository content stays out of titles and descriptions.

- [ ] **Per-pair worktree pool**
      **Files:** `packages/core/src/git/shadow.ts`
      **What:** an LRU pool of persistent per-pair worktrees under the data dir, default size 4, configurable. A pair enters only after the overlap filter marks it worth watching. Update a slot by delta: `merge-tree --write-tree` → `commit-tree` → `reset --hard` inside that pair's worktree, so only changed files are rewritten. See ADR-0005.
      **Done when:** a second check of the same pair rewrites only the files that differ and is measurably faster than the first; `.tsbuildinfo` survives between checks of a slot; eviction is logged with its cost; and an aborted run leaves the slot usable rather than half-written.
      **Constraints:** pool worktrees keep a **detached HEAD** so no branch ref moves. `reset --hard` is a mutating command and is permitted here only because pool worktrees belong to the shadow clone — the runtime `isMutatingCommand` check and `user-repo-untouched.test.ts` both still apply unchanged. Garbage collection in the shadow treats commits held by pool slots, and snapshot commits a queued check still needs, as roots — nothing references them by ref. If either branch or the merge touches `package.json` or the lockfile, mark the pair `deps-dirty` and route to a slow install path, or skip the semantic check and say why; the symlinked `node_modules` is wrong for that pair and typechecking against it produces confident nonsense.

- [ ] **Scheduler v1**
      **Files:** `packages/daemon/src/scheduler/`
      **What:** decide which pairs get merged, and which clean merges are worth a semantic check. Debounce, mark pairs stale when a branch moves, abort superseded runs, cap concurrency. Rank candidates by file overlap first, then symbol overlap.
      **Done when:** with 5 branches under continuous edit, work stays inside the CPU budget, no pair is analysed twice for the same snapshot pair, and both the escalation rate and the pool eviction rate are reported.
      **Constraints:** the daemon's snapshots have to be captured with `objectStore` set to the repository's shadow before any of them reaches a merge; captured without it, as the watcher does today, the tree sits unreferenced in the user's store for their `gc` to reap. This is where the project succeeds or fails. `notes.md` beside this code explains the algorithm — update it in the same change. Never analyse all N² pairs eagerly, and never escalate a clean merge to the compiler without an overlap reason. **Prefer re-checking a hot pooled pair over rotating a new one in.** Stickiness is a cost control of the same rank as overlap filtering, because every eviction discards incremental compiler state and the next check of that pair pays the cold cost again — round-robin fairness across pairs is the worst available strategy.

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
