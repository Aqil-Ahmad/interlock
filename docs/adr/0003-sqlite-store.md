# ADR-0003: SQLite as the local store

- **Status:** accepted
- **Date:** 2026-08-04

## Context

The daemon must persist repos, branches, change sets, speculative runs, findings with evidence, an append-only event log and an analyzer result cache — on a laptop, with no server, surviving restarts, and queryable enough to power a dashboard and an evaluation harness.

Volume is modest (thousands of runs, tens of thousands of events per week of active use), but the event log is append-only and not truncated during a work period, because replay is how findings are traced back to their causes.

## Decision

SQLite, one database file under the Interlock data dir (`~/.interlock`, 0700), with numbered migrations from the first schema onward.

## Consequences

**Easier:** zero configuration, a single file, trivially backed up or deleted; real SQL for the aggregate queries the dashboard and evaluation need; transactions make "record run + findings + events atomically" correct by default; `:memory:` databases keep store tests fast.

**Harder:** a native dependency in the daemon (`better-sqlite3` or `node:sqlite`) — decide and record it here; concurrent writers need care, so the daemon owns the single writer and everything else goes through the API; migrations are forever, and a botched one costs a developer their local history.

**Committed to:** migrations are append-only and never edited after merge; destructive schema changes go expand → migrate → contract; a retention policy exists before the file can grow without bound.

## Alternatives considered

- **JSON files on disk** — no transactions, no queries, and concurrent writes would corrupt state. Fine for config, not for the event log.
- **Embedded key-value store (LevelDB, LMDB)** — fast, but the dashboard and evaluation want relational queries ("findings per pair per analyzer over time"), which would mean hand-rolling indexes.
- **A database server (Postgres)** — contradicts the local-first, single-machine design and would make a fast quickstart impossible.
- **DuckDB** — attractive for analytics, weaker as a transactional store for live daemon state. Revisit if aggregate reporting becomes a headline feature.
