# Demo 00 — Reproducing the problem by hand

**Goal:** establish, with no Interlock code involved, exactly what the product must detect — and how invisible both failures are until merge time.

**Status:** template. Fill in with a real fixture; a teammate should be able to reproduce both walkthroughs from this document alone.

## Setup

```bash
git init /tmp/interlock-demo && cd /tmp/interlock-demo
# create a small TypeScript project with an exported function and a caller
git worktree add ../demo-branch-a -b feature/a
git worktree add ../demo-branch-b -b feature/b
```

Record: repo layout, initial commit sha, node and git versions.

## Part 1 — Textual conflict

Two branches edit the same lines of the same function.

1. On `feature/a`: <!-- exact edit -->
2. On `feature/b`: <!-- exact edit -->
3. `git merge` → conflict.

Capture:

- the conflict markers git produces (raw material for `merge/conflict-classifier.ts`);
- how long both branches worked before anyone found out;
- what `git merge --no-commit` would have said if run earlier — the PR-time baseline.

## Part 2 — Semantic conflict

Both branches merge cleanly and the result does not compile.

1. On `feature/a`: rename an exported function, updating all of its call sites on that branch.
2. On `feature/b`: add a new call to the old name.
3. Each branch typechecks green on its own.
4. `git merge` → clean merge, no conflict markers, nothing to review.
5. `tsc` on the merged result → error.

Capture:

- proof that each branch is green alone (both outputs);
- proof the merge is clean;
- the exact compiler error, and which branch each half of it came from;
- the AST-level shape: symbol renamed on A, referenced on B. That shape is what `ast/matchers.ts` implements as `rename-vs-callsite`.

## What this establishes

1. Textual conflicts are found late, but git does find them.
2. Semantic conflicts are found later still, by a build or a test, and git never finds them.
3. Both were fully determined minutes after the second edit. Everything after that point was avoidable waste.

That gap between determined and discovered is what the product closes.

## Artefacts

Keep the repo tarball, terminal transcripts and timings; this hand-run becomes the first golden fixture and the first regression test.
