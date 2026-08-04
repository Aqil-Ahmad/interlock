# @interlock/cli

The `interlock` command. A thin client over the daemon's localhost API.

## Commands

| Command                                      | Purpose                                                              |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `interlock status`                           | in-flight branches, dirty state, open findings                       |
| `interlock watch`                            | live findings in the terminal                                        |
| `interlock check <A> <B>`                    | force a speculative merge of two branches now                        |
| `interlock order`                            | recommended landing order                                            |
| `interlock init`                             | set a repo up, including agent hooks                                 |
| `interlock daemon start\|stop\|status\|logs` | background service lifecycle (`stop --purge` wipes Interlock's data) |
| `interlock doctor`                           | diagnose git, Docker, toolchain and permissions                      |

## Constraints

- No analysis, git operations or storage of its own; it asks the daemon.
- Prints no secrets or tokens, and no file contents beyond the evidence excerpts the API returns.
- Every read path works without the dashboard.

## Conventions

- Exit codes: `0` clean, `1` runtime error, `2` findings present so scripts can branch on it, `64` usage error.
- Human-readable by default; `--json` on every read command.
- Errors print the `remedy` field from `InterlockError` — an error the user cannot act on is a bug.
