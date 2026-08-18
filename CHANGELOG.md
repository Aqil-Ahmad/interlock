# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). User-visible changes get an entry in the same PR that makes them.

## [Unreleased]

### Added

- Monorepo scaffold: pnpm workspaces, strict TypeScript with project references, ESLint (flat config, type-aware, with layering rules), Prettier, Vitest, GitHub Actions CI.
- `@interlock/shared`: data models (Repo, BranchRef, AgentSession, ChangeSet, MergePair, SpeculativeRun, Finding, Advice, EventRecord), event vocabulary, config schema with validation, typed errors, structured logging with secret redaction, ULID generation.
- `@interlock/core`: `UserRepo`/`ShadowRepo` handles, the git runner enforcing them, the `Analyzer` contract, finding ranking; contracts for git discovery, dirty-state capture and speculative merge.
- `@interlock/daemon`: event bus with causality tracking; contracts for watcher, scheduler, SQLite store, session hooks and the localhost API.
- `@interlock/mcp-server`: agent tool schemas and `wrapUntrusted()` prompt-injection containment.
- `@interlock/cli`: command surface.
- Documentation: architecture, evaluation protocols, threat model, ADR-0001…0004, scheduler algorithm notes.
- Evaluation harness entry point outside the workspace.
- Licensing: AGPL-3.0-only with a commercial exception (ADR-0002).
