# M7 — Integration advisor

**Goal:** From detection to guidance.

**Exit criteria:** on replayed 3–5 branch scenarios, following Interlock's
recommended order produces measurably fewer conflict hunks and failed merges
than naive FIFO. Report the numbers, including the cases where it did not help.

**Depends on:** M6. Research-flavoured — if it slips, ship order recommendation
alone and drop the LLM parts.

## Tasks

- [ ] **Expand this milestone before starting it**
      **Files:** this file
      **What:** the tasks below are one line each. Rewrite them to the depth of `m1-watcher-and-git-core.md` — per-task edge cases, failure modes, the tests each needs, and the constraints it can breach by accident.
      **Done when:** every task below carries a `Done when` naming an observable check, and nothing in it contradicts what earlier milestones learned.

- [ ] **Conflict graph**
      **Files:** `packages/core/src/advisor/merge-order.ts` (create in this milestone)
      **What:** branches as nodes, expected rework if a pair lands adjacently as edge weights, derived from Findings.

- [ ] **Order search**
      **Files:** `packages/core/src/advisor/merge-order.ts`
      **What:** find the landing sequence minimising total expected conflict cost.
      **Done when:** it beats FIFO on the fixture scenarios, with the improvement reported as a number rather than a claim.

- [ ] **Rebase simulation**
      **What:** validate a candidate order by simulating it in the shadow clone.
      **Done when:** every recommended order has been simulated end to end.
      **Constraints:** simulation happens in the shadow. Never against a user branch, never as a rebase the user did not ask for.

- [ ] **`interlock order`**
      **Files:** `packages/cli/src/commands/`
      **Done when:** it explains why, not just what — the rationale is the deliverable.

- [ ] **LLM explanations, optional**
      **What:** human-readable explanation per Finding, and behind explicit approval, a draft resolution patch previewed in the shadow.
      **Done when:** off by default, clearly labelled, never applied to a user branch.
      **Constraints:** the model reads repository content, so this is the same injection surface as the MCP payloads. If M7 is running late, this is the first thing to cut.
