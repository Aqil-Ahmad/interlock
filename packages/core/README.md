# @interlock/core

Domain logic. Everything here is a function of its inputs; nothing here runs forever.

## Layout

| Directory        | What it owns                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `src/git/`       | repo/branch/worktree discovery, dirty-state snapshots, shadow clone lifecycle, ChangeSet extraction |
| `src/merge/`     | speculative pairwise merges in shadow worktrees, textual conflict classification                    |
| `src/analyzers/` | the analyzer contract and its implementations                                                       |
| `src/advisor/`   | Finding ranking                                                                                     |

## Constraints

- No servers, timers, filesystem watchers or long-lived state — that is `@interlock/daemon`.
- No imports from `@interlock/daemon`, `@interlock/cli`, `@interlock/mcp-server` or `@interlock/dashboard` (enforced by eslint).
- No writes to a user's repository. Writes take a `ShadowRepo`, and `ensureShadow` is the only way to get one.
- No execution of repository code on the host; it goes through the sandbox.
- No new dependencies without an ADR note.

## Conventions

- Coverage gate: ≥80% lines.
- Matchers and classifiers are fixture-driven — add the fixture before the rule.
- A function that is declared but not yet written throws `notImplemented(what)` rather than returning an empty result, so a missing implementation cannot masquerade as "no conflicts found".
- Environmental failures are `infra-failure`, never Findings.
