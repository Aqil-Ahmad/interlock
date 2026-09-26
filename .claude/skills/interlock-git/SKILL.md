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
Mutating functions take a `ShadowRepo`, and only `ensureShadow` produces one —
or the worktree pool, which derives a handle per slot from the shadow
`ensureShadow` returned — so passing a `UserRepo` to a write is a compile error
rather than something review has to catch. The type is structural: a hand-built
`ShadowRepo` would typecheck, and the pool can check only the shape of the
shadow it is given, not where it came from. Never build one by hand.

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

Close the child's stdin. Nothing here writes to git, and a command that reads it
— `hash-object --stdin`, `update-index --stdin` — otherwise blocks on an open
pipe until the timeout kills it: 30 s instead of 8 ms.

A repository's `.interlock.json` is attacker-controlled the same way its branch
names are. Never build a regex from anything in it: a glob alternating wildcards
with literals takes 20 seconds at 33 characters once translated, on the event
loop, for every branch it is tried against. Scan instead.

Use `-z` and NUL-separated parsing for anything listing paths. Git paths may
contain spaces, quotes and newlines, and newline-splitting `git diff --name-only`
is the classic way to corrupt a file list.

## Never touching the user's index

To snapshot uncommitted work, point git at a different index:

```ts
// An index outside the repo; objects are additive and safe, the index is not
const tmpIndex = join(mkdtempSync(join(tmpdir(), 'interlock-')), 'index');
await runner.run(repo, ['add', '-A'], { indexFile: tmpIndex });
const tree = await runner.run(repo, ['write-tree'], { indexFile: tmpIndex });
```

Writing objects into the user's object database is fine — it is append-only and
`git gc` reclaims anything unreferenced. Writing `.git/index`, moving refs,
stashing or changing config is not, ever.

A snapshot that will be merged is captured with `objectStore` set to the
repository's shadow. The runner then points `GIT_OBJECT_DIRECTORY` at the
shadow's store, which borrows the user's objects through alternates, so reads
still work and every write lands where the user's `gc` cannot reach it.
Captured without it, the tree is unreferenced in the user's store and can be
collected from under a commit in the shadow that points at it.

A snapshot commit's parent is the commit the snapshot was captured against —
`WorktreeSnapshot.headSha` — never whatever a ref names when the commit is made.
Parented on a branch that has moved since, the commit's changes include that
branch's new work in reverse.

Always remove the temp index on the error path too. Prefer `try/finally` over
cleanup at the end of the happy path.

`indexFile` is the runner's only environment capability, deliberately. The
runner strips inherited `GIT_*` variables so a user's shell cannot redirect a
command, and an open environment map would hand that redirection straight back
to any caller.

Redirecting the index protects the index and nothing else. Three flags walk
straight past it:

- `read-tree -u` updates the **working tree** to match the index it built, so a
  redirected index only means it overwrites uncommitted edits from a different
  tree.
- `read-tree --index-output=<path>` overrides `GIT_INDEX_FILE`, so the path that
  was validated is not the path git writes.
- `update-index --split-index` leaves a `sharedindex.*` file in `$GIT_DIR`
  whatever `GIT_INDEX_FILE` says.

So classify flags with an **allowlist per verb**, never a list of dangerous ones.
A denylist of flags fails open exactly as a denylist of verbs does, and none of
these three reads like a write. Two properties of git's parser decide how to
match:

- **Any unambiguous prefix resolves.** `--index-out=`, `--index=` and `--i=` are
  all `--index-output=`; `--d` is `--delete`. Match long flags by prefix, and
  only against names git really has — an invented one licenses abbreviations
  that resolve somewhere else.
- **Short flags bundle.** `-um` enables `-u`, so match per character.

The same letter means different things to different verbs — `-u` on `add` is
`--update` and harmless, `-u` on `read-tree` writes the worktree — so the
allowlist is keyed by verb, never global. Stop scanning at `--`: a file named
`-u` is a path.

Validate a redirection with `realpath`, never `resolve`. `resolve` normalises a
path; it does not follow a symlink, and on macOS `tmpdir()` returns
`/var/folders/...` for a directory whose real path is `/private/var/folders/...`,
so two names for the same file compare as different. The index file does not
exist yet, so resolve its parent directory and rejoin the basename.

Test containment on whole path segments. `relative('/repo', '/repo/..bak')`
returns `'..bak'`, so a `..` prefix test calls a path inside the repository
outside it — compare against `'..'` and `'..' + sep`.

Check the redirection against the **shared** git directory too. A linked
worktree's git dir is `<main>/.git/worktrees/<name>`, so its handle names neither
the main checkout nor `<main>/.git` — and the index a redirection must miss lives
in both.

## Merging without a worktree

Prefer `git merge-tree --write-tree` (git 2.38+) over checking out a worktree
and running `git merge`. It performs a real `ort` merge entirely in the object
database, returns the resulting tree, and reports conflicts — with no checkout,
no working directory and no lock.

This matters more than it looks. Interlock analyses N(N-1)/2 pairs continuously,
and a worktree checkout per pair is the difference between fitting a laptop CPU
budget and not.

Run it as `git --attr-source=<commitA> merge-tree --write-tree -z
--merge-base=<base> <A> <B>`. A bare clone has no worktree to read
`.gitattributes` from, so without `--attr-source` every attribute that shapes a
merge is silently dropped and the shadow disagrees with the user's real merge.
That form needs git 2.41; older git answers it with exit 129, which is the
capability check — a probe for `--write-tree` passes on 2.38 and 2.39, which
cannot run it. A conflicted merge still writes a tree with markers in it, so
conflict regions come from `cat-file` on that tree, never from a checkout, and
the message types come from the `-z` token field, never the prose. A binary
conflict is reported as `CONFLICT (binary)` and `CONFLICT (contents)` both.

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
- Link nothing into a slot. The in-process type checker resolves dependencies
  from the dependency checkout through its host, and a sandboxed command mounts
  what it needs; a host symlink does not exist inside the container.
- `.tsbuildinfo` stays in the slot between checks. That persistence is the
  entire reason continuous checking is affordable, so never clear a slot as a
  "cleanup" step.
- Fill a new slot with `worktree add --detach --no-checkout` and then the same
  `reset --hard`. A plain `add` checks out in a child process, and killing
  `add` — a runner timeout does — leaves that child writing into the slot with
  nothing left to stop it.
- A slot is a worktree, so git gives it a `HEAD` reflog although the shadow is
  bare, and every throwaway commit stays reachable for 90 days. The shadow
  sets `core.logAllRefUpdates=false`. A slot's `HEAD` is a root for `prune`;
  `ORIG_HEAD` is not.
- `SIGTERM` lets git remove its own `index.lock`; `SIGKILL` leaves it, and every
  later command in that slot fails on it. An interrupted `add` leaves a
  `locked` file that `worktree remove` refuses without `--force --force` and
  `worktree prune` skips.
- The first update after a cold fill re-reads every file written in the same
  second as the index: git compares timestamps at one-second resolution and
  cannot trust those. On a 6,500-file tree that is 0.1–2.8 s, about the fill
  again. Time the updates after it, never the first one alone.

The dependency checkout is only valid while dependencies match. If either
branch changed `package.json` or the lockfile, the slot is deps-dirty against
that checkout's tree, and the pair needs a slower path with a real install — or
it skips the semantic check and says why. Silently typechecking against the
wrong dependency tree produces confident nonsense.

What a conflict looks like in that output, checked against git 2.55, since
the classifier keys on it:

- add/add is `CONFLICT (contents)` with no stage 1, and diff3 does not narrow
  its region — the whole file is one region with an empty base.
- A rename on one side and a colliding edit on the other is plain `contents`,
  with every stage recorded under the new name. The unrenamed side's own path
  is found by its blob in its own commit, never by parsing marker labels.
- modify/delete and rename/delete carry no binary verdict, and a file turned
  symlink against a delete is `modify/delete` too — check the mode and the
  content before reading lines out of either side.

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

Fixtures may assume POSIX. Tests shell out to `#!/bin/sh` spy scripts, set modes
with `chmod`, and stub `HOME`; CI runs ubuntu and macOS only. Write the clearest
POSIX fixture rather than a portable one, and if Windows is ever supported this
is the decision to revisit — in one place, not per test.

A fixture that commits must switch off auto-maintenance:

```ts
git(path, 'config', 'maintenance.auto', 'false');
git(path, 'config', 'gc.auto', '0');
```

Since git 2.47, `commit` spawns `git maintenance run --auto --detach`, and that
child holds `objects/maintenance.lock` for a moment _after_ `commit` has
returned. A test that hashes the git dir right after a commit can capture the
lock on one side and not the other, and then reports a removal nothing in
Interlock made. Apple's git on a developer Mac is older and does not detach, so
this never reproduces locally and fails only on the macOS CI runner, under load.
Interlock itself runs nothing that triggers maintenance — only the fixture's own
git does.

Git's help output is not a stable format. 2.39 prints `-n, --dry-run` where 2.55
prints `-n, --[no-]dry-run`, so a test reading `git <verb> -h` must parse flag
names out and treat `--[no-]x` as both `--x` and `--no-x`. Matching the
surrounding prose passes on the local git and fails on whatever CI has.

The suite in `packages/core/test/user-repo-untouched.test.ts` hashes worktree,
index, refs, stash and config before and after a run. Any new git code path gets
exercised by it. It is never skipped and never weakened — a failure there means
Interlock corrupted someone's work.
