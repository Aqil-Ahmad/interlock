# @interlock/core

Domain logic. Everything here is a function of its inputs; nothing here runs forever.

## Layout

| Directory | What it owns |
|---|---|
| `src/git/` | repo/branch/worktree discovery, dirty-state snapshots, shadow clone lifecycle, ChangeSet extraction |
| `src/merge/` | speculative pairwise merges in shadow worktrees, textual conflict classification |
| `src/analyzers/` | the analyzer contract and its implementations |
| `src/advisor/` | Finding ranking |

Later stages of the pipeline — AST/tree-sitter matching, the Docker sandbox and
its typecheck/build/test analyzers, merge-order recommendation — are specified in
`INTERLOCK_PLAN.md` and are not directories here yet. A module appears when it
has an implementation, not when it has a name.

## Constraints

- No servers, timers, filesystem watchers or long-lived state — that is `@interlock/daemon`.
- No imports from `@interlock/daemon`, `@interlock/cli`, `@interlock/mcp-server` or `@interlock/dashboard` (enforced by eslint).
- No writes to a user's repository. Writes take a `ShadowRepo`, and `ensureShadow` is the only way to get one.
- No execution of repository code on the host; it goes through the sandbox (M3).
- No new dependencies without an ADR note.

## Conventions

- Coverage gate: ≥80% lines, switched on at M2 (see `vitest.config.ts`).
- Matchers and classifiers are fixture-driven — add the fixture before the rule.
- A function that is declared but not yet written throws `notImplemented(what, milestone)` rather than returning an empty result, so a missing implementation cannot masquerade as "no conflicts found". This is for gaps inside a path being built now — not a way to pre-create modules for later milestones.
- Environmental failures are `infra-failure`, never Findings.
