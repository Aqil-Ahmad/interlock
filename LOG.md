# Log

Short entries: done, decided, blocked. Newest first.

---

## 2026-08-04 (later)

- **Done:** deleted the M3+ stub modules and the barrel/`exports` entries pointing at them; dashboard out of the workspace, solution tsconfig and Vitest projects until it declares react/vite; coverage threshold off; Dependabot docker entry removed; CONTRIBUTING and the issue/PR templates dropped.
- **Done:** git repo initialised on `main`. Licensing in place: `LICENSE_AGPL`, `LICENSE.md` router, `CLA.md` and its workflow.
- **Decided:** AGPL-3.0-only plus commercial terms (ADR-0002, accepted). `notImplemented` is for gaps inside a path being built now, not for pre-creating later milestones.
- **Done:** dependencies installed and **`pnpm verify` is green for the first time**. Fixes it took: `@eslint/js` was pinned to a version that does not exist; `@types/node` declared per package and `types: ["node"]` set, since nothing resolved Node globals; `ShadowRepo` imported from its owning module; ULID `bumpRandom` incremented bytes while the encoder reduced mod 32, so every 32nd id went backwards lexicographically — which the event-log replay order depends on; two redundant type assertions and an empty function body.
- **Done:** `tsconfig.check.json` added. Tests, `scripts/` and `eval/` were in no tsconfig, so they were neither typechecked nor type-aware linted; they are both now, and `format:check` joined `pnpm verify` to match CI.
- **Decided:** findings rank by severity, then confidence, then recency — severity no longer multiplies into confidence. A high-severity finding we are unsure of outranks a low-severity one we are certain of, because agents see only a handful of warnings per hour. `findingWeight` still gates the noise budget via `minWeight`.
- **Open:** `CLA.md` and `LICENSE.md` have unfilled entity/contact blanks and need review; CLA workflow needs a signature repo and `CLA_SIGNATURES_TOKEN`. tree-sitter vs the TypeScript compiler API wants an ADR before M4. `node:sqlite` likely closes ADR-0003. Coverage threshold is off until M2.
- **Decided:** `dev` is the integration branch and repository default; `main` is release-only and carries the tags. CI now runs on pushes to both. Recorded in `CONTRIBUTING.md` and `CLAUDE.md`.
- **Next:** create the GitHub repo, push, set `dev` as default, add rulesets for both branches, then reproduce a textual and a semantic conflict by hand for `docs/demo/00-manual-conflict.md`.

## 2026-08-04

- **Done:** monorepo scaffold — workspaces, strict TS with project references, lint with layering rules, Vitest, CI; `shared` models and event vocabulary; event bus; docs set (architecture, evaluation, threat model); ADR-0001…0004.
- **Decided:** monorepo (ADR-0001); SQLite store (ADR-0003); security posture enforced by types and tests (ADR-0004).
- **Open:** license pending IP-policy confirmation (ADR-0002); native SQLite driver choice; AgenticFlict dataset not yet obtained.
- **Next:** install dependencies and get `pnpm verify` green; reproduce a textual and a semantic conflict by hand and write up `docs/demo/00-manual-conflict.md`.
