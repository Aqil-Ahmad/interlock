# Interlock

**Early conflict detection and integration intelligence for parallel AI coding agents.**

> Status: scaffold. Structure, contracts and docs are in place; implementations are landing.

## The problem

Developers now run several AI coding agents at once, each in its own worktree or branch. Those parallel streams collide, and the collisions are discovered at merge time — after hours of agent work have already been spent. Around 28% of AI-agent PRs hit merge conflicts.

Worse are the conflicts git cannot see. Branch A renames an exported function and updates its call sites. Branch B adds a new call to the old name. Both branches build green. The merge is clean. The merged result does not compile — and nobody finds out until CI, or later.

## What Interlock does

A local background service that:

1. **watches** every in-flight branch and worktree on your machine, read-only;
2. **speculatively merges** each pair in hidden shadow worktrees, continuously;
3. **detects** textual conflicts and semantic ones — merges cleanly but breaks the typecheck, the build, or a test — using a sandboxed toolchain and cross-branch AST analysis;
4. **tells the agents** through an MCP server, while they are still working;
5. **recommends a landing order** across N branches that minimises conflict cascades.

It detects, explains and advises. It never resolves conflicts for you or writes to your branches.

## Safety

Enforced by types and tests, not promises:

- **Your repositories are never modified.** No writes to your worktrees, branches, index, stash or config — all git writes go to Interlock's own shadow clones.
- **Merged code never runs on your host.** Speculatively-merged agent code is untrusted; it executes only in Docker with no network, no root and hard resource limits.
- **Nothing leaves your machine.** Loopback-only services with a bearer token. No telemetry.

## Quickstart

```bash
git clone https://github.com/interlock-ai/interlock.git && cd interlock
./scripts/setup.sh          # checks prerequisites, installs, verifies
pnpm build
alias interlock="node $PWD/packages/cli/dist/main.js"
```

Tell the daemon which repositories to watch, then run it in the background:

```bash
mkdir -p ~/.interlock
echo '{ "repos": ["/path/to/your/repo"] }' > ~/.interlock/config.json

interlock daemon start           # detached; logs to ~/.interlock/daemon.log
interlock status                 # in-flight branches, dirty state, agent sessions
interlock check feature-a feature-b   # merge a pair now and print what conflicts
interlock daemon logs --follow   # what the daemon is doing
interlock daemon autostart on    # start it at login (launchd or systemd)
```

Turning it off:

```bash
interlock daemon stop            # stop it
interlock daemon stop --purge    # stop it, remove autostart, delete everything Interlock stored
```

`INTERLOCK_DATA_DIR` points every command and the daemon at another data directory.

Still to come: `interlock init` to set up a repository and its agent hooks, and the dashboard.

## Repository layout

```
packages/
  shared/        types, models, events, config, errors, logging   (leaf; depends on nothing)
  core/          git + shadow ops, speculative merge, analyzers, ranking
  daemon/        watcher, event bus, scheduler, SQLite store, localhost API
  mcp-server/    agent-facing MCP tools
  cli/           the `interlock` command
  dashboard/     React UI (branch map, conflict heatmap, evidence)
eval/            evaluation harness, outside the workspace
docs/            architecture and threat model
scripts/         setup, benchmarks
```

## Documentation

| Document                                     | What it is                                    |
| -------------------------------------------- | --------------------------------------------- |
| [docs/architecture.md](docs/architecture.md) | components, data flow, lifecycle of a Finding |
| [docs/threat-model.md](docs/threat-model.md) | assets, trust boundaries, residual risks      |
| [CONTRIBUTING.md](CONTRIBUTING.md)           | branch model, checks, CLA                     |
| [CLAUDE.md](CLAUDE.md)                       | working agreement and hard rules for changes  |

## Limitations (v1)

- Single developer, single machine. No team or cloud mode.
- Linux and macOS only.
- Semantic detection covers TypeScript and JavaScript. Other languages get textual conflict detection only.
- Semantic detection requires Docker.
- Detects and explains; never resolves.

## Requirements

Node ≥ 24, pnpm 11, git ≥ 2.41, Docker for the semantic analyzers.

Every speculative merge runs `git merge-tree` against a given base, with the
repository's attributes read from a commit rather than a checkout — flags from
git 2.40 and 2.41. macOS ships 2.39 at `/usr/bin/git`; install a newer one —
Homebrew's, for instance — and put it first on `PATH`.

On Linux, not Node 26.9.0. Its recursive directory watcher throws `EACCES` from
inside Node's own event callback when a watched directory becomes unreadable —
an unmounted volume, a permission change — and nothing outside Node can catch
it, so the daemon stops. Node 26.8 and earlier are unaffected, as is macOS.

## License

Dual-licensed: [AGPL-3.0-only](LICENSE_AGPL) by default, commercial terms for
organisations that cannot accept the AGPL. Resolution rules in
[LICENSE.md](LICENSE.md).
