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

- [ ] **Git runner**
      **Files:** `packages/core/src/git/repo-handle.ts`, `repo-handle.test.ts`
      **What:** the `GitRunner` implementation behind the existing interface.

  Build it on `execFile` with an argument array — never a shell, never string
  interpolation into a command. Take the repo from the handle and pass `-C
<path>` rather than changing process directory, because the daemon watches
  several repos concurrently and `process.chdir` is global. Set
  `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` and an empty
  `GIT_CONFIG_GLOBAL` so a user's global config cannot change behaviour.
  Enforce `isMutatingCommand` at runtime against a `UserRepo`, throwing
  `GIT_COMMAND_FAILED` — the type split catches mistakes at compile time, this
  catches them at run time. Redact stdout and stderr before they leave the
  function. Apply a timeout and a max buffer; a hung `git` must not wedge the
  daemon.

  **Done when:** a branch literally named `--upload-pack=touch /tmp/pwned`
  cannot execute anything, proven by a test; every verb in
  `MUTATING_GIT_COMMANDS` is refused against a `UserRepo` by a table-driven
  test; and a command exceeding its timeout is killed and reported.
  **Constraints:** hard rule 1. This function is the only place git is invoked,
  so it is the only place the read-only promise can be broken.

- [ ] **Repo discovery**
      **Files:** `packages/core/src/git/discovery.ts`
      **What:** `openUserRepo`, `describeRepo`, `listBranchRefs`, `mergeBase`.

  `openUserRepo` resolves the root via `rev-parse --show-toplevel` and rejects a
  non-repository with `REPO_NOT_GIT` rather than throwing raw. `listBranchRefs`
  must include linked worktrees from `worktree list --porcelain`, not just
  `branch --list` — a branch checked out in another worktree is the normal case
  here, not an edge case. Handle: a repo with no commits, a detached HEAD, a
  worktree whose directory has been deleted but whose administrative file
  remains, and a bare repository. `mergeBase` returns `null` when two branches
  share no history rather than throwing.

  **Done when:** an integration test builds a repo with two linked worktrees, a
  detached HEAD and an unborn branch, and every function returns correct results
  or a typed error for each.

- [ ] **Dirty-state snapshots**
      **Files:** `packages/core/src/git/worktree.ts`
      **What:** `captureDirtyState` — turn uncommitted work into a tree object
      without touching the user's index.

  Point `GIT_INDEX_FILE` at a temp file outside the repo, `add -A` into that
  index, then `write-tree`. Objects land in the user's object database, which is
  additive and safe; the index never is. Untracked files are included, ignored
  files are not. A clean worktree returns the HEAD tree and does no work. The
  temp index is removed on the error path as well as the success path.

  **Done when:** an integration test creates a worktree with staged, unstaged
  and untracked changes plus a `.gitignore`d file, snapshots it, and asserts the
  tree contains the first three and not the fourth — then asserts `git status
--porcelain`, the index mtime and `.git/index` contents are byte-identical to
  before. A second test kills the operation between `add` and `write-tree` and
  asserts the same.
  **Constraints:** this is the most dangerous function in the codebase. If it
  writes the user's index, Interlock has corrupted work in progress that was
  never committed and cannot be recovered.

- [ ] **ChangeSet extraction**
      **Files:** `packages/core/src/git/diff.ts`
      **What:** `extractChangeSet`, `touchedPaths` — normalised diff against the
      merge-base.

  Parse `diff --numstat -z` and `diff --name-status -z` with NUL separation, not
  newlines, so paths containing spaces or newlines survive. Handle renames
  (`-M`), copies, mode changes, binary files (no hunks, flagged) and deletions.
  Symbol extraction stays empty until M4 — leave the field, do not guess.

  **Done when:** a fixture with a renamed file, a binary file, a mode change and
  a path containing a space produces the same file list as `git diff` for the
  same range, and the hunk counts match.

- [ ] **SQLite store**
      **Files:** `packages/daemon/src/store/`
      **What:** `openStore` plus migration 001 covering every entity in
      `shared/models`.

  Confirm `node:sqlite` before adding a dependency — it is built into Node 24
  and keeps `core` dependency-free. Record the choice in ADR-0003 either way.
  Enable WAL and foreign keys. Migrations run inside one transaction and are
  append-only; 001 must run against both an empty database and one that already
  has it. The file is 0700 under the data dir. Store spans and truncated
  excerpts, never full file contents, never secrets.

  **Done when:** the daemon restarts and reproduces its previous state; a test
  runs migrations twice and asserts idempotency; a test asserts the file mode;
  and `readEvents(since)` replays in ULID order across a restart.

- [ ] **Watcher**
      **Files:** `packages/daemon/src/watcher/`
      **What:** filesystem events plus git ref changes, debounced, publishing
      `worktree.changed`.

  Ignore `.git/` internals except `refs/` and `HEAD`, and honour `.gitignore` —
  watching `node_modules` is the difference between 2% CPU and 100%. Debounce
  per worktree, not globally, and coalesce a burst of writes into one event.
  Handle the editor patterns that break naive watchers: atomic rename-over-file,
  a directory being deleted while watched, and a file count that exceeds the
  OS watch limit, which must degrade to polling with a warning rather than
  crashing.

  **Done when:** an edit produces exactly one debounced event; a `git commit`
  produces a ref event; and idle CPU with three worktrees on a repo of at least
  10,000 files is measured and recorded in `log.md`. If it is above 2%, the task
  is not done.

- [ ] **Daemon skeleton and localhost API**
      **Files:** `packages/daemon/src/daemon.ts`, `packages/daemon/src/api/`
      **What:** `createDaemon` wiring watcher → bus → store, and the routes
      already listed in `api/index.ts`.

  Bind `127.0.0.1` explicitly — never `0.0.0.0`, never a bare port. Generate a
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

  **Done when:** it renders correctly against three worktrees, prints an
  actionable error with the daemon stopped, and its exit codes are covered by
  tests.

- [ ] **Agent session hooks**
      **Files:** `packages/daemon/src/hooks/`
      **What:** `registerSession`, `renderHookScripts` — map an agent session to
      the branch it is driving.

  Hook input is untrusted: it arrives from a process Interlock does not control.
  Validate it against the schema and reject anything unexpected. Fall back to
  best-effort detection when hooks are absent, and mark those sessions as
  inferred rather than reported, because attribution quality changes what the
  advisor is allowed to claim.

  **Done when:** a session registers and `interlock status` shows which agent
  owns which branch; a malformed payload is rejected without crashing the
  daemon; and a session whose process has died is reaped.

- [ ] **User-repo-untouched test**
      **Files:** `packages/core/test/user-repo-untouched.test.ts`
      **What:** fill in the five todo tests already stubbed there.

  Hash the full worktree, the index, all refs, the stash and the config before
  and after a complete watch-snapshot-discover cycle, and diff them. Run it
  against a repo in every awkward state the other tasks named: dirty, detached
  HEAD, mid-rebase, with a stash, with submodules.

  **Done when:** it fails loudly if any byte of user state changes, and it runs
  in CI on every pull request.
  **Constraints:** this test is the enforcement mechanism for the project's
  central promise. It is never skipped, never weakened, and a failure is a
  release blocker rather than a flake to retry.
