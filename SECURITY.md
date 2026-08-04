# Security

Interlock watches repositories people are actively working in and executes code produced by merging AI-written branches. Both are unusual powers for a developer tool, so the security posture is a design constraint rather than a feature. Full analysis: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and [ADR-0004](docs/adr/0004-security-posture.md).

## Guarantees

| Guarantee                                  | How it is enforced                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interlock never modifies your repositories | `UserRepo`/`ShadowRepo` type split; git runner refuses mutating commands against user repos; test hashing user-repo state before and after full runs |
| Merged code never executes on your host    | all execution goes through Docker: `--network=none`, non-root, read-only mount + tmpfs, cap-drop, CPU/memory/PID/time limits                         |
| Nothing leaves your machine                | daemon and MCP bind `127.0.0.1` only, bearer-token authenticated; no telemetry                                                                       |
| Secrets are not collected                  | credential files are never read; secret patterns are redacted from logs and stored evidence; the data dir is 0700                                    |
| Agent payloads cannot smuggle instructions | repository content is wrapped as delimited data, truncated, with instruction-shaped lines neutralised                                                |

## Reporting a vulnerability

Do not open a public issue. Email the maintainers with:

- what the issue is and which guarantee above it breaks;
- reproduction steps or a proof of concept;
- affected version or commit.

Fixes for anything touching the guarantees above take priority over feature work.

## Scope

**In scope:** writes to user repositories; sandbox escape or host execution of merged code; secret leakage into the store, logs or evidence; unauthenticated or non-loopback network exposure; prompt injection reaching an agent through Interlock's payloads.

**Out of scope for v1:** multi-user and team deployments; Windows; attacks requiring an already-compromised machine or the same-user privileges the daemon itself runs with.

## For contributors

Any change touching git operations, code execution, network listeners or agent payloads gets a security review. Weakening a guarantee is a security regression, not a refactor.
