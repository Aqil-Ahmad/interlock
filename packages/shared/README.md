# @interlock/shared

The dependency leaf. Every other package depends on this one; this one depends on nothing.

## Contents

- **Models** (`src/models/`) — `Repo`, `BranchRef`, `AgentSession`, `ChangeSet`, `MergePair`, `SpeculativeRun`, `Finding`, `Advice`, `EventRecord`.
- **Events** (`src/events/`) — the vocabulary components communicate in.
- **Config** (`src/config.ts`) — schema, defaults, validation.
- **Errors** (`src/errors.ts`) — typed and coded; separates infra failures from findings.
- **Logging** (`src/logger.ts`) — structured JSON with secret redaction.
- **Ids** (`src/ids.ts`) — ULIDs with per-entity branding.

## Constraints

- No business logic — no git, no merging, no analysis. That is `@interlock/core`.
- No I/O beyond reading `process.env` and writing log lines.
- No imports from other `@interlock/*` packages (enforced by eslint).
- No runtime dependencies. Adding one needs an ADR.

## Conventions

- Models are JSON-serializable: ULID strings for ids, ISO-8601 strings for times (never `Date`), so SQLite rows, HTTP responses and MCP payloads all look the same.
- A model shape becomes a wire format once it is persisted; changing one means a store migration.
- Exported APIs carry TSDoc.
