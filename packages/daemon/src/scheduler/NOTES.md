# Scheduler — algorithm notes

> Design sketch, written before implementation. Update as the code lands.

## The problem

With N in-flight branches there are N(N−1)/2 pairs. At N=8 that is 28 pairs, and a full typecheck per pair costs minutes of CPU each. Agents edit files continuously, so naive re-analysis on every change never converges — and the daemon has a steady-state budget of <2% CPU.

The scheduler spends the machine's capacity on the pairs most likely to be conflicting right now, and notices when a result has become irrelevant.

## Inputs

- `worktree.changed` / `branch.updated` from the watcher;
- `changeset.computed` — touched paths and symbols per branch;
- run outcomes, for backoff and caching.

## The pipeline

1. **Debounce.** An edit schedules nothing until the branch has been quiet for `scheduler.debounceMs` (default 2s). Agents write in bursts; without this the queue is churn.

2. **Invalidate.** When branch X moves, every pair containing X is marked stale. In-flight runs for those pairs are aborted through their `AbortSignal` and recorded as `superseded`, not `failed`. Runs of pairs not containing X keep their results — this is the incremental part.

3. **Prioritise.** Highest first:
   - both sides touch a **common file** → highest, a textual conflict is plausible;
   - both sides touch a **common symbol**, or there is an import edge between them → high;
   - both branches driven by **live agent sessions** → boost, since a warning can still change behaviour;
   - pair with an existing open Finding → boost, re-verify before advising;
   - no overlap → lowest, but not zero: semantic conflicts exist between files that never overlap textually, which is what makes them hard.

4. **Admit.** At most `scheduler.concurrency` runs execute at once. Sandboxed analyzers are the resource hogs, so admission is by sandbox slot rather than by pair.

5. **Backoff.** A pair whose last run produced an `infra-failure` backs off exponentially — Docker is down, hammering it helps nobody — and publishes `infra.failure` once, not once per attempt.

## Cache interaction

A run is identified by (snapshotA, snapshotB, analyzer, toolchain fingerprint). Before scheduling, the scheduler asks the store whether that tuple already has a verdict. Agents revert and re-apply changes constantly, so hits on recently-seen snapshot pairs are common enough to be worth the lookup.

## What "stale" means to the user

A Finding whose pair is stale is shown, marked stale, rather than hidden. Hiding it would empty the UI every time anyone types — worse than a slightly out-of-date warning that says so.

## Budgets (tracked in `pnpm bench`)

| Metric | Budget |
|---|---|
| Steady-state CPU, no edits | <2% |
| Scheduling decision latency | <10ms per event |
| Time from edit to textual Finding | <60s |
| Time from edit to typecheck Finding | <3min |
| Queue depth at N=8 branches | bounded; drop lowest-priority pairs rather than growing |

## Open questions

- Should pairs against `main` be scheduled too? Same machinery, different pair set. Decide before the store schema is written twice.
- Fairness: a very active branch can starve pairs it is not part of. Probably an aging counter.
