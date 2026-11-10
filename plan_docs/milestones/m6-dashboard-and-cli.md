# M6 — Dashboard and CLI

**Goal:** The thing people can see.

**Exit criteria:** a stranger follows the README quickstart on a fresh machine
and reaches a live conflict heatmap in 10 minutes or less. The UI updates within
a second of a Finding.

**Depends on:** M5.

## Tasks

- [ ] **Expand this milestone before starting it**
      **Files:** this file
      **What:** the tasks below are one line each. Rewrite them to the depth of `m1-watcher-and-git-core.md` — per-task edge cases, failure modes, the tests each needs, and the constraints it can breach by accident.
      **Done when:** every task below carries a `Done when` naming an observable check, and nothing in it contradicts what earlier milestones learned.

- [ ] **Bring the dashboard back into the build**
      **Files:** `packages/dashboard/package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`
      **What:** install react, react-dom, vite, `@vitejs/plugin-react`, the type packages, jsdom and testing-library, then re-add the package to the workspace, the solution tsconfig and the Vitest projects. It was excluded from all three because it declared no dependencies.
      **Done when:** `pnpm verify` passes with the dashboard included.

- [ ] **Branch map**
      **Files:** `packages/dashboard/src/`
      **What:** what is in flight per repo, with dirty state and owning session.

- [ ] **Conflict heatmap**
      **Files:** `packages/dashboard/src/`
      **What:** the pairwise grid. This is the screenshot the product is sold on.

- [ ] **Finding detail**
      **Files:** `packages/dashboard/src/`
      **What:** both diffs, the symbol trail, analyzer output, and which branch introduced which half.
      **Done when:** a developer can decide what to do without leaving the page.

- [ ] **Event timeline**
      **What:** the `causedBy` chain, rendered. Walk a Finding back to the edit that caused it.

- [ ] **WebSocket updates**
      **Files:** `packages/daemon/src/api/`, `packages/dashboard/src/lib/api.ts`
      **Done when:** a Finding appears without a refresh, under a second.

- [ ] **`interlock init`**
      **Files:** `packages/cli/src/commands/`
      **What:** set up a repo including agent hooks and the MCP config.
      **Done when:** under two minutes on a repo the tool has never seen.

- [ ] **Daemon UX**
      **Files:** `packages/cli/src/commands/daemon.ts`, `packages/cli/src/autostart.ts`,
      `packages/daemon/src/daemon.ts`, `packages/daemon/src/data-dir.ts`,
      `packages/daemon/src/purge.ts`, `packages/daemon/src/log-file.ts`,
      `packages/daemon/src/main.ts`, `packages/shared/src/errors.ts`,
      `packages/cli/test/daemon.test.ts`
      **What:** `interlock daemon start|stop|status|logs`, `autostart on|off`, and
      `stop --purge` as the kill switch. Moved ahead of the rest of M6 on purpose:
      it depends on nothing in M3, and the M2 demo and dogfooding need a daemon
      that runs in the background and can be turned off.
      **Done when:** someone can turn it off and reclaim all disk without reading
      docs — every case below has a test, and `pnpm verify` and
      `pnpm test:untouched` pass.

  **Who is running is the data-dir hold, never the runtime file.** `holdDataDir`
  already turns a second daemon away and is released by the kernel however the
  process dies; the runtime file only says where a daemon listens and outlives a
  crash. A probe asks whether the hold is held without taking it and without
  creating anything: no lock file is "not running", and a read-only open that
  answers `SQLITE_BUSY` is "held". Running means three things agree: the hold is
  held, `GET /api/health` answers with the token, and the pid it reports is the
  pid in the runtime file. Held but unconfirmed is its own state and is said as
  such — never guessed into either of the others.
  - Test: a runtime file naming a dead port, with nothing holding the lock, reads
    as not running; `start` then starts.
  - Test: a runtime file naming a live process that is not the daemon — the
    test runner, or a child it spawned — and `stop` signals nothing and says so.

  **`start` launches detached and never reports a daemon that died.** `spawn` of
  `process.execPath` and the daemon's resolved entry point, an argument array,
  never `sh -c` and never `pnpm exec` (which installs as a side effect).
  `INTERLOCK_DATA_DIR` is passed on. stdout and stderr go to the log file, so the
  JSON error record `main.ts` writes before it has a logger lands there. The
  handshake waits for whichever comes first: the child exiting, or the runtime
  file naming the child's pid and the port answering; with a timeout. A child
  that exits first is reported with its own message, code and remedy, read from
  the log written since the spawn. Already running is said and exits 0.
  - Test: start when stopped, start when running (no second process), start with
    a stale runtime file, and a start that fails on an invalid config printing
    its remedy and exiting non-zero.
  - Breach risk: the hold is only taken by the child, so two `start`s racing both
    spawn; the second child is turned away by the hold and reports that, which is
    the behaviour wanted.

  **`stop` confirms before it signals.** The pid comes from the API and the
  runtime file, and the hold must be held; any disagreement is "not this data
  dir's daemon" and nothing is signalled. SIGTERM, then wait for the hold to be
  released and the pid to be gone, with a timeout that is reported rather than
  escalated to SIGKILL. Not running exits 0.

  **`status` reports and its exit code says which.** Running (0) shows pid,
  port, uptime, data dir and protocol version, and flags a protocol that differs
  from the CLI's; not running exits 69. `--json` carries the same facts, and
  `--help` documents the codes.

  **`logs` formats, it does not trust.** One JSON record per line, written by a
  size-capped sink in the daemon (one previous file kept, 0600). `-n <lines>`,
  `--follow` (survives a rotation) and `--json`. Every field goes through
  `safeText` before the terminal; a line that is not JSON — a crash trace — is
  shown escaped, and in `--json` wrapped as `{"raw": …}` so the output stays one
  JSON value per line.
  - Test: a record carrying ESC, C1 and a bidi control reaches stdout escaped in
    both modes.

  **Autostart is opt-in and names absolute paths.** A launchd agent on macOS
  (`launchctl bootstrap gui/<uid>`), a systemd user unit on Linux
  (`systemctl --user enable --now`); both carry `INTERLOCK_DATA_DIR` and the
  absolute node and entry paths, never `PATH`. `off` and purge unload and delete
  what `on` installed and nothing else. Commands run through an injected runner,
  so the suite never loads anything; the generated files and argv are asserted on
  both platforms. Loading a real agent is checked once by hand on macOS and
  recorded in the log.
  - Breach risk: a data dir with a quote, `%`, `$` or newline in it must not
    change the unit's meaning — escaped, or refused when it cannot be.

  **Purge deletes Interlock's directory and nothing reachable from it.** The
  deletion lives in the daemon package beside `holdDataDir`; `Daemon.purge()`
  and the CLI both use it. Order: refuse first — a data dir resolving to `/` or
  the home directory, one without the lock file Interlock writes on every start,
  one holding entries Interlock never writes, one inside a watched repository —
  then stop, remove autostart, take the hold so nothing starts mid-purge, delete,
  release. The walk `lstat`s every entry and unlinks links rather than following
  them, so a shadow's alternates, a pool slot's worktree link or a planted
  symlink never lead it into a repository. It reports the bytes reclaimed. It
  asks for confirmation on a terminal and refuses without one unless `--yes`.
  - Test: every refusal before any deletion test; the watched repository hashed
    before and after a purge with a real shadow and pool, identical; a symlink
    in the data dir pointing out of it, its target untouched; start after purge.
  - Never weaken a purge check to get a test through: a deletion bug here is
    unrecoverable.

- [ ] **`interlock doctor`**
      **What:** diagnose git, Docker, toolchain and permissions.
      **Done when:** each failure names the fix, not just the fault.
