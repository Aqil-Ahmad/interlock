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

### When the filesystem says nothing

That chain assumes the edit's filesystem event arrived. It may not: events are
lossy under load, and a recursive watch is not delivering yet when `fs.watch`
returns — the one demo failure was two edits made about 10 ms after the daemon
started, of which the watcher never heard. For those the chain is:

| Step                                       | Worst case                          |
| ------------------------------------------ | ----------------------------------- |
| Wait for the watcher's next timed pass     | the sweep interval, 30 s by default |
| That pass probes each worktree             | a `git status` per worktree         |
| The branch settles                         | the ceiling, 5 × `debounceMs`       |
| The pass finishing, the queue, and the run | the allowance, 15 s                 |

The probe signs what the pass's own `git status` listed — each path with its
timestamps, size and inode — and the worktree is hashed only when that moved,
so every pass can afford to look. The interval is not chosen: `timing.ts`
derives it from the budget minus the ceiling the configured debounce implies
and the allowance, capped at 30 s, and a debounce too long for any interval
from 10 s up is refused at start. At the longest debounce accepted, 7 s, the
chain is the budget exactly — a 10 s interval and a 35 s ceiling — and the
allowance is all the slack there is; at the default it keeps a further 5 s. Changing the debounce moves the interval with
it; neither can be changed without the other noticing.

The probe's cost grows with what `status` lists, untracked files most of all:
it lists each one, and each is stat'ed. On one worktree of 10,000 tracked files
a probe pass measured 50 ms with nothing untracked, 102 ms with 5,000 untracked
files and 598 ms with 50,000 — about 11 ms per thousand. A large generated
directory nobody ignored therefore costs about 2% of a core per worktree every
30 s, plus its share of the backstop hash; still well under the hash every
minute it replaces, which on that worktree was 5.6 s a time. Ignoring such a
directory, as a repository should, takes it out of both. The same listing is
what the branch's stored dirty state holds, and the sweep rewrites that row on
every pass: at 50,000 untracked files it is 1.4 MB, written in 3.5 ms — one row
replaced rather than rows accumulating, but that much written per such branch
every 30 s.

A capture that fails — a file nobody can read, git timing out — records no
tree, so the probe would send every pass on the same failing walk. The failure
is remembered with the probe it happened at and retried on a backoff: at the
next pass, then doubling to the ten-minute backstop, and at once if the probe,
the head or the branch moves. While one is outstanding the tree from before it
is never reused: the walk that failed may have been the one a signal asked for.

A full re-hash still runs every ten minutes per worktree. It carries no budget —
the probe does — and exists only for an edit the probe cannot see, which takes
a write that restores the file's mtime in a repository with
`core.trustctime=false`.

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

The discard is checked once, just before the run's Findings are written. An
abort that arrives while they are being written — a window the size of a few
SQLite writes — lets that run complete on content already gone. Accepted rather
than closed: checking again part-way through would leave a run's Findings half
written, and the abort that came in has already queued the run that corrects
them.

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

A manual check — `interlock check` — is outside this: it starts ahead of every
other entry, in the order checks were asked for, and ignores its pair's backoff,
because someone is waiting on it. Aging does not protect the automatic pairs
from that, so a script running checks in a tight loop holds them back for as
long as it runs. Accepted: the route needs the user's token on loopback, and
each check is one pair. A per-repository limit on checks in flight is the
remedy if it is ever seen.

## 5. De-duplicate by content, then ask the verdict cache

A run identifies both sides before anything else: each side's tree — the
watcher's own capture, or a committed head's tree — and the pair's merge base.
That triple is the pair's content. A `SnapshotId` is minted per capture, so two
captures of identical work have different ids and the same trees; ids would
never match. Identification needs no git in steady state: the watcher's
announcement names the tree and head, and a commit's tree and two heads' merge
base never change, so both are remembered once asked.

Two checks follow, cheapest first, and both on the same identity — the verdict
key below. If the pair was last analysed to completion at that identity, the
run stops there: nothing is recorded. The same content in a rebuilt clone is
not the same identity, so it is merged again rather than left with evidence
naming commits that went with the old clone. Otherwise the
store's verdict cache is asked, keyed on the pair in its own order, both trees,
the base, the shadow clone's generation, and the analyzer's fingerprint — its
version, the git version, and a digest of the modules of `@interlock/core` and
`@interlock/shared` — the merge and the classifier, and the redaction excerpts
go through — so a build that changed any of them without bumping the version
is still a miss. The digest is of whatever modules are loaded — `src` under
a test runner, `dist` once built — so the two never share a verdict, and a
number measured in one says nothing about hits in the other. The generation is
there because a verdict keeps its run's
evidence, which names commits made in that clone; a rebuilt clone has none of
them. The in-memory check only remembers each pair's last content; the cache
remembers every content judged, which is what catches an agent reverting and
re-applying a change, and it survives a restart.

A hit is a run of its own — recorded, with its events — that captures,
commits, merges and analyzes nothing. The verdict keeps the analyzer's output,
not Finding ids: reconciliation keeps one Finding per conflict and rewrites its
evidence on every run, so an id would describe whatever content was checked
last. The hit reconciles that output exactly as a run would, so it persists
what a run would. The merge outcome, which escalation needs, comes from the run
that reached the verdict; `cachedFrom` on the analyzer's event names that run.

A verdict about the environment — `infra-failure`, `timeout` — is never cached,
and neither is a superseded run or one that threw. A hit checks for supersession
at the same point a run does, just before it writes Findings.

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

## Restart is re-verification, and that is deliberate

The watcher's record of what it last announced, and the scheduler's record of
what each pair was last analysed at, are both in memory. So on start the
watcher hashes and announces every worktree — clean ones too — every branch
settles, and every pair with a reason to be merged is run again. That is how
Findings left open by the previous run are re-checked against what is on disk
now.

The verdict cache is persisted and does not change that. Every pair is still
run after a restart, because the scheduler's record is still empty; what the
cache changes is the cost. A pair whose content is what it was is answered from
its verdict — re-verified by content identity under the same analyzer and git —
and its open Findings reconciled against it; a pair whose content moved is
merged. Persisting the scheduler's record as well would stop that re-check, and
would need an explicit re-plan at start to replace it.

## Not yet

- Symbol overlap and import edges, which need the AST layer.
- A boost for pairs driven by live agent sessions.
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
