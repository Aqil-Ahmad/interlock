# CLAUDE.md

Working agreement for AI coding sessions in this repository.

## What this project is

Interlock detects conflicts — textual and semantic — between parallel in-flight branches before merge time, and feeds the warnings back to the agents causing them.

## Orientation

| Where                 | What                                                                            |
| --------------------- | ------------------------------------------------------------------------------- |
| `packages/shared`     | models, events, config, errors, logging. Zero dependencies, imports no sibling  |
| `packages/core`       | git/shadow ops, speculative merge, analyzers, ranking. Pure logic, no processes |
| `packages/daemon`     | watcher, event bus, scheduler, SQLite store, localhost API                      |
| `packages/mcp-server` | agent-facing tool schemas; the prompt-injection boundary                        |
| `packages/cli`        | user surface; a thin client over the daemon API                                 |
| `packages/dashboard`  | React UI. Outside the workspace and the build                                   |
| `eval/`               | evaluation harness — do not edit                                                |
| `docs/`               | architecture, evaluation, threat model, ADRs                                    |

Algorithm notes live next to the hard parts: `packages/daemon/src/scheduler/NOTES.md`. Read them before touching that code.

The tree holds what is built or being built now. Everything else — the sandbox, AST matching, the typecheck/build/test analyzers, merge-order recommendation, the MCP transport — is specified in `INTERLOCK_PLAN.md`. Do not pre-create files, directories or barrel exports for them.

## How to work here

- One session, one scoped task. Keep diffs reviewable.
- Branch off `dev` and target `dev`. `main` is release-only — never commit to it or open a pull request against it.
- Done means code + tests + docs together, `pnpm verify` green, and a CHANGELOG entry if the change is user-visible.
- A function that is declared but not yet written throws `notImplemented(what)`. Keep it that way — returning an empty result would let a missing implementation look like "no conflicts found". A module for work that has not started does not get a stub; it gets a paragraph in `INTERLOCK_PLAN.md`.

## Code style

Read a neighbouring file before writing a new one and match it.

- **Comments explain why, never what.** A constraint, a protocol quirk, a rejected alternative, a reason a value is what it is. Never a restatement of the line below.
- **Nothing addressed to a reader.** No "note that", no "you should", no explaining a change back to whoever requested it, no narrating what is unfinished.
- **No project state in code or public docs.** No milestone tags, roadmap markers, ADR numbers, dates or "not implemented yet" narration. That belongs in `LOG.md`, `INTERLOCK_PLAN.md` or `CHANGELOG.md`, which are working documents and will not survive to release. Public docs are `README.md`, `SECURITY.md`, `CONTRIBUTING.md` and everything under `docs/`.
- **`TODO(scope):`** is the only accepted marker, scoped to a subsystem rather than a milestone, and only inside a path being built now.
- **No hacks that hide a symptom.** No hardcoded paths, magic values, sleeps, retries-until-green, broadened types or disabled rules to make something pass. Fix the cause, or leave it failing and say so.
- **Formatting is Prettier's.** Never hand-format and never add an ignore to get through a check.

If `../archestra-main` is present in the workspace it is a mature reference for
this style — dense doc comments on exported symbols, why-comments on non-obvious
constraints, and no project-management noise anywhere in the source. It is a
read-only reference; never edit it.

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
pnpm verify        # build + lint + format + typecheck + test
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
