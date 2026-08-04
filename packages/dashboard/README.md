# @interlock/dashboard

The localhost React dashboard.

## Views

| View | What it shows |
|---|---|
| Branch map | in-flight branches per repo, dirty state, owning agent session |
| Conflict heatmap | pairwise conflict matrix |
| Finding detail | evidence first: both diffs, symbol trail, analyzer output |
| Event timeline | the replay log |
| Recommended order | advisor output |

## Constraints

- No git, filesystem or Docker access; it only calls the daemon API.
- Not the primary interface — every read path here exists in the CLI.

## Notes

- Dev server binds `127.0.0.1:5273` and proxies `/api` and `/ws` to the daemon on `47317`.
- Types come from `@interlock/shared`, so a model change breaks this build rather than the running page.
- Target: the UI reflects a new Finding within a second.
