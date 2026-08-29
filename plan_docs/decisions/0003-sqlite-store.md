# ADR-0003: SQLite as the local store

- **Status:** accepted
- **Date:** 2026-08-04

## Context

The daemon must persist repos, branches, change sets, speculative runs, findings with evidence, an append-only event log and an analyzer result cache — on a laptop, with no server, surviving restarts, and queryable enough to power a dashboard and an evaluation harness.

Volume is modest (thousands of runs, tens of thousands of events per week of active use), but the event log is append-only and not truncated during a work period, because replay is how findings are traced back to their causes.

## Decision

SQLite, one database file under the Interlock data dir (`~/.interlock`, 0700), with numbered migrations from the first schema onward.

The driver is **`node:sqlite`**, built into Node. It is not a dependency at all, which keeps the promise `core` makes about its dependency list true of the daemon as well, removes a native build step from every contributor's first `pnpm install`, and removes a prebuilt binary from the supply chain of a tool that reads people's source code. It is synchronous, so the `Store` interface stays asynchronous over it: a later move to a driver that does I/O off-thread must not be a change to every caller.

The database file is **0600** and the directory holding it is 0700. An executable bit means nothing on a SQLite file, and the `-wal` sidecar — which holds rows that have not reached the database yet — is created with whatever mode the database file carries at the time, so the mode is set before write-ahead logging is switched on.

## Consequences

**Easier:** zero configuration, a single file, trivially backed up or deleted; real SQL for the aggregate queries the dashboard and evaluation need; transactions make "record run + findings + events atomically" correct by default; `:memory:` databases keep store tests fast.

**Harder:** `node:sqlite` is younger than `better-sqlite3` and its API is narrower, so a gap means either a raw statement or a driver swap; concurrent writers need care, so the daemon owns the single writer and everything else goes through the API; migrations are forever, and a botched one costs a developer their local history.

**Committed to:** migrations are append-only and never edited after merge; destructive schema changes go expand → migrate → contract; a retention policy exists before the file can grow without bound.

## Alternatives considered

- **JSON files on disk** — no transactions, no queries, and concurrent writes would corrupt state. Fine for config, not for the event log.
- **Embedded key-value store (LevelDB, LMDB)** — fast, but the dashboard and evaluation want relational queries ("findings per pair per analyzer over time"), which would mean hand-rolling indexes.
- **A database server (Postgres)** — contradicts the local-first, single-machine design and would make a fast quickstart impossible.
- **DuckDB** — attractive for analytics, weaker as a transactional store for live daemon state. Revisit if aggregate reporting becomes a headline feature.
- **`better-sqlite3`** as the driver — faster on large result sets and better documented, but a native module: a compile or a prebuilt binary on every install, on every platform, in a tool whose whole pitch is that it stays out of the way. Revisit if a query this store cannot express turns up.
