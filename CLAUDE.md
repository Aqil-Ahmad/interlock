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
| `docs/`               | public reference: architecture and threat model. True today, or not in here     |
| `plan_docs/`          | working tree: plan, milestones, decisions, log. Not public, not shipped         |

Algorithm notes live next to the hard parts: `packages/daemon/src/scheduler/notes.md`. Read them before touching that code.

The tree holds what is built or being built now. Everything else — the sandbox, AST matching, the typecheck/build/test analyzers, merge-order recommendation, the MCP transport — is specified in `plan_docs/`. Do not pre-create files, directories or barrel exports for them.

## Before implementing anything

`plan_docs/` is the source of truth for what to build and in what order. Do not
start from a general idea of what the feature should be.

1. Open `plan_docs/README.md` and find the current milestone.
2. Open that milestone file in `plan_docs/milestones/` and find the task.
3. Read its **Done when** and **Constraints** before writing code. They are the
   acceptance criteria, and they are more specific than the task title.
4. Implement only that task. If it needs something from a later milestone, stop
   and say so rather than building ahead.
5. Tick the task's checkbox in the same change as the code.
6. Add a line to `plan_docs/log.md` if anything was decided, discovered or
   blocked. Keep it to one line.

A milestone is finished when its exit criteria pass, not when its last checkbox
is ticked. Update the status table in `plan_docs/README.md` only then.

If a task proves wrong, rewrite it and record why in `plan_docs/log.md`. Never
silently skip one.

## How to work here

- One session, one scoped task. Keep diffs reviewable.
- Branch off `dev` and target `dev`. `main` is release-only — never commit to it or open a pull request against it.
- Done means code + tests + docs together, `pnpm verify` green, and a CHANGELOG entry if the change is user-visible.
- CI runs the same scripts `pnpm verify` runs. Add a check to the script, not to the workflow, or the two drift into checking different things while both report green.
- Coverage floors ratchet upward only. Raise them when a milestone lands; never lower one to get a change through.
- A function that is declared but not yet written throws `notImplemented(what)`. Keep it that way — returning an empty result would let a missing implementation look like "no conflicts found". A module for work that has not started does not get a stub; it gets a task in `plan_docs/`.

## Skills

`.claude/skills/` holds the procedural rules for each kind of work — what breaks,
what may be mocked, what has already gone wrong. Load the relevant one before
starting a task in its area, not after.

- `interlock-git` — anything invoking git: discovery, worktrees, snapshots,
  shadow clones, speculative merges, and the fixture repos that test them.

When a task teaches you something that would have saved an hour, add it to the
skill.

## Code style

Read a neighbouring file before writing a new one and match it.

- **Comments explain why, never what.** A constraint, a protocol quirk, a rejected alternative, a reason a value is what it is. Never a restatement of the line below.
- **Nothing addressed to a reader.** No "note that", no "you should", no explaining a change back to whoever requested it, no narrating what is unfinished.
- **No project state in code or public docs.** No milestone tags, roadmap markers, ADR numbers, dates or "not implemented yet" narration. That belongs in `plan_docs/`, which is a working tree and will not survive to release. Public docs are `README.md`, `SECURITY.md`, `CONTRIBUTING.md` and everything under `docs/`.
- **`TODO(scope):`** is the only accepted marker, scoped to a subsystem rather than a milestone, and only inside a path being built now.
- **No hacks that hide a symptom.** No hardcoded paths, magic values, sleeps, retries-until-green, broadened types or disabled rules to make something pass. Fix the cause, or leave it failing and say so.
- **Formatting is Prettier's.** Never hand-format and never add an ignore to get through a check.
- **Markdown filenames are lowercase-kebab** — `threat-model.md`, `m1-watcher-and-git-core.md`. The exceptions are `README.md` and the root files GitHub detects by name: `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `CLAUDE.md`, `CLA.md`.

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
- The compiler is the semantic detector, not a hand-built matcher. The engineering is telling merge-induced errors from pre-existing ones, and naming which branch caused which half.
- The AST layer is a pre-filter, not a detector, and its bias is the opposite of a rule's: when it cannot tell, the pair escalates rather than being dropped. A filtered-out conflict is never looked for again.
- When a check is unsure, it says nothing. Every false positive is a bug with an issue, not a tuning parameter.
