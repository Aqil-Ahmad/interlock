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
      **What:** turn `merge-tree`'s conflict output into Findings — one per conflict — carrying each branch's hunk spans in that branch's own file, and wire `textualAnalyzer.analyze` to produce them.

  The class comes from structure, never from git's prose: the stage set and the
  `-z` type token. `CONFLICT (modify/delete)` is `delete-vs-modify`,
  `CONFLICT (rename/delete)` is `rename-vs-delete`, a content conflict with no
  base stage is `add-add`, and a content conflict with one is
  `overlapping-edit` when both sides changed a base line in common and
  `adjacent-addition` otherwise — including when the regions cannot be read,
  because when it cannot tell it says the weaker thing. A content conflict
  whose sides are not both text — binary, or a symlink — is `whole-file-edit`
  with no span. git merges a rename on one side and an edit
  on the other cleanly unless the edits collide, so rename/edit is a content
  conflict classified by its regions, whose spans sit at each branch's own
  path. Anything else git reports — `rename/rename`, `file/directory`,
  `distinct modes`, a submodule, or a known token on stages that do not fit it
  — is `other-conflict`, medium and without spans: git is certain it conflicts,
  so a conflicted merge never comes back `clean`. A blob over 1 MiB is not
  read and gets no span.

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
  Findings per run; a conflicted merge never yields a `clean` verdict; and an
  analyzer whose git fails returns `infra-failure`, never an empty list, while
  a command the runner refused surfaces as the bug it is.
  **Constraints:** evidence is machine-checkable — spans and tool output, never prose alone. The fixture lands before the rule it exercises. Excerpts are bounded; repository content stays out of titles and descriptions.

- [x] **Per-pair worktree pool**
      **Files:** `packages/core/src/git/worktree-pool.ts`, `packages/core/src/git/shadow.ts`, `packages/core/src/analyzers/analyzer.ts`
      **What:** an LRU pool of persistent per-pair worktrees cut from the shadow, under `<dataDir>/worktrees/<repoId>/`, default size 4, set per pool. A slot holds a clean pair's merged tree on disk for a semantic check to read. See ADR-0005.

  The input is a clean `SpeculativeMergeResult` and the two commits it merged;
  a conflicted one is a caller error, since a tree with markers in it is not
  worth compiling. Which pairs are worth a slot is the scheduler's decision, not
  the pool's — the overlap test lives there. The merge is `speculativeMerge`'s;
  the pool wraps its tree with `commit-tree -p A -p B` and `reset --hard`s the
  slot to that commit. A first fill is `worktree add --detach --no-checkout`
  and then the same reset, so every write into a slot is one git process the
  runner can kill: `worktree add` checks out in a child that outlives its
  parent when the parent is killed.

  Slot handles are `ShadowRepo`s whose root is the slot and whose git dir is
  the shadow's `worktrees/<name>`. They are minted by the pool from a handle
  `ensureShadow` returned, and nowhere else.

  Dependencies are compared between the merged tree and the tree of the
  checkout whose installed `node_modules` a check would borrow, over every
  `package.json`, lockfile and package-manager config. The merged tree, not
  either side: it is what gets compiled, and a side's change that does not
  survive the merge cannot affect it — while the side-wise rule would skip the
  commonest pair there is, one branch adding a dependency in the checkout it
  was installed in. A difference skips the pair with the paths that differ,
  before any slot is touched, so a pair that cannot be checked never evicts one
  that can. The slow path with a real install belongs to the sandbox.

  **Done when:**
  - a second check of the same pair rewrites only the files that differ —
    inode and mtime of every unchanged file are unmoved — and first fill
    against update is timed on a real repository through a shadow, with that
    repository byte-identical afterwards and both numbers in `log.md`.
    Updates are measurably faster than the fill once settled: the first one
    after a fill re-reads every file written in the same second as the index,
    which git cannot trust by timestamp, and on a large tree that costs about
    as much as the fill — so it is priced with the fill, not with the updates;
  - untracked and ignored files planted in a slot (a `.tsbuildinfo`, a
    `.turbo/` cache) survive updates;
  - eviction is least-recently-used, never takes a slot in use, is logged and
    returned with its bytes on disk and the age of its build state, and leaves
    no administrative files in the shadow;
  - a reset killed with `SIGKILL` (a stale `index.lock`) and one killed by the
    runner's timeout (a half-written tree) both leave a slot the next check
    repairs with its build state intact; a slot whose administrative directory
    is gone, or whose `add` was interrupted, is discarded and filled again;
  - a deps-dirty pair and a deps-clean pair both get their verdict;
  - two checks of one pair, raced for real, run one after the other;
  - a pool whose slots would resolve inside the user's repository — a data
    dir inside a checkout, or a symlink into one — refuses before creating
    anything;
  - a pool opened over slots a previous process left adopts them rather than
    orphaning them;
  - the untouched cycle fills a slot and updates it.

  **Constraints:** slots keep a **detached HEAD** so no branch ref moves, and
  the shadow sets `core.logAllRefUpdates=false`, since a slot has a worktree
  and git would otherwise keep a `HEAD` reflog there that pins every throwaway
  commit for 90 days. `reset --hard` is mutating and is permitted only because
  slots belong to the shadow clone — the runtime `isMutatingCommand` check and
  `user-repo-untouched.test.ts` both still apply unchanged. Nothing in a slot is
  executed on the host, and the pool links no `node_modules`: how dependencies
  reach a check is the sandbox's.

- [x] **Shadow garbage collection**
      **Files:** `packages/core/src/git/shadow.ts`, `packages/daemon/src/shadows.ts`, `packages/daemon/src/daemon.ts`, `packages/daemon/src/retention.ts`, `packages/daemon/src/scheduler/run-pipeline.ts`, `packages/daemon/src/watcher/snapshot.ts`, `packages/daemon/src/store/`, `scripts/scheduler-bench.ts`
      **What:** reclaim the objects Interlock writes into each shadow — capture blobs and trees, snapshot commits, merge trees, pool commits, nearly all loose and unreferenced — so the shadow's disk use stays bounded under continuous checking.

  Rewritten before starting, from what `git prune` was measured to do against a
  bare shadow borrowing the user's store. **Collection is `git prune
--expire=@<epoch>`**, never `gc`: it deletes only the shadow's own loose,
  unreachable objects older than the expiry, reads the user's objects for
  reachability and never touches them; `gc` would repack and run the
  maintenance the shadow switches off. The expiry is exact seconds — an ISO
  string with a `Z` was parsed as another date and pruned nothing.
  **The expiry is the retention cutoff less a margin**, and collection runs in
  the retention pass after the store is pruned, so a verdict older than the
  window is gone before its objects are; the margin covers the one way a recent
  verdict can name an old object — a snapshot commit reused from cache — whose
  reuse gets an age bound to match. **Keep refs under `refs/interlock/keep/`**,
  rewritten each pass, pin what age cannot vouch for: the commits an open or
  stale Finding's evidence names, and each branch's current snapshot tree — a
  queued check's input, which an idle branch never rewrites. **One damaged keep
  candidate fails the whole prune** — a commit whose parent the user's `gc`
  removed stops `prune` walking it — so each is checked first, scoped to stop at
  the user's history, and a broken one is skipped and reported. **The shadow is
  refreshed first** (`ensureShadow`, which fetches with `--prune`), so no stale
  ref names an object the user's `gc` removed. **Collection is exclusive** per
  repository against runs and captures, which share it, so nothing written
  mid-walk is lost. A failure is infrastructure: logged, backed off, never a
  run's failure. A rebuilt clone is already covered by the generation in every
  verdict's key.
  **Revised after review:** collection also packs every pass (`repack --cruft
-d -l`, before the prune), since a day of loose objects at the default window
  measured 4.4 GiB and a nine-minute prune; a shutdown stops a collection in
  progress rather than waiting for it. **Second review:** only `repack` and
  `prune` hold the shadow alone; the refresh and the keep refs run beside
  checks, the collection waits for the scheduler to go idle first (five minutes
  at most), and a never-collected shadow prunes before packing.

  **Done when:** only old, unreachable objects go — a fresh capture, a pool slot's
  current commit and every kept object survive, a slot's previous commit and
  resolved Findings' commits do not; an open Finding's evidence commits and every
  still-servable verdict's exist after a collection; a keep candidate with broken
  ancestry and a stale ref to a `gc`'d object each leave collection working; a
  failure backs off without failing a run; the user's repository is
  byte-identical and its object count unchanged; and a day of continuous checks,
  compressed, shows the shadow's size flat after the first window, with the
  numbers in `log.md`.
  **Constraints:** never collect the user's store — `prune` runs on a `ShadowRepo` only, which the runner enforces. No background git maintenance. A queued or running check never loses an object it needs.

- [x] **Retention**
      **Files:** `packages/daemon/src/daemon.ts`, `packages/daemon/src/store/`, `packages/shared/src/config.ts`, `docs/threat-model.md`
      **What:** have the daemon enforce a retention window on its database, on start and on a timer, so continuous agent edits leave the store bounded — the database half of the disk bound the shadow's collection is the other half of.

  Rewritten before starting. **Traceability and pruning conflicted**: `prune`
  kept a run holding an open Finding but deleted every event older than the
  cutoff, so an old open Finding kept its run and lost the `finding.raised`,
  `run.started`, `pair.scheduled` and `branch.snapshot` that explain it. An old
  event is now kept when an event of a run holding an open or stale Finding
  leads back to it through `causedBy` — a recursive query in the same statement
  as the delete, seeded through an index on the run an event names. **A pass
  must not hold the one writer**: rows go in small batches, each its own
  transaction, yielding between them, and the file is never vacuumed — freed
  pages are reused, which is the bound that matters. **Two tables had no
  bound at all**: ended agent sessions, and runs left `running` by a daemon that
  died mid-run — proven abandoned by starting before the process that owns the
  store, and holding no open Finding; both go once they are older than the
  window. **A cache hit does
  not refresh a verdict**, deliberately: a verdict's evidence names the commits
  of the run that reached it, and the shadow's collection can only keep "objects
  younger than the window" safely if no verdict outlives it. The window's
  default is chosen from measured growth, not a round number.

  **Done when:** `retention.windowMs` is in the config with a default and
  validated like every other value; the daemon prunes once after start, off the
  startup path, then on a timer, logging what each table lost; an old open
  Finding traces through `causedBy` to the edit behind it after a prune, beside
  an old resolved one whose chain is gone; restart re-verification reconciles an
  old open Finding rather than duplicating it after a prune; a bench of
  continuous edits against a file-backed store shows row counts and file size
  flat after the first window, with per-hour growth, one pass on a large store
  timed, and the numbers in `log.md`; and T7 names only mitigations that exist.
  **Constraints:** `prune` keeps any run holding an open or stale Finding, and a verdict goes with the run it came from. The event log is append-only; pruning by age is the one sanctioned deletion. Findings stay traceable. Restart re-verification must survive it. Any schema change is a migration shown idempotent.

- [x] **`ensureShadow` refuses a data dir inside the repository**
      **Files:** `packages/core/src/git/shadow.ts`
      **What:** refuse to create or refresh a shadow whose path resolves inside the checkout it mirrors, or inside that checkout's git directory, before anything is written.
      **Done when:** a data dir inside the checkout, one inside the main checkout of a linked worktree, and one reached through a symlink are each refused with nothing created, matching the pool's refusal.
      **Constraints:** hard rule 1. A data dir configured inside a checkout would put the whole bare clone into the user's worktree as untracked files. The daemon refuses such a data dir at start, before it writes anything; the shadow and the pool refuse again for a path handed to them directly. All three ask git for the repository's directories through `repositoryDirsOf`.

- [x] **Scheduler v1**
      **Files:** `packages/daemon/src/scheduler/`
      **What:** decide which pairs get merged, and which clean merges would be worth a semantic check; and wire the run pipeline that executes a pair — shadow, the sides' commits, `speculativeMerge` against the pair's merge base, textual classification, and the run, its Findings and its events persisted with `causedBy` — into the daemon. Debounce per branch with a ceiling, mark pairs stale when a branch moves, discard superseded results, cap concurrency, back off infrastructure failures, and rank by file overlap.

  Rewritten before starting, for five reasons. **Symbol overlap** needs the
  AST layer, which comes later: v1 ranks by file overlap alone — a common file,
  a common directory, or one side's file being the other's directory — through
  the pure `pairOverlap()` deferred in M1 until it had a consumer. A pair with
  definitely none is never merged, since no textual conflict can come of it; a
  pair whose overlap is unknown, and every branch against the default branch,
  is merged at low priority. **No semantic analyzer exists**: v1 decides
  escalation and records it, so the rate is measurable, and runs nothing.
  **"Pool eviction rate"** cannot come from the pool, which only evicts when a
  semantic check claims a slot: the scheduler keeps the pool-sized set of hot
  escalated pairs itself, sticky, and reports the evictions that set makes —
  the ones the pool will make once something runs in it. **"The same snapshot
  pair"** is by content, not id: a `SnapshotId` is minted per capture, so
  identity is the two tree ids and the merge base. And **aborting** has nothing
  to abort: no layer below takes a signal, so a run superseded mid-flight
  finishes, is recorded `superseded`, and has its result discarded rather than
  persisted — a superseded result was never shown, so the same content may be
  merged once more. Real cancellation waits for a compiler worth killing.

  The watcher's captures move into the shadow's object store, and
  `branch.snapshot` gains the head each tree was captured against, so a run
  commits the watcher's own tree instead of hashing the worktree a second time.

  **Done when:** a scheduler driven by an injected clock and fake runs is shown to debounce with a ceiling, rank by overlap, never queue a pair twice, never complete two analyses of one pair for the same content, discard and record superseded runs, back off an infrastructure failure with one `infra.failure` per streak, retry `SNAPSHOT_STALE` at once, and keep a hot pair over a new one; the daemon, with two worktrees editing the same function, raises a textual Finding within 60 s, end to end; and a bench with 5 branches under continuous edit reports idle CPU against the 2% budget, edit-to-Finding latency against 60 s, CPU under edit, queue depth, escalation rate and eviction rate, with the numbers in `log.md`.
  **Constraints:** the daemon's snapshots have to be captured with `objectStore` set to the repository's shadow before any of them reaches a merge; captured without it, as the watcher does today, the tree sits unreferenced in the user's store for their `gc` to reap. This is where the project succeeds or fails. `notes.md` beside this code explains the algorithm — update it in the same change. Never analyse all N² pairs eagerly, and never escalate a clean merge to the compiler without an overlap reason. **Prefer re-checking a hot pooled pair over rotating a new one in.** Stickiness is a cost control of the same rank as overlap filtering, because every eviction discards incremental compiler state and the next check of that pair pays the cold cost again — round-robin fairness across pairs is the worst available strategy.

- [x] **Edit-to-Finding holds when a filesystem event is missed**
      **Files:** `packages/daemon/src/watcher/`, `packages/daemon/src/timing.ts`, `packages/core/src/git/discovery.ts`, `packages/daemon/test/scheduler-demo.test.ts`
      **What:** make the 60-second budget from edit to textual Finding hold when the edit's filesystem event never arrives, and when the edit lands while the daemon is starting.

  Rewritten before starting. **The probe already runs.** Every pass lists
  branches through `git status --porcelain -z` in each worktree — through the
  runner, whose `GIT_OPTIONAL_LOCKS=0` is `--no-optional-locks`, so the user's
  index is never refreshed or locked. A second status for a probe would double
  the pass for nothing; the probe signs what the pass already read — each
  listed path with its `lstat` — and the pass hashes only a worktree whose
  signature moved. Two things the task as written would have missed:
  **untracked directories** — plain `status` collapses a new untracked
  directory to `dir/`, so an edit inside it changes nothing it prints; the
  listing becomes `--untracked-files=all`. And **ctime**, which no tool can set
  back: signed beside mtime and size, a timestamp-restoring write to a dirty
  file still moves the signature, and `status` itself compares ctime for clean
  tracked files unless `core.trustctime` is off. The backstop re-hash covers
  what is left, so its period is set against idle cost rather than the budget.

  **The period is the pass's own**, so the chain is the sweep interval, the
  pass, the scheduler's settle ceiling and a run — not the interval plus a
  separate probe period. It is derived rather than tuned: the default
  interval is what the budget leaves after the ceiling the configured debounce
  implies and an allowance for the pass and the run, capped at today's 30 s,
  and a debounce long enough that nothing fits is refused at start.

  **Startup**: the first pass discovers the worktrees the watches are armed
  on, so the watch cannot come first there. A newly armed worktree gets one
  more probe pass after arming instead — an edit before it is in that pass, an
  edit after it produces an event — which is the same guarantee, and holds for
  a worktree that appears later too.

  **Done when:**
  - with the filesystem signal suppressed entirely, an edit raises its
    Finding inside the budget, and the chain is checked in code against the
    debounce settings;
  - an edit landing between a worktree's first capture and its watch is seen;
  - the probe moves for a second edit to an already-dirty file, a new
    untracked file, a file inside a new untracked directory and an edit that
    restores its mtime; stays still for a worktree nothing changed in; and the
    backstop still catches an edit `status` cannot see;
  - an unreadable worktree stays unknown across passes without flapping, and
    a branch switch with no content change is still announced;
  - idle cost with the probe is measured against the 2% budget and recorded;
  - the demo test fails with the daemon's log attached, and the flake is
    reproduced, or reported as not reproduced, before the fix is chosen.
    **Constraints:** no retries, longer timeouts or sleeps to pass a test.
    Nothing here writes to the user's repository or refreshes their index.
    `notes.md` beside the scheduler carries the timing chain.

- [x] **Analyzer result caching**
      **Files:** `packages/daemon/src/store/`, `packages/daemon/src/scheduler/run-pipeline.ts`, `packages/core/src/analyzers/`
      **What:** cache each analyzer's verdict on the content it judged, so re-running a pair at content already analysed — which is what an agent reverting and re-applying a change produces — costs no capture, no commit, no merge and no analyzer.

  Rewritten before starting. **The key as written never hits**: a `SnapshotId`
  is minted per capture, so identical content gets a new id every time. The key
  is content: each side's tree, the merge base — the same trees on another base
  are another merge — the analyzer, and a toolchain fingerprint. **It also names
  the pair, in the pair's order**: Findings are not copied, so a hit can only
  point at Findings its own pair raised, and another pair with identical trees —
  a branch just cut from another — would otherwise be answered with Findings
  attributed to someone else. The sides always arrive in the pair's order, so a
  pair is never looked up flipped; the same two trees on swapped sides are a
  different key, since stages 2 and 3 and the attribution swap with them.
  Canonicalising and flipping attribution on a hit was rejected: it saves one
  merge in a case that barely occurs, and flipped Findings would be copies.

  The fingerprint is per analyzer: its name, a version bumped with its logic,
  and its toolchain — for the textual analyzer the git version, read once per
  runner. **A hit records a new run, and reconciles the verdict's Findings
  exactly as a run would**, so what it persists is indistinguishable from the
  run it replaces. A verdict cannot name Finding ids alone: reconciliation
  keeps one Finding per conflict and rewrites its evidence on every run, so
  the Finding a verdict named describes whatever content the pair was checked
  at last. The verdict keeps the analyzer's output instead, and a hit hands it
  to the same reconciliation — an open Finding for the same conflict keeps its
  id, `firstSeenAt` and run, nothing is copied, and the pair's other open
  Findings are resolved. The scheduler decides escalation on whether the merge
  was clean, so a verdict also names the run it came from, whose merge outcome
  the hit reuses; the entry lives as long as that run.
  `infra-failure`, `timeout` and `skipped` are never cached, and neither is a
  run that was superseded or threw.

  **Done when:** through a recording runner, a pair whose content goes X → Y → X
  runs no git at all the third time, and one re-run after a restart runs no
  capture, commit, merge or analyzer; a bumped analyzer version, a new git
  version, a different merge base and swapped sides each miss; a hit keeps an
  open Finding's id and `firstSeenAt` with the cached content's evidence, not
  the last run's, and traces through `causedBy` to the run it reused;
  `infra-failure`, `timeout`, `skipped` and `SNAPSHOT_STALE`
  leave nothing cached; any schema change is a migration shown idempotent; and
  a hit against a full run on a real repository is timed, both numbers in
  `log.md`.
  **Constraints:** Findings stay traceable through `causedBy`. The in-memory
  de-duplication stays in front of the cache, which it is cheaper than. Nothing
  in the daemon calls `prune` yet, so no retention window reaches this or any
  other table; wiring one is the Retention task.

- [x] **Verdict fingerprint names the build**
      **Files:** `packages/daemon/src/scheduler/run-pipeline.ts`, `packages/daemon/src/store/verdict-key.ts`
      **What:** key cached verdicts on the Interlock build as well as the analyzer's own version, so an upgrade never serves a verdict an older build reached.
      **Done when:** a verdict cached by one build misses under another, and one unchanged build still hits across a restart.
      **Constraints:** the cache outlives upgrades, and its only guard today is `Analyzer.version`, bumped by hand. The textual verdict also depends on the classifier, `speculative-merge.ts` and the shadow's merge config — `merge.conflictStyle` among them — none of which touch that number, so a fix that forgets the bump keeps serving the old answer for every pair already judged, across restarts, until its content changes. The build version is the backstop; the analyzer version stays for changes between releases. The cost is one re-verification pass per upgrade.

  Done as a digest of the modules of `@interlock/core` and `@interlock/shared`
  rather than a version number: the version is `0.0.0` for every build between
  releases, and those are the builds a classifier gets fixed in. Core holds the
  merge, the classifier and the shadow's merge config; shared holds the
  redaction every excerpt goes through and the models a Finding is made of. Any
  change in either, a comment included, is a miss.

- [ ] **False-positive budget**
      **Files:** `packages/daemon/src/store/`, `packages/core/src/advisor/`
      **What:** count findings raised, findings delivered, and findings later dismissed or resolved as wrong. Expose the ratio.
      **Done when:** the daemon can report its own false-positive rate for a time window, and `interlock status` shows it.
      **Constraints:** the design rule is **when unsure, say nothing**. A tool that catches 60% of conflicts and never lies is a product; one that catches 95% and cries wolf twice a day is uninstalled within a week. Every false positive is a bug with an issue, not a tuning parameter. Decide what a dismissal means before counting one: reconciliation matches open Findings only, so today a dismissed conflict is raised again as a new Finding on the pair's next run — or cache hit, which reconciles the same way — and a dismissal lasts one run.

- [ ] **Show a shadow collection in `interlock status`**
      **Files:** `packages/daemon/src/api/`, `packages/cli/src/commands/status.ts`, `packages/cli/src/render.ts`
      **What:** while a repository's shadow is repacked its checks are held off, and today only the daemon's log says why an edit's warning is late. Surface a collection in progress, and the last one's pause, per repository.
      **Done when:** `interlock status` names a repository whose checks are held for a collection, with how long it has been; `--json` carries the same; the API carries it without a store migration, since it is live state.
      **Constraints:** read the pause from the registry's own measure (`pausedMs`), not a guess. Worth doing once the bench records the pause at the default window: under realistic load it measured about a second.

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
