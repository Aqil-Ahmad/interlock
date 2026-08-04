# @interlock/daemon

The long-running local service. Composes `@interlock/core` into a system that runs continuously on a developer's machine.

## Layout

| Directory | What it owns |
|---|---|
| `src/bus/` | typed pub/sub; the only channel components use to talk to each other |
| `src/watcher/` | repo/branch/worktree/session discovery and change detection |
| `src/scheduler/` | which pairs to analyse, and when — see `src/scheduler/NOTES.md` |
| `src/store/` | SQLite persistence, migrations, analyzer cache, event log |
| `src/api/` | localhost HTTP + WebSocket API |
| `src/hooks/` | agent session registration |
| `src/daemon.ts` | composition root and lifecycle |

## Constraints

- No domain logic — merging, analysis and advice belong in `@interlock/core`.
- Binds `127.0.0.1` only, and never serves unauthenticated requests.
- No writes to a user repository; no execution of repository code outside the sandbox.
- No telemetry. Any future opt-in analytics needs an ADR first.

## Operational notes

- Data dir defaults to `~/.interlock` (0700): SQLite store, shadow clones, logs, API token.
- Steady-state CPU budget is <2%, tracked by `pnpm bench`.
- `interlock daemon stop --purge` must leave nothing behind except the user's repositories, untouched.
