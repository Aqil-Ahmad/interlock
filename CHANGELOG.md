# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). User-visible changes get an entry in the same PR that makes them.

## [Unreleased]

### Added

- `interlock status` — in-flight branches, their dirty state and the files they touched, read from the daemon over the localhost API. A worktree that could not be read shows as `unknown` rather than clean. `--json` emits the same facts for scripts, `--data-dir` and `INTERLOCK_DATA_DIR` say which daemon to ask, and the exit codes are `0` when it could report, `64` for bad arguments, `69` when no daemon is reachable and `70` otherwise. Open findings do not change the exit code.
- The daemon runs: watcher, event bus and SQLite store wired together behind a loopback HTTP API. It binds `127.0.0.1` only and authenticates every request — including ones for paths that do not exist — with a bearer token generated at first start and stored 0600. The port it bound is published to `daemon.json` in the data dir so the CLI can find it, and removed on a clean stop. Serves `/api/health`, `/api/repos` and `/api/repos/:id/branches`.
- Per-repository configuration: `.interlock.json` in a repository root overrides `ignore`, `ignoreBranches` and `toolchain` commands. Validated against the schema, with unknown keys and malformed files refused rather than ignored.
- Monorepo scaffold: pnpm workspaces, strict TypeScript with project references, ESLint (flat config, type-aware, with layering rules), Prettier, Vitest, GitHub Actions CI.
- `@interlock/shared`: data models (Repo, BranchRef, AgentSession, ChangeSet, MergePair, SpeculativeRun, Finding, Advice, EventRecord), event vocabulary, config schema with validation, typed errors, structured logging with secret redaction, ULID generation.
- `@interlock/core`: `UserRepo`/`ShadowRepo` handles, the git runner enforcing them, the `Analyzer` contract, finding ranking; contracts for git discovery, dirty-state capture and speculative merge.
- `@interlock/daemon`: event bus with causality tracking; contracts for watcher, scheduler, SQLite store, session hooks and the localhost API.
- `@interlock/mcp-server`: agent tool schemas and `wrapUntrusted()` prompt-injection containment.
- `@interlock/cli`: command surface.
- Documentation: architecture, evaluation protocols, threat model, ADR-0001…0004, scheduler algorithm notes.
- Evaluation harness entry point outside the workspace.
- Licensing: AGPL-3.0-only with a commercial exception (ADR-0002).
