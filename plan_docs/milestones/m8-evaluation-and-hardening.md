# M8 — Evaluation and hardening

**Goal:** Numbers that survive scrutiny.

**Exit criteria:** every headline metric reported with its methodology, and
`pnpm eval` regenerates every report from one command.

**Depends on:** M7.

## Tasks

- [ ] **Expand this milestone before starting it**
      **Files:** this file
      **What:** the tasks below are one line each. Rewrite them to the depth of `m1-watcher-and-git-core.md` — per-task edge cases, failure modes, the tests each needs, and the constraints it can breach by accident.
      **Done when:** every task below carries a `Done when` naming an observable check, and nothing in it contradicts what earlier milestones learned.

- [ ] **Freeze the metric definitions**
      **Files:** `plan_docs/evaluation.md`
      **What:** fix precision, recall, lead time, false-positive rate and overhead before running anything.
      **Done when:** written down and dated. Defining metrics after seeing results is how numbers stop meaning anything.

- [ ] **Golden fixture run**
      **Files:** `eval/fixtures/`, `eval/run.ts`
      **What:** precision and recall per analyzer and combined.

- [ ] **OSS replay**
      **Files:** `eval/replay/`
      **What:** replay concurrent branch histories from 3–5 real TypeScript repos, labelled by whether the real merge or CI actually broke.
      **Done when:** the false-positive rate on genuinely independent work is reported. Target is under one per day of normal work — this number decides whether anyone keeps the tool installed.

- [ ] **AgenticFlict**
      **Files:** `eval/agenticflict/`
      **What:** adapt the dataset's conflict regions into replayable pairs.

- [ ] **Baselines**
      **What:** compare against git merge at integration time, `git merge --no-commit` at PR time, and the GitHub conflict indicator.
      **Done when:** lead time is reported against a real baseline, not against nothing.

- [ ] **Ablations**
      **What:** textual only, plus typecheck, plus AST, full.
      **Done when:** each layer's contribution is separable. If a layer adds nothing, say so and consider removing it.

- [ ] **Overhead benchmarks**
      **Files:** `scripts/bench.ts`
      **What:** CPU, memory, disk, time to verdict per pair.
      **Done when:** measured against the stated budgets — under 2% steady-state CPU, under 60s to a textual finding, under 3 minutes to a typecheck finding — with any miss reported honestly rather than quietly rebaselined.

- [ ] **Hardening pass**
      **What:** bug-fix freeze, docs completeness, demo recording.

- [ ] **Delete this tree**
      **What:** `plan_docs/` has done its job by here. Anything still worth keeping moves into `docs/` or an ADR first.
