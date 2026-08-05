# Contributing

## Branches

| Branch | What it is                                                                                 |
| ------ | ------------------------------------------------------------------------------------------ |
| `dev`  | Integration branch and the default. Every pull request targets this.                       |
| `main` | Release-only. Receives merges from `dev` at release time, and hotfixes. Tags are cut here. |

**Open your pull request against `dev`.** It is the repository default, so GitHub
selects it automatically — check the base branch anyway if you created the PR
from a fork or from the command line, because a PR that lands on `main` ships
straight to a release.

Branch off `dev`, not `main`:

```bash
git switch dev && git pull
git switch -c short-descriptive-name
```

## Before opening a pull request

```bash
pnpm verify        # build + lint + format + typecheck + test
```

CI runs the same checks on Node 24 and 26, on Linux and macOS. A change is done
when code, tests and docs land together, with a `CHANGELOG.md` entry if it is
user-visible.

## Licensing

Interlock is AGPL-3.0-only with a commercial exception, so contributions need
agreement to the [CLA](CLA.md). You keep the copyright in your work; the
agreement grants the right to sublicense it. An automated check will prompt you
on your first pull request.

## The rules that are not negotiable

`CLAUDE.md` holds the working agreement, and its "Hard rules" section applies to
everyone, not just AI sessions. The short version: never write to a user's
repository, never execute repository code outside the sandbox, never bind
outside `127.0.0.1`, never forward repository content to an agent unwrapped, and
never weaken a failing test to make CI pass.

Anything touching git operations, code execution, network listeners or agent
payloads gets a security review. Weakening a guarantee in `SECURITY.md` is a
regression, not a refactor.

Architectural changes are proposed and recorded as an ADR before they are
implemented — `pnpm adr "short title"`.
