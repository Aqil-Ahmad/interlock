# Demos

Scripted, reproducible walkthroughs. Record them as the capability lands.

| Demo                                           | Shows                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| [00-manual-conflict.md](00-manual-conflict.md) | the problem by hand: a textual and a semantic conflict between two worktrees |
| `01-live-branches.md`                          | `interlock status` tracking three worktrees under active edit                |
| `02-textual-warning.md`                        | two live agent sessions collide; a Finding appears in under a minute         |
| `03-semantic-typecheck.md`                     | branches that merge cleanly and break; dual-branch attribution               |
| `04-ast-fast-path.md`                          | the same case flagged in seconds without a compiler                          |
| `05-agent-adapts.md`                           | the same collision with and without the MCP server enabled                   |
| `06-dashboard.md`                              | heatmap, evidence view, live updates                                         |
| `07-merge-order.md`                            | recommended landing order versus FIFO on a replayed scenario                 |

## Rules for a demo doc

- Reproducible from the document alone, on a fresh machine.
- Exact commands and exact expected output, including timings — latency is part of the claim.
- State the setup: repo, branches, what each agent was asked to do.
- Supporting scripts live in `scripts/demo/` and are committed with the doc.
