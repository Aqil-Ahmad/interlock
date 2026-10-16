# scripts

Developer tooling. Nothing here ships to users.

| Script               | Purpose                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `setup.sh`           | one-time developer setup: checks prerequisites, installs, verifies                            |
| `new-adr.ts`         | scaffold the next ADR (`pnpm adr "title"`)                                                    |
| `bench.ts`           | performance budgets (`pnpm bench`)                                                            |
| `typecheck-bench.ts` | the type checker on a real checkout: cold, warm and one-file checks, heap and RSS per service |

Planned: `gen-fixture.ts` to build a golden fixture repo in a temp dir, and `demo/*.sh` for the scripted walkthroughs in `plan_docs/demo/`.
