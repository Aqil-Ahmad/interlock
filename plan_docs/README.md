# Plan docs

Working documents. Not product documentation, not public reference — this tree
exists to keep implementation on track across sessions, and it gets deleted once
Interlock is working.

Nothing here is imported, built or shipped. Nothing in `packages/`, `README.md`,
`SECURITY.md` or `docs/` may link into this tree, because those outlive it.

## What is where

| File              | What it is                                                   |
| ----------------- | ------------------------------------------------------------ |
| `PLAN.md`         | The master plan: scope, non-goals, architecture, data models |
| `expansion.md`    | Product directions past v1. Not scheduled work               |
| `evaluation.md`   | How detection quality, latency and overhead get measured     |
| `log.md`          | Running record: done, decided, blocked. Newest first         |
| `milestones/*.md` | One file per milestone, broken into tasks with checkboxes    |
| `decisions/`      | Decision records. Promoted, not deleted — see below          |
| `demo/`           | Scripted walkthroughs, written as each capability lands      |

`decisions/` is the exception to this tree being disposable. The records
themselves survive; they live here rather than in `docs/` because deciding _why
we chose this_ is team reasoning, and some of it — licensing strategy in
particular — is not for a public audience. When the project ships, promote the
records that became product claims into `docs/` and keep the rest private.

`docs/` at the repository root is the opposite: it is for users and evaluators,
and everything in it is public and true today.

## Status

Update the row when a milestone's exit criteria pass — not when its last task
is ticked. A milestone is done when it demos, not when the code compiles.

| Milestone                                                                                  | State       |
| ------------------------------------------------------------------------------------------ | ----------- |
| [M0 — Foundation](milestones/m0-foundation.md)                                             | in progress |
| [M1 — Watcher and git core](milestones/m1-watcher-and-git-core.md)                         | not started |
| [M2 — Speculative merge and textual detection](milestones/m2-speculative-merge-textual.md) | not started |
| [M3 — Sandbox, typecheck and build](milestones/m3-sandbox-typecheck-build.md)              | not started |
| [M4 — AST analysis and targeted tests](milestones/m4-ast-and-targeted-tests.md)            | not started |
| [M5 — MCP server and agent feedback](milestones/m5-mcp-agent-feedback.md)                  | not started |
| [M6 — Dashboard and CLI](milestones/m6-dashboard-and-cli.md)                               | not started |
| [M7 — Integration advisor](milestones/m7-integration-advisor.md)                           | not started |
| [M8 — Evaluation and hardening](milestones/m8-evaluation-and-hardening.md)                 | not started |

Milestones run in order. Do not start one before the previous milestone's exit
criteria pass. Documentation and evaluation work are the exception and run
continuously.

## How to use this when implementing

1. Open the current milestone file. Pick the first unticked task.
2. Read its **Done when** and **Constraints** before writing anything.
3. Implement it, with tests, to the style in `../CLAUDE.md`.
4. Tick the checkbox in the same change as the code.
5. Add a line to `log.md` if something was decided, discovered or blocked.

A task that turns out to be wrong does not get silently dropped. Change the task
text, note why in `log.md`, and carry on.

## Task format

Each task carries four things. If any is missing, it is not ready to start.

- **Files** — where the work lands. Modules for later milestones do not exist yet
  and must not be created early.
- **What** — the behaviour, in one or two sentences.
- **Done when** — an observable check. "Tests pass" is not a criterion; "a
  rename on branch A and a stale call on branch B produce one Finding naming
  both branches" is.
- **Constraints** — the rules this task can violate by accident. Usually a
  pointer to a hard rule in `../CLAUDE.md`.

## Definition of done

This applies to every task in every milestone. A task is not done because the
code runs; it is done when all of this is true. Where a task's own **Done when**
is stricter, that wins.

**Behaviour**

- The **Done when** check passes, demonstrated by a test rather than by hand.
- Every input that can realistically be wrong is handled: missing file, missing
  binary, empty repo, detached HEAD, no merge-base, permission denied, process
  killed mid-run. Decide for each whether it throws a typed `InterlockError`, or
  is a `Finding`, or is `infra-failure` — and never let the third look like the
  first.
- Nothing partially applied on failure. If a step creates a worktree, a temp
  index or a container, it is cleaned up on the error path too, and there is a
  test that kills the operation midway and asserts nothing is left behind.

**Tests** — three layers, and a task usually needs the first two.

- _Unit_ — `*.test.ts` beside the source. Pure logic, no I/O, no git. Cover the
  happy path, every branch of every conditional, and the boundary cases named
  above.
- _Integration_ — under the package's `test/`. Real git repositories created in
  temp directories, torn down after. Anything touching git, the filesystem, the
  store or the sandbox needs one of these; a unit test with a mocked git runner
  proves the mock works, not the code.
- _Regression_ — every bug fix lands with a test that fails before the fix.
- Mock only true process boundaries: network, clock, subprocess, Docker. Never
  mock our own modules; if that seems necessary, the seam is in the wrong place.
- Coverage on `core` is 80% lines and functions once the gate is on. Treat that
  as a floor for the file you touched, not a repository average to hide behind.

**Observability**

- Structured logs at the decision points, not at every line. Enough that a
  failure in the wild can be diagnosed from logs alone.
- Errors carry a stable `code`, a `remedy` a user can act on, and no secrets or
  file contents in `details`.

**Documentation**

- TSDoc on every exported symbol of `shared` and `core`, saying what it does and
  what it must not do.
- Non-obvious algorithms get a `notes.md` beside the code, updated in the same
  change.
- The package `README.md` still describes reality afterwards.
- `CHANGElog.md` entry if a user could notice the change.

**Verification**

- `pnpm verify` green from a clean tree — build, lint, format, typecheck, test.
- Performance budgets checked once M2 is in: under 2% steady-state CPU, under
  60s to a textual finding, under 3 minutes to a typecheck finding. A task that
  blows a budget is not done; report the number rather than rebaselining quietly.

## Where the depth lives

Milestone tasks say **what** to build and **when it is done**. They do not say
how to write it well — that belongs next to the code and in `.claude/skills/`,
which carry the procedural rules for a kind of work: how to touch git safely,
how to build a fixture repository, what may be mocked.

Read the relevant skill before starting a task in its area. When a task teaches
you something that would have saved an hour, add it to the skill rather than to
the milestone file.

Milestones M3 onward are deliberately shallow. Detail written months early goes
stale and stale detail is worse than none, so each of those files opens with a
task to expand itself to M1's depth before its work starts.
