# ADR-0001: Single monorepo with pnpm workspaces

- **Status:** accepted
- **Date:** 2026-08-04

## Context

Interlock is six deliverables — shared types, domain core, daemon, MCP server, CLI, dashboard — plus an evaluation harness, built by a small team. Every piece exchanges the same data models (`Finding`, `BranchRef`, `ChangeSet`), and those models will change constantly while the analyzers teach us what they need to carry.

Separate repositories force every model change into a publish/bump/integrate cycle, at exactly the stage where models are least stable.

## Decision

One repository, `interlock`, using pnpm workspaces. Packages under `packages/*`; the evaluation harness in `/eval`, outside the workspace.

## Consequences

**Easier:** atomic cross-cutting changes; a single CI and issue tracker; shared TypeScript and lint config; the dashboard imports daemon types directly, so a model change breaks the build instead of the running page.

**Harder:** the repository is bigger than any one contributor needs, and package boundaries are conventions rather than physical separations — so they are enforced mechanically in `eslint.config.js` (`shared` depends on nothing, `core` may not import runtime packages).

**Committed to:** publishing anything externally later means extracting it. First likely candidate is `mcp-server`, which is a thin adapter with an external life of its own. Splitting is a new ADR.

`/eval` sits outside `packages/*` so that the "evaluation code is not product code" boundary is structural rather than stated.

## Alternatives considered

- **Polyrepo** — rejected: publish/bump cycles on every model change.
- **Monorepo with npm/yarn workspaces** — rejected: pnpm's strict layout prevents phantom dependencies, which matters because `core` has a minimal-dependency policy that would otherwise be silently violated.
- **Nx/Turborepo** — real value at larger scale, but another build system to learn and maintain. `tsc --build` project references cover incremental builds. Revisit if CI time becomes a problem.
