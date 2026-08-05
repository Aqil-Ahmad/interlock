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

> Not runnable yet — the scaffold has no implementations.

```bash
git clone https://github.com/interlock-ai/interlock.git && cd interlock
./scripts/setup.sh          # checks prerequisites, installs, verifies
pnpm verify                 # build + lint + format + typecheck + test
```

Planned usage:

```bash
interlock init              # set up a repo, install agent hooks
interlock daemon start      # background service
interlock status            # in-flight branches and open findings
interlock check A B         # force-check a pair now
open http://127.0.0.1:47317 # dashboard
```

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
docs/            architecture, evaluation protocols, threat model, ADRs, demos
scripts/         setup, ADR scaffolding, benchmarks
```

## Documentation

| Document                                     | What it is                                      |
| -------------------------------------------- | ----------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | components, data flow, lifecycle of a Finding   |
| [docs/EVALUATION.md](docs/EVALUATION.md)     | metric definitions and experiment protocols     |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) | assets, trust boundaries, residual risks        |
| [docs/adr/](docs/adr/README.md)              | decision records                                |
| [INTERLOCK_PLAN.md](INTERLOCK_PLAN.md)       | scope, milestones, and everything not yet built |
| [CONTRIBUTING.md](CONTRIBUTING.md)           | branch model, checks, CLA                       |
| [CLAUDE.md](CLAUDE.md)                       | working agreement and hard rules for changes    |

## Limitations (v1)

- Single developer, single machine. No team or cloud mode.
- Linux and macOS only.
- AST semantic analysis covers TypeScript/JavaScript. Other languages fall back to build/typecheck/test detection, which is language-agnostic but slower.
- Semantic detection requires Docker.
- Detects and explains; never resolves.

## Requirements

Node ≥ 24, pnpm 11, git ≥ 2.30, Docker for the semantic analyzers.

## License

Dual-licensed: [AGPL-3.0-only](LICENSE_AGPL) by default, commercial terms for
organisations that cannot accept the AGPL. Resolution rules in
[LICENSE.md](LICENSE.md).

The AGPL covers Interlock's own source. It places no obligation whatsoever on the
repositories Interlock analyses — your code is read, never linked against or
redistributed.

Contributions require agreement to the [CLA](CLA.md). You keep the copyright in
your work; the agreement grants the right to sublicense it, which is what makes
the commercial license possible.
