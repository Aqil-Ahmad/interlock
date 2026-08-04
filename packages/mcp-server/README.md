# @interlock/mcp-server

The agent-facing surface: where detection turns into something an agent can act on mid-task.

## Tools

| Tool                          | Purpose                                                           |
| ----------------------------- | ----------------------------------------------------------------- |
| `get_conflicts_for_my_branch` | conflicts between the caller's branch and other in-flight work    |
| `check_file_overlap(paths)`   | which other branches are touching the paths you are about to edit |
| `get_pending_changes(path)`   | symbol-level summary of peer branches' unlanded changes to a path |
| `propose_merge_order`         | suggested landing order                                           |

## Constraints

- Analyses nothing itself; it is a thin adapter over the daemon API.
- Exposes no data a human could not see via `interlock status`.
- Forwards no repository content unwrapped — everything untrusted goes through `wrapUntrusted()`.
- Sends no warnings without rate limiting.

## Injection boundary

Content forwarded to an agent is written by other agents, which makes this package the prompt-injection boundary. Peer diffs, compiler output and symbol names are quoted as data inside delimiters, truncated, with instruction-shaped lines neutralised. Residual risk is documented in `docs/THREAT_MODEL.md`.
