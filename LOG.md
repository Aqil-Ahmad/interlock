# Log

Short entries: done, decided, blocked. Newest first.

---

## 2026-08-04 (later)

- **Done:** cut the scaffold back to what is built or being built. Removed the M3+ stub modules (`core/src/ast`, `core/src/sandbox`, the typecheck/build/test analyzers, `advisor/merge-order`, the MCP server lifecycle and binary) and the barrel/`exports` entries pointing at them. Took `packages/dashboard` out of the workspace, the solution tsconfig and the Vitest projects until it has react/vite. Dropped the coverage threshold until `core` has an implementation to measure. Removed the Dependabot docker entry aimed at a directory with no Dockerfile. Deferred CONTRIBUTING and the GitHub issue/PR templates.
- **Decided:** `notImplemented` is for gaps inside a path being built now, not a way to pre-create later milestones — recorded in CLAUDE.md and `core/README.md`. A module appears when it has an implementation.
- **Decided:** AGPL-3.0-only plus a commercial license (ADR-0002, now accepted). `LICENSE` added, every manifest set to the `AGPL-3.0-only` SPDX id. Consequence to act on before it becomes expensive: selling exceptions requires owning the copyright, so a CLA must be in place before the first outside contribution.
- **Open:** AST approach (tree-sitter vs the TypeScript compiler API) wants an ADR before M4. SQLite driver: `node:sqlite` is the likely answer and needs ADR-0003 updating.
- **Next:** `pnpm install`, then get `pnpm verify` green for the first time.

## 2026-08-04

- **Done:** monorepo scaffold — workspaces, strict TS with project references, lint with layering rules, Vitest, CI; `shared` models and event vocabulary; event bus; docs set (architecture, evaluation, threat model); ADR-0001…0004.
- **Decided:** monorepo (ADR-0001); SQLite store (ADR-0003); security posture enforced by types and tests (ADR-0004).
- **Open:** license pending IP-policy confirmation (ADR-0002); native SQLite driver choice; AgenticFlict dataset not yet obtained.
- **Next:** install dependencies and get `pnpm verify` green; reproduce a textual and a semantic conflict by hand and write up `docs/demo/00-manual-conflict.md`.
