---
name: interlock-git
description: Use when writing or changing anything that invokes git — repo discovery, worktrees, dirty-state snapshots, shadow clones, speculative merges, or the fixture repositories that test them (packages/core/src/git/**, packages/core/src/merge/**).
---

# Git operations in Interlock

Interlock reads repositories people are actively working in. A write to a user's
index destroys uncommitted work that was never recoverable in the first place.
Everything here exists to make that impossible rather than unlikely.

## The two handle types

`packages/core/src/git/repo-handle.ts` defines `UserRepo` and `ShadowRepo`.
Mutating functions take a `ShadowRepo`, and `ensureShadow` is the only function
that produces one, so a write against a user path is a compile error rather than
something review has to catch.

Never widen a signature to `AnyRepo` to make something typecheck. If a function
needs to write, it needs a `ShadowRepo`; if it cannot get one, the call site is
wrong.

The type split is the design, not a convention. `isMutatingCommand` enforces the
same rule at run time because types do not survive a `JSON.parse` from the API
layer.

## Invoking git

Always `execFile` with an argument array. Never a shell, never a template
string:

```ts
// wrong — a branch named `--upload-pack=…` or `; rm -rf ~` executes
exec(`git -C ${repo.rootPath} log ${branch}`);

// right
runner.run(repo, ['log', '--format=%H', branch]);
```

Branch names, paths and refs are attacker-controlled in this product: they come
from repositories written by AI agents. Treat every one as hostile input.

Set on every invocation:

- `-C <path>` rather than `process.chdir` — the daemon watches several repos
  concurrently and `chdir` is process-global.
- `GIT_TERMINAL_PROMPT=0` so a credential prompt fails instead of hanging.
- `GIT_OPTIONAL_LOCKS=0` so read commands never take `index.lock`. Without this
  a plain `git status` can block the user's own git.
- `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null` so a user's
  aliases, hooks or `merge.tool` cannot change behaviour or execute code.
- A timeout and `maxBuffer`. A hung git must not wedge the daemon.

Use `-z` and NUL-separated parsing for anything listing paths. Git paths may
contain spaces, quotes and newlines, and newline-splitting `git diff --name-only`
is the classic way to corrupt a file list.

## Never touching the user's index

To snapshot uncommitted work, point git at a different index:

```ts
// GIT_INDEX_FILE outside the repo; objects are additive and safe, the index is not
const tmpIndex = join(tmpdir(), `interlock-${ulid()}.index`);
await runner.run(repo, ['add', '-A'], { env: { GIT_INDEX_FILE: tmpIndex } });
const tree = await runner.run(repo, ['write-tree'], { env: { GIT_INDEX_FILE: tmpIndex } });
```

Writing objects into the user's object database is fine — it is append-only and
`git gc` reclaims anything unreferenced. Writing `.git/index`, moving refs,
stashing or changing config is not, ever.

Always remove the temp index on the error path too. Prefer `try/finally` over
cleanup at the end of the happy path.

## Merging without a worktree

Prefer `git merge-tree --write-tree` (git 2.38+) over checking out a worktree
and running `git merge`. It performs a real `ort` merge entirely in the object
database, returns the resulting tree, and reports conflicts — with no checkout,
no working directory and no lock.

This matters more than it looks. Interlock analyses N(N-1)/2 pairs continuously,
and a worktree checkout per pair is the difference between fitting a laptop CPU
budget and not.

**`merge-tree` is not a semantic filter.** It answers "do these two conflict
textually", and a semantic conflict is by definition a merge that came out
clean — so it walks straight through. Every clean merge is still a typecheck
candidate. What decides the real cost is the scheduler's overlap test, not the
merge.

When an analyzer must execute the merged code, use the **per-pair worktree pool**
(ADR-0005) — a small LRU set of persistent worktrees, one per hot pair. Update a
slot by delta, never by rebuilding it:

```
tree=$(git merge-tree --write-tree "$a" "$b")   # 12.8 ms on a 794k-line repo
commit=$(git commit-tree "$tree" -m speculative)
git -C "$slot" reset --hard "$commit"           # rewrites only what differs
```

Extracting the whole tree instead costs 1.62 s on that repo — two orders of
magnitude more than the merge, and unaffordable per check.

- Pool worktrees keep a **detached HEAD**, so no branch ref moves and the
  throwaway commits stay unreferenced for `gc`.
- `reset --hard` is a mutating command, allowed here only because pool
  worktrees belong to the shadow clone. The runtime check still applies.
- Symlink `node_modules` from the user's checkout instead of installing.
- `.tsbuildinfo` stays in the slot between checks. That persistence is the
  entire reason continuous checking is affordable, so never clear a slot as a
  "cleanup" step.

The symlink is only valid while dependencies match. If either branch changed
`package.json` or the lockfile, that pair needs a slower path with a real
install — or it skips the semantic check and says why. Silently typechecking
against the wrong dependency tree produces confident nonsense.

## Conflicts are results, not errors

A conflicted merge is a successful analysis with a finding. Throw only when the
merge could not be attempted at all: missing object, no merge-base, git absent.
Returning an empty result for a failed run would let a broken analyzer look like
"no conflicts found", which is the worst possible failure mode for this product.

Environmental failures are `infra-failure`, never a `Finding`.

## Testing git code

Integration tests over unit tests. A unit test with a mocked `GitRunner` proves
the mock works. Build a real repository in a temp directory:

- Create it with `git init`, commit through the runner, and tear the directory
  down in `afterEach` even when the test failed.
- Set `user.name` and `user.email` locally in the fixture; CI has no global git
  identity and `git commit` will fail without them.
- Set `-c init.defaultBranch=main` explicitly rather than depending on the
  runner's git version.
- Never depend on the ambient repository. A test that runs `git` in the
  Interlock checkout will pass locally and behave unpredictably in CI.

Cover these cases whenever you touch discovery, snapshots or merges — each has
broken a real tool: a repository with no commits; a detached HEAD; a branch
checked out in a linked worktree; a worktree directory deleted while its
administrative file remains; two branches with no common ancestor; a path
containing a space and a path containing a newline; a file that is binary; a
rename plus an edit on the same path.

The suite in `packages/core/test/user-repo-untouched.test.ts` hashes worktree,
index, refs, stash and config before and after a run. Any new git code path gets
exercised by it. It is never skipped and never weakened — a failure there means
Interlock corrupted someone's work.
