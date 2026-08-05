# Architecture

> Structural changes update this file in the same PR.

## The shape of the system

```mermaid
flowchart TB
    subgraph agents[Agents and humans]
        CC[Claude Code]
        CX[Codex / Cursor]
        H[Human]
    end

    subgraph daemon["daemon (long-running, localhost)"]
        W[Watcher] --> B((Event Bus))
        B --> S[Scheduler]
        S --> ME[Merge Engine]
        ME --> AN[Analyzer pipeline]
        AN --> ST[(SQLite Store)]
        B --> ST
        AN --> ADV[Advisor]
    end

    subgraph surfaces[Surfaces]
        MCP[MCP Server]
        CLI[CLI]
        DASH[Dashboard]
    end

    CC -->|hooks| W
    CC <-->|tools| MCP
    CX <-->|tools| MCP
    H --> CLI
    H --> DASH

    MCP --> API[HTTP/WS API]
    CLI --> API
    DASH --> API
    API --- ST

    W -.->|read-only| REPO[(User worktrees)]
    ME -->|read-write| SHADOW[(Shadow worktrees)]
    AN -->|execute| BOX[[Docker sandbox]]
```

Two edges carry the security posture: the dotted edge to user worktrees is read-only, and everything executed runs inside the sandbox.

## Package map

| Package                 | Role                                                  | Depends on                      |
| ----------------------- | ----------------------------------------------------- | ------------------------------- |
| `@interlock/shared`     | models, events, config, errors, logging, ids          | nothing                         |
| `@interlock/core`       | git/shadow ops, speculative merge, analyzers, ranking | shared                          |
| `@interlock/daemon`     | watcher, bus, scheduler, store, API, composition root | shared, core                    |
| `@interlock/mcp-server` | agent-facing tools                                    | shared (+ daemon API over HTTP) |
| `@interlock/cli`        | `interlock` command                                   | shared (+ daemon API over HTTP) |
| `@interlock/dashboard`  | React UI                                              | shared (+ daemon API over HTTP) |

Dependencies point one way. `shared` imports no sibling; `core` never imports a runtime package. Both are enforced in `eslint.config.js`.

## Lifecycle of a Finding

The path to trace when debugging anything:

1. **Edit.** An agent writes to a file in a worktree.
2. **Observe.** The watcher sees the filesystem event, debounces, publishes `worktree.changed`.
3. **Snapshot.** The dirty tree is captured without touching the user's index — a temporary index file plus `write-tree`, writing objects only. Publishes `changeset.computed`.
4. **Schedule.** Every pair containing this branch is marked stale, superseded runs are aborted, priority is computed (file overlap → symbol overlap → live sessions), work is admitted up to the concurrency limit. Publishes `pair.scheduled`.
5. **Merge.** A shadow worktree is created from the pair's merge-base; both sides' commits — real or snapshot — are merged with `ort`. Publishes `run.merge-completed`.
6. **Analyze.** Cheapest first: `textual` → `ast-semantic` → `typecheck` → `build` → `test`. Execution analyzers run in the sandbox against the merged tree. Each publishes `run.analyzer-completed`.
7. **Attribute.** Each problem is traced to which side introduced which half — the difference between "TS2304" and "your rename broke a call site the other branch added".
8. **Record.** Findings are persisted with evidence: spans on both branches, redacted tool output, symbol trails. Publishes `finding.raised`.
9. **Advise.** The advisor ranks by severity × confidence and produces Advice within the noise budget.
10. **Deliver.** MCP pushes to the owning agent, rate-limited; the dashboard updates over WebSocket; `interlock status` shows it. Publishes `advice.delivered`.
11. **Invalidate.** Branches move; the finding becomes `stale`, is re-verified, and ends `resolved` or `dismissed`.

Every step publishes an event with a `causedBy` pointer, so a Finding can be walked back to the edit that caused it.

## Where the hard parts live

| Problem                                                    | Lives in                          | Notes                                                  |
| ---------------------------------------------------------- | --------------------------------- | ------------------------------------------------------ |
| Not melting the CPU with N² pairs                          | `daemon/src/scheduler`            | `NOTES.md` — debounce, priority, invalidation, budgets |
| Snapshotting dirty state without touching the user's index | `core/src/git/worktree.ts`        | temporary index file; objects only                     |
| Disk cost of shadow worktrees                              | `core/src/git/shadow.ts`          | one clone per repo, shared objects, quota + GC         |
| Precision of semantic detection                            | `core/src/analyzers`              | per-matcher confidence caps                            |
| Not being ignored by agents                                | `mcp-server` + `core/src/advisor` | ranking + rate limits                                  |
| Not being an attack surface                                | `mcp-server/src/sanitize.ts`      | untrusted content wrapped as data                      |

## Data flow invariants

- Models are JSON-serializable and identical across SQLite rows, HTTP responses and MCP payloads.
- The event log is append-only; there is no update or delete path for events.
- Analyzer results are cached on `(snapshotA, snapshotB, analyzer, toolchain fingerprint)`; a lockfile change invalidates the cache.
- Infra failures (`SANDBOX_UNAVAILABLE`, `TOOLCHAIN_UNSUPPORTED`) are never findings.
