# scripts

Developer tooling. Nothing here ships to users.

| Script | Purpose |
|---|---|
| `setup.sh` | one-time developer setup: checks prerequisites, installs, verifies |
| `new-adr.ts` | scaffold the next ADR (`pnpm adr "title"`) |
| `bench.ts` | performance budgets (`pnpm bench`) |

Planned: `gen-fixture.ts` to build a golden fixture repo in a temp dir, and `demo/*.sh` for the scripted walkthroughs in `docs/demo/`.
