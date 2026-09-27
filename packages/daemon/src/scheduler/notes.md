# Scheduler — algorithm notes

## The problem

With N in-flight branches there are N(N−1)/2 pairs, agents edit continuously,
and the daemon's steady-state budget is under 2% CPU. Naive re-analysis on every
change never converges. The scheduler spends capacity on the pairs most likely
to be conflicting now, and notices when a result has stopped describing
anything.

## Inputs

- `branch.snapshot` — a worktree's content changed; carries the tree, the head it
  was captured against, and the change set;
- `branch.updated` / `branch.appeared` — a head moved, or a branch appeared;
- `branch.disappeared` — drop everything about it;
- run outcomes, for de-duplication, escalation and backoff.

An unreadable worktree (`treeOid: null`) schedules nothing: there is nothing to
merge.

## 1. Debounce, per branch, with a ceiling

A branch settles `scheduler.debounceMs` (2 s) after its last change, or five
debounces (10 s) after its first unplanned one, whichever is sooner. The ceiling
is what makes a branch that never goes quiet — an agent mid-task — get checked
at all.

This is a second, coarser layer. The watcher already debounces signals at
250 ms with a 2 s ceiling before a snapshot exists. With nothing queued ahead of
a pair, edit-to-Finding is the watcher's ceiling, plus the scheduler's, plus the
run: about 12 s plus a few milliseconds of merge. Queue wait comes on top, and
has no fixed bound — admission is by priority, and aging only guarantees a
waiting pair eventually outranks new ones — so the 60 s budget is held by
measurement, not by construction: under five branches of continuous edit, the
bench measured 7–8 s. Claims about latency count each layer once.

## 2. Plan, from the branch that settled

Only pairs containing the settled branch are considered — never all N² at once.
Each is ranked by `pairOverlap()` on the two change sets:

| Tier        | Meaning                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| `file`      | both touched a path (both ends of a rename count)                            |
| `directory` | both touched a file in one directory, or one's file is the other's directory |
| `unknown`   | a side has no change set, so nothing is ruled out                            |
| `none`      | nothing in common                                                            |

A `none` pair is declined before git is asked for its merge base: git conflicts
only where both sides changed a path or its parent, so no textual conflict can
come of it, and with no overlap reason it is no semantic candidate either.

Two exceptions are always planned, at least one tier up:

- **A pair against the default branch.** Decided: yes, scheduled like any other
  pair. It is the merge that will actually happen, it costs N−1 pairs rather
  than N², and the default branch's own change set is empty against itself, so
  file overlap cannot rank it.
- **A pair with an open Finding.** Only a run resolves one, and undoing the
  conflicting edit is exactly what removes the overlap. Declined, such a pair
  would keep its Finding open forever.

A branch no worktree holds is never snapshotted, so its change set is its
committed changes alone, diffed from its head once per head. Without one, every
old local branch in a repository would read as `unknown`, and unknown is always
merged — each of them, on every settle.

Change sets are diffed against each branch's merge base with the default
branch, not the pair's. For a branch cut from another the change set only
grows, so the comparison errs towards overlap — towards merging — which is the
safe direction: a merge is ground truth, and a pair never merged is a conflict
never looked for.

Planning upserts each pair's row with `stale: true`; a completed run clears it.

## 3. Invalidate

As soon as a branch reports new content, every run in flight that contains it
is aborted — not when it settles, which would let a run landing inside the
debounce save results for content already gone.
Nothing below the scheduler takes a signal — not the runner, not the merge — so
an abort cannot stop a 5 ms merge mid-flight. It tells the run to discard its
result when it lands: the run is recorded `superseded`, not `failed`, and
nothing it found is persisted. A superseded result was never shown, so the same
content may be merged once more. Real cancellation waits for a compiler worth
killing.

Findings are not marked stale on every edit. Doing so would empty the list
while agents type; a Finding stays open until a completed run says otherwise,
and the pair's row carries the staleness. A branch that disappears — merged and
deleted, as every agent branch ends — has its Findings resolved as
`branch-gone` before its rows are deleted, since the delete cascades to them.

## 4. Queue and admit

One queue entry per pair, however often it is asked for; asking again updates
it without resetting its age. At most `scheduler.concurrency` runs execute at
once, and never two of one pair.

Priority is `tier × overlapPriorityBoost`, plus one boost for a hot pair, plus
one tier for every 30 s waited. Aging decides the fairness question: a very
active branch keeps re-queuing its own pairs at high priority, and without aging
a pair it is not in could wait for ever.

## 5. De-duplicate by content

A run identifies both sides before merging: each side's tree — the watcher's
own capture, committed on the head it was captured against — and the pair's
merge base. That triple is the pair's content. A `SnapshotId` is minted per
capture, so two captures of identical work have different ids and the same
trees; ids would never match. If the pair was last analysed to completion at
the same content, the run stops there: nothing is merged.

## 6. Run

The run pipeline commits each side into the shadow — the watcher's trees are
already there, since captures moved into the shadow's store — merges against
the merge base, classifies with the textual analyzer, and persists the run, its
Findings and its events. Every event names its cause: `pair.scheduled` follows
the branch event that settled, and each step of the run follows the last, so a
Finding traces back to the edit.

A Finding matching an open one of the same pair by `textualFindingKey` keeps
that one's id, `firstSeenAt` and run; an open one not reproduced is resolved.

The watcher announces a tree again when the head under it moves, even if the
files did not: a commit of exactly the work on disk, or a rebase, changes the
ancestry a merge base comes from without changing the tree.

A commit made for a tree is cached, and checked before it is reused: a shadow
rebuilt while the daemon runs keeps its path and loses every commit in it. A
merge that finds a commit missing gives the shadow up, so the next attempt
resolves it afresh.

A tree the shadow does not hold is captured again inside the run, once — the
remedy for `SNAPSHOT_STALE`. If that still fails, the scheduler retries the pair
at once, up to three times, and then treats it as infrastructure.

## 7. Escalate, and keep hot pairs hot

A clean merge with a `file` or `directory` overlap would be worth a semantic
check. No semantic analyzer runs yet, so escalation is decided and recorded —
`run.escalated` — and nothing more; the rate is measurable from the log.

Escalated pairs claim one of the pool's slots, and the scheduler keeps that set
itself, pool-sized. A newcomer displaces a hot pair only if it overlaps more, or
if the hot pair has gone unused for ten minutes; otherwise it is deferred.
Every eviction discards the incremental compiler state that makes the next check
of that pair cheap, so round-robin fairness here is the worst available
strategy. The evictions this set makes are the pool's eviction rate: the ones
the pool will make once something runs in it.

## 8. Back off

A pair whose run failed as infrastructure backs off exponentially, from 5 s to a
5-minute cap, and publishes `infra.failure` once per streak. Anything else that
throws is a bug: logged, not retried, and run again when a branch next moves.

## Not yet

- Symbol overlap and import edges, which need the AST layer.
- A boost for pairs driven by live agent sessions.
- The verdict cache: content identity is used here for de-duplication in memory;
  persisting it is the next task.
- Cancellation below the scheduler.

## Budgets

Measured with `scripts/scheduler-bench.ts`; the numbers are in `plan_docs/log.md`.

| Metric                              | Budget                                    |
| ----------------------------------- | ----------------------------------------- |
| Steady-state CPU, no edits          | <2%                                       |
| Scheduling decision latency         | <10ms per event                           |
| Time from edit to textual Finding   | <60s                                      |
| Time from edit to typecheck Finding | <3min                                     |
| Queue depth                         | bounded by the pair count, one entry each |
