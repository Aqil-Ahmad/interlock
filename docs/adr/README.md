# Architecture Decision Records

One record per hard-to-reverse decision: repository strategy, license, storage, sandbox technology, MCP design, metric definitions.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-monorepo.md) | Single monorepo with pnpm workspaces | accepted |
| [0002](0002-license.md) | AGPL-3.0 with a commercial exception | accepted |
| [0003](0003-sqlite-store.md) | SQLite as the local store | accepted |
| [0004](0004-security-posture.md) | Shadow-only writes and sandboxed execution | accepted |

## How to add one

```bash
pnpm adr "short title"     # scaffolds the next number from template.md
```

Rules:

- Number sequentially; never reuse a number.
- An ADR is immutable once accepted. To change a decision, write a new one and mark the old `superseded by ADR-NNNN`.
- Always list the alternatives and why they lost.
