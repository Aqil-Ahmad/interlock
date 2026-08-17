# ADR-0005: Per-pair worktree pool

- **Status:** accepted
- **Date:** 2026-08-16

## Context

Measurements on 2026-08-16, against archestra (793,784 lines of backend
TypeScript, 644 MB of history) and interlock itself:

| Step                                          | Median  | Notes                               |
| --------------------------------------------- | ------- | ----------------------------------- |
| `git merge-tree --write-tree`                 | 12.8 ms | 10 runs. Free at real scale.        |
| Materialise merged tree, `git archive \| tar` | 1.62 s  | 5 runs, 276 MB, 6,605 files.        |
| `tsc` process start and compiler load         | 436 ms  | Fixed, independent of project size. |
| `tsc` cold, no build info                     | 1084 ms | interlock, 2,781 lines.             |
| `tsc` warm, nothing changed                   | 443 ms  | Essentially the floor.              |
| `tsc` warm, one file changed                  | 786 ms  | 350 ms of real work.                |

Three things follow. Materialising a full tree per check costs more than the
merge by two orders of magnitude and cannot be paid per check. Cold typechecking
scales with dependency declaration volume and source size, which rules it out
per pair per change on a large repository. Incremental typechecking scales with
the size of the change instead — but only while `.tsbuildinfo` and the
compiler's own state survive between checks.

An earlier decision, recorded in `log.md` and in M2 rather than in an ADR, was a
single reusable scratch worktree per repository. That is now wrong: rotating one
directory between pairs discards incremental state on every switch and pays the
cold cost each time. Round-robin fairness across pairs would be the worst
possible scheduling strategy.

## Decision

Keep a small LRU pool of persistent per-pair worktrees under Interlock's data
directory. Default size 4, configurable. A pair enters the pool only after the
overlap pre-filter marks it worth watching.

Each check updates a slot by delta rather than rebuilding it:

1. `git merge-tree --write-tree` produces the merged tree.
2. `git commit-tree` wraps that tree in a throwaway commit.
3. `git reset --hard <commit>` inside the pair's pool worktree, which rewrites
   only the files that actually differ.

Pool worktrees keep a **detached HEAD**, so no branch ref moves and the
throwaway commits stay unreferenced for `git gc` to reclaim.

`node_modules` is symlinked from the user's checkout — verified working: `tsc`
resolves correctly through the symlink from a tree at a different path, with the
root and every package's `node_modules` linked. The compiler binary must be
invoked **directly**, never through `pnpm exec`, which runs a dependency check
and tries to `pnpm install` inside the scratch directory. If either branch or the
merge touches `package.json` or the lockfile, the pair is marked `deps-dirty`
and routed to a slow path with a real install, or skipped with a stated reason —
typechecking against the wrong dependency tree produces confident nonsense.

`.tsbuildinfo` **and the build orchestrator's cache** persist per slot — measured
on openselfservice, turbo's `.turbo` directory was 54 MB and the difference
between keeping it and losing it is 1.85 s against 88.8 s. Eviction discards it and forces a cold entry
later, so eviction is expensive and the scheduler must treat it as such.

This works because TypeScript keys incremental state on file content, not mtime.
Measured on interlock: rewriting every source file with identical bytes costs
439 ms against 437 ms untouched and 1036 ms cold — so a `reset --hard` that
changes few files invalidates only those files.

## Consequences

**Easier:** the per-check cost becomes proportional to the change rather than to
the repository, which is what makes continuous semantic checking possible at all.
The pool slot doubles as the project root for a hosted TypeScript
LanguageService in M3, so the 436 ms process floor is paid once per hot pair
rather than once per check.

**Harder:** disk. Four persistent worktrees of a large repository is real space,
so the quota and GC policy stop being nice-to-have. Pool sizing becomes a tuning
problem with no obvious right answer, and eviction is now a scheduling decision
with a measurable cost rather than a cache detail.

**Committed to:** `reset --hard` inside pool directories. This is a mutating git
command, permitted only because pool worktrees belong to the shadow clone and
are therefore `ShadowRepo`. The type split and the runtime `isMutatingCommand`
check both still apply, and `packages/core/test/user-repo-untouched.test.ts`
must keep passing unchanged — if a pool path is ever derived from a user repo,
that test is the thing that catches it.

Also committed to: the scheduler preferring hot pooled pairs over rotating new
ones. Stickiness is now a cost control of the same rank as overlap filtering.

## Alternatives considered

- **Single shared scratch worktree** — the previous decision. Rejected: every
  rotation between pairs throws away incremental state and pays the cold cost,
  which is the dominant term.
- **A fresh worktree per pair per check** — the original plan. Rejected on the
  1.62 s materialisation measurement alone.
- **No worktree at all, feeding the compiler from the object database through a
  virtual filesystem** — removes disk cost entirely and is the interesting
  long-term answer, but it is a large piece of work against TypeScript's module
  resolution and is not justified before the simple version is measured in
  practice.
- **One pool slot per branch rather than per pair** — cheaper on disk, but a
  merged tree belongs to a pair, not a branch, so the incremental state would be
  invalidated by every partner change anyway.
