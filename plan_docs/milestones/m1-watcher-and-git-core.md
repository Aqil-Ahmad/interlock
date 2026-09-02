# M1 — Watcher and git core

**Goal:** Interlock can see everything in flight, without touching it.

**Exit criteria:** with three worktrees under active edit, `interlock status`
shows live branches, their dirty state and touched files, updating within
seconds — and a test proves user-repo state hashes are identical before and
after a full run.

**Depends on:** M0.

Read `plan_docs/README.md` § Definition of done before starting. It applies to
every task here and is not repeated per task.

## Tasks

- [x] **Git runner**
      **Files:** `packages/core/src/git/repo-handle.ts`, `repo-handle.test.ts`, `packages/core/test/git-runner.test.ts`
      **What:** the `GitRunner` implementation behind the existing interface.

  Build it on `execFile` with an argument array — never a shell, never string
  interpolation into a command. Take the repo from the handle and pass `-C
<path>` rather than changing process directory, because the daemon watches
  several repos concurrently and `process.chdir` is global. Set
  `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` and an empty
  `GIT_CONFIG_GLOBAL` so a user's global config cannot change behaviour — noting
  that this reaches global and system config only, and repository-local
  `.git/config` still applies. Classify commands with an **allowlist** of
  read-only operations, so an unfamiliar verb is refused by default; a denylist
  fails open on `read-tree --reset` and `update-ref`, which rewrite the index
  and move refs without looking like writes. Allowlist **flags** the same way for
  the verbs where a flag decides the class: `read-tree -u` writes the working
  tree, `--index-output` overrides the redirected index, `update-index
--split-index` writes into `$GIT_DIR`, and `symbolic-ref -d` deletes a ref while
  taking one operand. Match long flags by prefix, since git resolves any
  unambiguous abbreviation, and short flags per character, since git bundles
  them. Return output verbatim and redact
  only what is logged — callers parse this output, and rewriting a path or an
  object id that matches a secret pattern corrupts it silently. Apply a timeout
  and a max buffer; a hung `git` must not wedge the daemon.

  **Done when:** a branch literally named `--upload-pack=touch /tmp/pwned`
  cannot execute anything, proven by a test; a table-driven test refuses a
  corpus of writing verbs against a `UserRepo`, including the plumbing writers a
  denylist misses; an unrecognised verb is refused by default; a writing flag is
  refused under both its full spelling and its abbreviation, asserted against the
  damage rather than the message; every flag in the allowlist is checked against
  `git <verb> -h` so an invented name cannot widen it; and a command exceeding
  its timeout is killed and reported as a timeout rather than as any other signal
  death.
  **Constraints:** hard rule 1. This function is the only place git is invoked,
  so it is the only place the read-only promise can be broken.

- [x] **Repo discovery**
      **Files:** `packages/core/src/git/discovery.ts`
      **What:** `openUserRepo`, `describeRepo`, `listBranchRefs`, `mergeBase`.

  `openUserRepo` resolves the repository a path belongs to and rejects a
  non-repository with `REPO_NOT_GIT` rather than throwing raw, a missing path
  with `REPO_NOT_FOUND`, and a bare one with `REPO_BARE`. `--show-toplevel`
  answers with the _worktree_, so a repository opened through a linked worktree
  would get a second identity and a second shadow clone; the root is the main
  worktree, which git lists first from anywhere in the repository.
  `listBranchRefs` must include linked worktrees from `worktree list
--porcelain`, not just `branch --list` — a branch checked out in another
  worktree is the normal case here, not an edge case. Handle: a repo with no
  commits, a detached HEAD, a worktree whose directory has been deleted but
  whose administrative file remains, and a bare repository. `mergeBase` returns
  `null` only for refs with no common ancestor, which git reports as exit 1; a
  ref it cannot resolve exits 128 and raises, because a silent `null` would drop
  the pair from analysis.

  Ignore patterns come from the repository's own `.interlock.json`, which the
  agents Interlock watches can write, and so do the branch names they are
  matched against. Match them by scanning, not by translating to a regex: a
  pattern alternating wildcards with literals backtracks exponentially, and the
  match runs on the event loop for every branch.

  A worktree that is listed is not necessarily readable — `worktree lock` keeps
  a worktree on a removable volume from being pruned, so a missing directory is
  listed as locked rather than prunable. `dirty` is `null` there. One
  unreachable worktree must not fail the listing, and must not read as clean.

  **Done when:** an integration test builds a repo with two linked worktrees, a
  detached HEAD and an unborn branch, and every function returns correct results
  or a typed error for each; opening the repository through a linked worktree
  yields the same handle as opening it at its root; and a pathological ignore
  pattern completes in milliseconds.

- [x] **Repo config override**
      **Files:** `packages/core/src/git/discovery.ts`, `packages/shared/src/config.ts`
      **What:** read `.interlock.json` from the repository root into `Repo.config`.

  `describeRepo` returns an empty `config` today, so "no overrides" and "not
  read yet" are indistinguishable. The file is repository content: validate it
  against the schema and reject anything unexpected rather than trusting it, and
  treat `ignoreBranches` as hostile input — it reaches a regex.

  **Done when:** a repo with no file, a valid file and a malformed file each
  produce the right result, and the malformed one names what is wrong.

  Reading the file into `Repo.config` is where this task ends. Neither
  `config.ignoreBranches` nor `config.ignore` is applied anywhere yet —
  `listBranchRefs` takes its own option and the watcher does not exist — so a
  repository's rules are stored and not yet honoured. The watcher wires both.

- [x] **Dirty-state snapshots**
      **Files:** `packages/core/src/git/worktree.ts`
      **What:** `captureDirtyState` — turn uncommitted work into a tree object
      without touching the user's index.

  Pass `indexFile` to the git runner so staging targets a temp index outside the
  repo, populate it, then `write-tree`. The runner validates that path through
  `realpath` and refuses one that lands inside the worktree, its git dir, or the
  git dir a linked worktree shares with the main checkout — so `mkdtemp` a
  directory first and join the filename onto it; a path whose parent does not
  exist is refused as unverifiable. `read-tree -u` and `--index-output` are
  refused outright: the first writes the working tree, which no index
  redirection protects, and the second overrides the redirection. Objects land in the user's object database, which is additive and
  safe; the index never is. Untracked files are included, ignored files are not.
  A clean worktree returns the HEAD tree and does no work. The temp index is
  removed on the error path as well as the success path.

  Two paths, because `add -A` over a whole worktree is not free and sits on the
  hot path of every debounced event:

  - **Scoped (common):** `read-tree <previous snapshot's tree>` to seed the temp
    index, then `add -A -- <paths the watcher reported>`, then `write-tree`.
    This turns a whole-tree scan into a change-sized one. **The seed is the
    previous snapshot, not `HEAD`** — seeding from `HEAD` drops every
    uncommitted change outside the reported paths, which is a tree that is wrong
    rather than merely stale, and staging into an empty index is worse still: a
    tree holding only the reported paths. A scoped capture is therefore only
    expressible with the tree it extends.
  - **Whole-tree (fallback):** seed from `HEAD` and `add -A` with no pathspec —
    the first snapshot for a worktree, whenever the watcher has degraded to
    polling, and whenever the base tree has been collected. Seeding from `HEAD`
    rather than an empty index also keeps a file that is tracked despite
    matching `.gitignore`, which a rebuild from the worktree alone would drop.

  Filter the reported paths through `status --porcelain -z` against the seeded
  index, reading only the worktree column. Two separate mistakes live here.
  Asking the _user's_ index answers "is this path dirty relative to HEAD", and a
  file the user reverted answers no — so the capture keeps a base tree still
  holding the edit, wrong rather than stale, the failure the seed was fixed to
  avoid. Reading the _index column_ of the right index is the mirror: it
  compares that index against `HEAD`, so a deletion already absorbed reports
  `D` in every later batch, and restaging it finds nothing on disk and nothing
  in the index, which `git add` treats as fatal. Seed first, filter second, and
  read the worktree column only.
  `git add` refuses a path it is told to add that is ignored, and fails outright
  on one matching nothing — a file created and deleted inside a debounce window.
  Both are ordinary watcher output and both would fail the capture; `status`
  reports neither. Repository config is the layer environment scrubbing cannot
  reach, and `core.splitIndex` puts a `sharedindex.*` file in the user's
  `$GIT_DIR` on every index write whatever `GIT_INDEX_FILE` says — so a fixture
  setting it is part of proving the repository was left alone.

  Both halves of a rename have to be reported, because a pathspec narrows git's
  rename detection too. Paths are worktree-relative, and one that escapes is
  refused by name rather than filtered away or left to fail as an error about
  git — and they reach git as literal names, since a leading `:` would otherwise
  be read as pathspec magic.

  Objects written this way are unreferenced until something points at them, so a
  user running `git gc --prune=now` can collect a tree Interlock is still holding.
  Treat a missing-object error on a stored tree OID as "re-snapshot", not as a
  crash.

  **Done when:** an integration test creates a worktree with staged, unstaged
  and untracked changes plus a `.gitignore`d file, snapshots it, and asserts the
  tree contains the first three and not the fourth — then asserts `git status
--porcelain`, the index mtime and `.git/index` contents are byte-identical to
  before. A second test kills the operation between `add` and `write-tree` and
  asserts the same.

  Assert too that a scoped capture and a whole-tree capture of the same worktree
  produce the same tree. User-state integrity says nothing about whether the
  tree is right, and that is the half a scoped capture can get wrong.

  Read the index with `fs` and before running any git command in the assertion:
  `git status` rewrites `.git/index` to refresh its stat cache, leaving the
  contents identical and moving the mtime, so an observation interleaved with
  the measurement is what fails the assertion.
  **Constraints:** this is the most dangerous function in the codebase. If it
  writes the user's index, Interlock has corrupted work in progress that was
  never committed and cannot be recovered.

- [x] **ChangeSet extraction**
      **Files:** `packages/core/src/git/diff.ts`
      **What:** `extractChangeSet`, `touchedPaths` — normalised diff against the
      merge-base.

  Parse `diff --numstat -z` and `diff --name-status -z` with NUL separation, not
  newlines, so paths containing spaces or newlines survive. `--name-status`
  reports a rename **source first**, the reverse of `status --porcelain -z`.
  Pass `--find-renames` explicitly: rename detection is configurable per
  repository, and `diff.renames = copies` makes git emit copy pairs where an
  addition belongs while `false` removes pairing altogether — a watched
  repository must not decide the shape of what Interlock records. Both forms are
  computed internally, so neither runs a repository's `diff.external` or
  `textconv` driver. Any diff that produces a **patch** does, and repository
  config is the layer the runner's environment scrubbing cannot reach — a
  patch-producing diff needs `--no-ext-diff` and `--no-textconv`. Handle renames
  (`-M`), copies, mode changes, binary files (no hunks, flagged) and deletions.
  Symbol extraction stays empty until M4 — leave the field, do not guess.

  **Done when:** a fixture with a renamed file, a binary file, a mode change and
  a path containing a space produces the same file list as `git diff` for the
  same range, and the hunk counts match — per file and in total, since hunks
  attributed to the wrong file still agree file by file when one gains what
  another loses. Compare against git rather than against literals. Name both
  paths of a rename when asking git for one file's hunks: a pathspec narrows
  rename detection, so scoped to the destination git counts a hunk for content
  that never changed.

- [x] **SQLite store**
      **Files:** `packages/daemon/src/store/`
      **What:** `openStore` plus migration 001 covering every entity in
      `shared/models`.

  Confirm `node:sqlite` before adding a dependency — it is built into Node 24
  and keeps `core` dependency-free. Record the choice in ADR-0003 either way.
  Enable WAL and foreign keys. Migrations run inside one transaction and are
  append-only; 001 must run against both an empty database and one that already
  has it. The data dir is 0700 and the database file 0600 — an executable bit
  means nothing on a database, and the mode has to be set before WAL is enabled,
  because SQLite gives the `-wal` the mode the database file has at the time and
  that file holds rows the database does not yet. Store spans and truncated
  excerpts, never full file contents, never secrets.

  An upsert on a natural key returns the reconciled row rather than nothing. The
  stored id is the one that won, and the caller's next write references it — so
  a `void` return would hand back a repository whose branches all orphan. What
  is preserved on conflict follows from the same reasoning: `discoveredAt` and
  `firstSeenAt` describe the first sighting rather than this one, and
  `Repo.shadowPath` is derived from the id that won, so the incoming value names
  a directory built from a ULID that was discarded.

  Upsert on the natural key, not on the id: discovery mints a fresh ULID per
  observation, so `repos` reconciles on `rootPath` and `branch_refs` on
  `(repoId, ref)`. Keying on the id instead would insert a duplicate row every
  time the watcher re-lists a branch.

  `Repo.config` is a stored copy of a file that changes underneath it, so the
  row is a cache rather than the truth. Whatever re-reads `.interlock.json` has
  to be able to update it in place, keyed on `rootPath` like the rest.

  `BranchRef.dirty` is nullable, and `null` — the worktree could not be read —
  must survive the round trip as itself rather than as a clean state. A schema
  that folds the two together loses the distinction permanently, since nothing
  re-reads a branch that reported no changes.

  `BranchRef.sessionId` gets no column. Discovery re-lists every branch with no
  session attached, so a stored copy is cleared by the next sweep and
  attribution never survives one. Sessions own the link, and the branch reads it
  back from `agent_sessions`, most recently active live session first.

  **Done when:** the daemon restarts and reproduces its previous state; listing
  the same branch twice leaves one row, not two; a branch stored with an unknown
  dirty state reads back unknown rather than clean; a test runs migrations twice
  and asserts idempotency; a test asserts the file mode, of the sidecars as well
  as the database; and `readEvents(since)` replays in ULID order across a
  restart.

- [x] **Watcher: filesystem and ref events**
      **Files:** `packages/daemon/src/watcher/`
      **What:** debounced filesystem and git-ref signals, published as
      `worktree.changed`.

  Ignore `.git/` internals except `refs/` and `HEAD`, and honour `.gitignore` —
  watching `node_modules` is the difference between 2% CPU and 100%. A linked
  worktree's `.git` is a file pointing into `<main>/.git/worktrees/<name>`, and
  its `refs/` live in the main git dir while its `HEAD` does not, so ref
  watching follows `gitDir` rather than assuming `<root>/.git`.

  Apply `config.ignore` to the paths this watches. `*` in a branch glob crosses
  `/`, so `src/*` matches `src/deep/file.ts`; that is right for branch names and
  wrong for the path intuition `.gitignore` teaches, so this needs a path-aware
  matcher or a documented difference — not the branch matcher reused silently.
  Match by scanning rather than by translating to a regex: the patterns are
  repository content.

  Debounce per worktree, not globally, and coalesce a burst of writes into one
  event. Handle the editor patterns that break naive watchers: atomic
  rename-over-file, a directory being deleted while watched, and a file count
  that exceeds the OS watch limit, which must degrade to polling with a warning
  rather than crashing.

  Resolve watched paths with `realpath` before comparing them to anything from
  discovery: git reports canonical paths, so on macOS a worktree registered as
  `/var/...` arrives from git as `/private/var/...` and naive comparison never
  matches. Recursive `fs.watch` on macOS also reports an event naming the
  watched directory itself, which is not a change inside it.

  **Done when:** an edit produces exactly one debounced event; a burst of writes
  inside the debounce window produces one, not one each; a `git commit` produces
  a ref event; a write under an ignored path produces none; and a worktree whose
  directory is deleted while watched stops cleanly instead of throwing.

- [ ] **Watcher: reconciliation sweep and repository rules**
      **Files:** `packages/daemon/src/watcher/`, `packages/daemon/src/store/`
      **What:** the periodic pass that reconciles discovery against the store.

  Filesystem events are lossy on macOS, so a sweep runs alongside them rather
  than instead of them. It applies `config.ignoreBranches` to `listBranchRefs`,
  which together with the previous task is what finally makes a repository's own
  rules mean something — both are read into `Repo.config` already and applied
  nowhere.

  **Re-read `.interlock.json` when it changes.** `describeRepo` reads it once,
  at first sighting, and the stored `Repo.config` is the last word after that —
  so a repository that adds a branch to `ignoreBranches` mid-session is never
  honoured, and changing an override means deleting the stored row. The two
  failure modes are asymmetric in the wrong direction: refusing a malformed file
  is loud and reachable once, while serving a stale one is silent and permanent.
  A refusal on re-read keeps the last good config and surfaces the problem; it
  must not take the repository out of the watch set.

  **The store has no deletion path, and this is where it is needed.** Upserts
  reconcile on the natural key, so a branch that stops existing keeps its row,
  its merge pairs and its change sets forever — and `prune` deliberately keeps
  each branch's newest change set, so retention never reaches them either.
  Removing a branch takes its pairs and change sets with it by cascade, and
  `branch.disappeared` is the event that drives it.

  **Contain a failing repository to itself.** `describeRepo` throws
  `CONFIG_INVALID` for one repository's broken file, and discovery reads
  repositories in a sweep. One bad `.interlock.json` must not stop the others,
  the same way one unreachable worktree does not stop the branches beside it.

  **Done when:** a branch created between sweeps appears; one deleted disappears
  and takes its pairs and change sets with it; a repository whose
  `.interlock.json` becomes malformed keeps its last good config, stays in the
  watch set and does not stop the repositories beside it; a branch added to
  `ignoreBranches` mid-session stops being reported without a restart.

- [ ] **Watcher: snapshot pipeline and the numbers**
      **Files:** `packages/daemon/src/watcher/`, `packages/shared/src/events/`
      **What:** `branch.snapshot`, carrying `{ branchRef, treeOid, changeSet }`.

  Two events at different levels. `worktree.changed` is the raw filesystem
  signal, kept for replay and debugging; `branch.snapshot` is what downstream
  actually consumes, because it keys off content identity rather than filesystem
  noise. The event does not exist in the vocabulary yet and is a wire format
  once published.

  Cache the last tree OID per worktree and drop the event when a debounce
  produces the same OID. A worktree whose dirty state came back `null` has no
  OID to compare, so it is never deduplicated against — `contentIdentity`
  returns `null` there for the same reason, and a cache keyed on the head alone
  would reuse a result computed from a tree nobody read. Editors and agents both
  write files that end up byte-identical, and the saving is not the snapshot
  itself but everything after it: ChangeSet extraction, scheduling, and every
  pair that would be marked stale.

  Decide the per-`status` timeout here, with the latency numbers in hand rather
  than ahead of them. Discovery reads worktrees serially and a `status` on an
  unreachable one — a stale network mount, not a deleted directory — burns the
  runner's full default before returning unknown, so one pathological repo can
  dominate a sweep. Guessing a shorter bound now would trade that for the worse
  failure: a slow but working worktree reported as unreadable.

  **Done when:** a rewrite that leaves content unchanged publishes no
  `branch.snapshot`; a real edit publishes exactly one carrying a ChangeSet; a
  worktree that cannot be read publishes one with a null tree rather than being
  deduplicated against the last good one; and two numbers are in `log.md` —

  - **idle** CPU with three worktrees on a repo of at least 10,000 files, which
    must stay under 2%;
  - **active** CPU and per-event latency while a script rewrites files in three
    worktrees continuously for 60 seconds, reported as p50 and p95 from write to
    `branch.snapshot` published.

  The active number is the one M2's scheduler budget is built on. Idle only
  proves the watcher is not spinning.

  Measure both on a quiet machine, not in CI. A shared two-core runner with CPU
  steal produces a p95 that describes the runner. CI benchmarking is regression
  smoke — did something get an order of magnitude worse — and belongs on a
  schedule with a wide noise floor, never as a required check on a pull
  request.

- [ ] **Daemon skeleton and localhost API**
      **Files:** `packages/daemon/src/daemon.ts`, `packages/daemon/src/api/`
      **What:** `createDaemon` wiring watcher → bus → store, and the routes
      already listed in `api/index.ts`.

  Bind `127.0.0.1` explicitly — never `0.0.0.0`, never a bare port. Take port 0
  and read back what the OS assigned: vitest runs files in parallel workers, and
  two of them binding the same fixed port is a flake that appears once, under
  load, and never reproduces locally. Generate a
  bearer token at first start, store it 0600, require it on every route
  including the WebSocket upgrade. Shut down cleanly on SIGINT and SIGTERM:
  stop the watcher, drain in-flight work, close the store.

  **Done when:** a test asserts the listener address is `127.0.0.1`; a test
  asserts an unauthenticated request gets 401 on every route; and SIGTERM during
  an in-flight operation leaves no temp files and a readable database.
  **Constraints:** hard rule 3. A regression here is a vulnerability that
  exposes the user's source over the network, not a bug.

- [ ] **`interlock status`**
      **Files:** `packages/cli/src/commands/`
      **What:** the first real command — branches, dirty state, touched files.

  Read-only, talks only to the daemon API. When the daemon is not running, say
  so and give the command to start it — `DAEMON_UNREACHABLE` with a `remedy`.
  Exit codes: 0 for clean, non-zero for an error, and decide now whether open
  findings are a non-zero exit, because scripts will depend on it.

  A branch whose dirty state is `null` is unknown, not clean, and must read that
  way — an unreachable worktree is the one case where the display saying
  "nothing to see" is actively misleading.

  **Done when:** it renders correctly against three worktrees, shows an
  unreadable worktree as unknown rather than clean, prints an actionable error
  with the daemon stopped, and its exit codes are covered by tests.

- [ ] **Agent session hooks**
      **Files:** `packages/daemon/src/hooks/`
      **What:** `registerSession`, `renderHookScripts` — map an agent session to
      the branch it is driving.

  Hook input is untrusted: it arrives from a process Interlock does not control.
  Validate it against the schema and reject anything unexpected. Fall back to
  best-effort detection when hooks are absent, and mark those sessions as
  inferred rather than reported, because attribution quality changes what the
  advisor is allowed to claim.

  Reaping needs a stated mechanism, because agent processes exit in ways that
  never fire a hook: check PID liveness on read, and expire any session whose
  last heartbeat is older than a configured timeout. Neither alone is enough — a
  PID can be reused, and a wedged process still holds its PID.

  **Done when:** a session registers and `interlock status` shows which agent
  owns which branch; a malformed payload is rejected without crashing the
  daemon; a session whose process was killed is gone within the timeout; and a
  reused PID does not resurrect a dead session.

- [ ] **Enforce the single git call site**
      **Files:** `packages/core/test/`
      **What:** a test that fails if any file outside `packages/core/src/git/repo-handle.ts` imports `node:child_process` or `child_process`.

  A prose rule decays the moment code is being generated across ten files at
  once. Prefer a test over an ESLint rule here: `eslint.config.js` already uses
  `no-restricted-imports` for the layering blocks, and flat config resolves that
  rule last-wins per file, so a new broad block would silently disable the
  layering checks it overlaps.

  **Done when:** the test passes today, and fails if a `child_process` import is
  added anywhere else in `packages/`.

- [ ] **User-repo-untouched test**
      **Files:** `packages/core/test/user-repo-untouched.test.ts`
      **What:** fill in the five todo tests already stubbed there.

  Hash the full worktree, the index, all refs, the stash and the config before
  and after a complete watch-snapshot-discover cycle, and diff them. "All refs"
  means loose refs, `packed-refs`, **reflogs**, `ORIG_HEAD`, `FETCH_HEAD` and
  `MERGE_HEAD` — a stray reflog entry is still a write to the user's repository.
  Run it against a repo in every awkward state the other tasks named: dirty,
  detached HEAD, mid-rebase, with a stash, with submodules. Include a linked
  worktree and hash the git dir it shares with the main checkout, not only its
  own — that shared directory holds the index a redirection must miss, and a
  linked worktree's handle names neither it nor the main checkout.

  The cycle must include a snapshot, so the index-only path — the one place a
  command that writes an index is allowed to run against a user repository — is
  covered rather than skipped.

  If the `.git/index` mtime assertion proves flaky, the honest fix is to assert
  index _contents_ rather than mtime — some git versions rewrite the index to
  refresh its stat cache even on reads. Do not weaken the assertion to make it
  pass. `GIT_OPTIONAL_LOCKS=0` from the git runner task should prevent most of
  this; if it does not, that is worth knowing.

  Give it its own CI job, required, with no retry and a generous timeout. Its
  failure means something wrote to a user's repository, which starts a different
  conversation than a red test job — the check list is where that distinction
  becomes visible. When it fails the first question is _what_ wrote, so print
  which hashes diverged rather than only that they did; the failure output is
  the diagnosis.

  **Done when:** it fails loudly if any byte of user state changes, names the
  state that changed, and runs in CI on every pull request as its own required
  check.
  **Constraints:** this test is the enforcement mechanism for the project's
  central promise. It is never skipped, never weakened, and a failure is a
  release blocker rather than a flake to retry.
