# Security

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting on this
repository, or email **aaqilahmadd@gmail.com**.

Include what the issue is, how to reproduce it, and the affected commit. Expect
an acknowledgement within a few days.

## Design commitments

Interlock reads repositories people are actively working in and executes code
produced by merging AI-written branches. Both are unusual powers for a developer
tool, so the following are enforced by types and tests rather than by intent:

- Interlock never writes to a user's repository — worktree, branch, index, stash
  or config. Writes target a shadow clone under Interlock's own data directory.
- Merged code never executes on the host. It runs only inside a container with
  no network, non-root, under resource limits.
- Nothing leaves the machine. Services bind `127.0.0.1` only, authenticated with
  a locally generated token. There is no telemetry.
- Credential files are never read, and secret patterns are redacted from logs and
  stored evidence.

Interlock is early and these commitments land with the code that implements
them; `docs/threat-model.md` records what is enforced today, what is not yet, and
the residual risks either way.
