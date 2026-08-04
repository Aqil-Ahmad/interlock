# ADR-0004: Shadow-only writes and sandboxed execution

- **Status:** accepted
- **Date:** 2026-08-04

## Context

Interlock watches repositories that people and autonomous agents are actively working in, and it executes code produced by speculatively merging two AI-written branches. That combination is unusual:

1. It has read access to work-in-progress that exists nowhere else. A stray write destroys unrecoverable work.
2. It runs code nobody has reviewed, on a developer's machine, with their credentials in the environment.

Both failures are unrecoverable in practice — a tool that eats uncommitted work once gets uninstalled permanently.

## Decision

Enforce the following mechanically rather than by discipline:

1. **Shadow-only writes.** No mutation of a user's worktree, branch, index, stash or config. All git writes target a shadow clone under Interlock's data dir. Enforced by types (`UserRepo` vs `ShadowRepo`; mutating functions accept only the latter), by a git runner that refuses mutating argv against a `UserRepo`, and by a test hashing user-repo state before and after full runs.
2. **Sandboxed execution.** Merged code runs only in Docker: `--network=none`, non-root, `--read-only` with a tmpfs overlay, CPU/memory/PID/time limits. Config resolution forces `sandbox.network` to `false` and refuses to enable execution analyzers when the sandbox is off.
3. **Local-only services.** Daemon and MCP bind `127.0.0.1` with a generated bearer token. `daemon.host` is typed as the literal `'127.0.0.1'` and re-forced during config resolution.
4. **Secrets hygiene.** Credential files are never read; secret patterns are redacted from logs and stored evidence; the data dir is 0700; evidence stores spans and truncated excerpts, never whole files.
5. **Agent payloads are data.** Content forwarded to agents is wrapped in delimiters, truncated, and instruction-shaped lines are neutralised (`wrapUntrusted`).
6. **No telemetry.** Any future opt-in analytics requires its own ADR.

## Consequences

**Easier:** "can it break my repo?" and "does it phone home?" have one-sentence answers backed by tests; the sandbox boundary makes toolchain failures classifiable as infra rather than findings.

**Harder:** Docker becomes a hard dependency for semantic detection and is the most common setup failure — hence `interlock doctor`; shadow clones cost disk, so a quota and GC are mandatory; type-level separation of repo handles adds friction to every git helper.

**Committed to:** these are testable invariants. A PR that weakens one is a security regression, and the PR template asks about it.

## Alternatives considered

- **Operate directly on user worktrees with careful discipline** — rejected. One bug costs uncommitted work; there is no acceptable failure rate.
- **Run builds on the host in a temp dir** — faster and much easier, and it executes unreviewed agent code with the developer's environment, credentials and network.
- **VM-level isolation (Firecracker, Lima)** — stronger than containers, far heavier to install and explain. Revisit if a threat emerges that containers cannot contain.
- **Bubblewrap/seatbelt instead of Docker** — lighter, but per-platform, and would fork the implementation across Linux and macOS.
