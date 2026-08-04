# CLAUDE.md

Working agreement for AI coding sessions in this repository.

## What this project is

Interlock detects conflicts — textual and semantic — between parallel in-flight branches before merge time, and feeds the warnings back to the agents causing them.

## Orientation

| Where | What |
|---|---|
| `packages/shared` | models, events, config, errors, logging. Zero dependencies, imports no sibling |
| `packages/core` | git/shadow ops, speculative merge, analyzers, ranking. Pure logic, no processes |
| `packages/daemon` | watcher, event bus, scheduler, SQLite store, localhost API |
| `packages/mcp-server` | agent-facing tool schemas; the prompt-injection boundary |
| `packages/cli` | user surface; a thin client over the daemon API |
| `packages/dashboard` | React UI. Outside the workspace and the build until M6 |
| `eval/` | evaluation harness — do not edit |
| `docs/` | architecture, evaluation, threat model, ADRs |

Algorithm notes live next to the hard parts: `packages/daemon/src/scheduler/NOTES.md`. Read them before touching that code.

The tree holds what is built or being built now. Everything else — the sandbox, AST matching, the typecheck/build/test analyzers, merge-order recommendation, the MCP transport — is specified in `INTERLOCK_PLAN.md`. Do not pre-create files, directories or barrel exports for them.

## How to work here

- One session, one scoped task. Keep diffs reviewable.
- Done means code + tests + docs together, `pnpm verify` green, and a CHANGELOG entry if the change is user-visible.
- A function that is declared but not yet written throws `notImplemented(what, milestone)`. Keep it that way — returning an empty result would let a missing implementation look like "no conflicts found". This is for gaps inside a path being built now. A module for a milestone that has not started does not get a stub; it gets a paragraph in `INTERLOCK_PLAN.md`.
- Match the surrounding style. Comments explain why, not what.

## Hard rules

1. **Never write to a user's repository** — worktree, branch, index, stash or config. Writes take a `ShadowRepo`, and `ensureShadow` is the only way to get one.
2. **Never execute repository code on the host.** Everything goes through the Docker sandbox.
3. **Never bind outside `127.0.0.1`.** Never add telemetry.
4. **Never forward repository content to an agent unwrapped** — use `wrapUntrusted()`.
5. **Never weaken, skip or delete a failing test to make CI pass.** If a test is genuinely wrong, fix it in its own commit and say why.
6. **Never edit `eval/` datasets or metric definitions.**
7. **Never add a dependency to `core`** without an ADR note.
8. **Never change the security posture.** Flag it for a human decision.

Architectural changes get proposed and recorded (ADR) before they are implemented.

## Commands

```bash
pnpm verify        # lint + typecheck + build + test
pnpm test:watch
pnpm lint:fix
pnpm adr "title"
pnpm bench
pnpm eval
```

## Things worth knowing early

- Models in `shared` are wire formats once persisted; changing one means a store migration.
- The event log is append-only and carries `causedBy`, so every Finding is traceable to what produced it. Side channels that bypass the bus break replay.
- Findings must carry machine-checkable evidence: spans, tool output or a symbol trail.
- Environmental failures (Docker down, unknown toolchain) are `infra-failure`, never Findings.
- In the AST layer, precision beats recall: a rule that is unsure stays silent. The sandbox analyzers are the safety net.
