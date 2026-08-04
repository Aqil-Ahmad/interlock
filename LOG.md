# Log

Short entries: done, decided, blocked. Newest first.

---

## 2026-08-04 (later)

- **Done:** deleted the M3+ stub modules and the barrel/`exports` entries pointing at them; dashboard out of the workspace, solution tsconfig and Vitest projects until it declares react/vite; coverage threshold off; Dependabot docker entry removed; CONTRIBUTING and the issue/PR templates dropped.
- **Done:** git repo initialised on `main`. Licensing in place: `LICENSE_AGPL`, `LICENSE.md` router, `CLA.md` and its workflow.
- **Decided:** AGPL-3.0-only plus commercial terms (ADR-0002, accepted). `notImplemented` is for gaps inside a path being built now, not for pre-creating later milestones.
- **Open:** `CLA.md` and `LICENSE.md` have unfilled entity/contact blanks and need review; CLA workflow needs a signature repo and `CLA_SIGNATURES_TOKEN`. Node version disagrees three ways — `engines` >=22, `.node-version` 26.4.0, CI 22. tree-sitter vs the TypeScript compiler API wants an ADR before M4. `node:sqlite` likely closes ADR-0003.
- **Next:** install pnpm, then `pnpm install` and get `pnpm verify` green.

## 2026-08-04

- **Done:** monorepo scaffold — workspaces, strict TS with project references, lint with layering rules, Vitest, CI; `shared` models and event vocabulary; event bus; docs set (architecture, evaluation, threat model); ADR-0001…0004.
- **Decided:** monorepo (ADR-0001); SQLite store (ADR-0003); security posture enforced by types and tests (ADR-0004).
- **Open:** license pending IP-policy confirmation (ADR-0002); native SQLite driver choice; AgenticFlict dataset not yet obtained.
- **Next:** install dependencies and get `pnpm verify` green; reproduce a textual and a semantic conflict by hand and write up `docs/demo/00-manual-conflict.md`.
