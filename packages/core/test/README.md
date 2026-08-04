# @interlock/core — integration tests

Unit tests live next to their source as `*.test.ts`. This directory holds tests that need a real git repository on disk.

- `user-repo-untouched.test.ts` — asserts Interlock leaves watched repos byte-identical. Do not weaken or skip it to make a build pass.
- `fixtures/` — small synthetic repos built programmatically in temp dirs. Fixtures with planted, labelled conflicts used for measuring precision and recall live in `/eval/fixtures` instead.

Conventions:

- Build repos in `fs.mkdtemp` directories and remove them in `afterEach`, even on failure.
- Never invoke git through a shell string; use argument arrays.
- Every bug fix lands with a regression test.
