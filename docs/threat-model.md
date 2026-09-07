# Threat model

Reviewed as the sandbox and MCP server evolve.

## What Interlock is trusted with

| Asset                              | Why it matters                                            |
| ---------------------------------- | --------------------------------------------------------- |
| Uncommitted work in user worktrees | exists nowhere else; loss is unrecoverable                |
| Repository source code             | may be proprietary; must never leave the machine          |
| Developer machine and credentials  | the daemon runs with the user's privileges                |
| Agent attention                    | a warning channel that can be poisoned can steer an agent |

## Trust boundaries

1. **User repositories → Interlock.** Read-only.
2. **Merged code → execution.** Code produced by merging two agent branches has been reviewed by nobody. Untrusted input, executed only in the sandbox.
3. **Interlock → agents.** Everything forwarded is content other agents wrote. Untrusted data, wrapped as data.
4. **Localhost API.** Any process on the machine can reach a loopback port; the bearer token is the boundary.

## Threats and mitigations

| #   | Threat                                                                 | Impact                                 | Mitigation                                                                                                                                                                                          | Residual risk                                                                                                                |
| --- | ---------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| T1  | Interlock writes to a user worktree, index or branch and destroys work | unrecoverable data loss                | typed `UserRepo`/`ShadowRepo` split; git runner refuses mutating argv against user repos; state-hash test                                                                                           | a git subcommand missing from the mutating list; keep the list under review                                                  |
| T2  | Merged agent code executes destructive behaviour on the host           | machine compromise                     | Docker: `--network=none`, non-root, read-only mount + tmpfs, cap-drop, pids/CPU/memory/time limits                                                                                                  | container escape; VM isolation would be stronger                                                                             |
| T3  | Repository content or secrets exfiltrated during analysis              | data breach                            | no network in the sandbox; no telemetry; credential files never read; evidence stores spans and truncated excerpts                                                                                  | a build script that reads secrets and writes them into output that becomes evidence — hence redaction on stored evidence too |
| T4  | Prompt injection through peer diffs delivered to an agent              | one agent steers another               | `wrapUntrusted()`: delimiters, truncation, neutralised instruction-shaped lines; minimal payloads; rate limits                                                                                      | a determined injection that reads as ordinary code                                                                           |
| T5  | Another local process reaches the daemon API                           | information disclosure                 | loopback-only bind; bearer token generated at first start, stored 0600                                                                                                                              | any process running as the same user can read the token file; that is the limit of a local-first design                      |
| T10 | A page in the user's browser reaches the daemon API                    | information disclosure                 | bearer token required on every route, including paths that do not exist; the `Host` header must name a loopback address, so a domain resolving to 127.0.0.1 is refused; no CORS header is ever sent | a page that has obtained the token has the same access as any process running as the user                                    |
| T6  | Secrets leak into the store or logs                                    | credential exposure                    | redaction patterns on all log records and evidence; 0700 data dir                                                                                                                                   | pattern-based redaction misses novel formats                                                                                 |
| T7  | Disk exhaustion from shadow worktrees and caches                       | machine unusable                       | one shadow clone per repo with shared objects; disk quota; GC; `daemon stop --purge`                                                                                                                | a single very large repository is still expensive                                                                            |
| T8  | Warning fatigue makes the tool counterproductive                       | real conflicts get ignored             | precision-first matchers; ranking; rate limits; false-positive rate tracked                                                                                                                         | subjective threshold; measure it rather than guessing                                                                        |
| T9  | Supply-chain compromise of a dependency                                | arbitrary code execution during builds | pinned lockfile, dependabot, `pnpm audit` in CI, minimal-dependency policy in `core`, pinned Docker base images                                                                                     | transitive dependencies of the dashboard toolchain remain broad                                                              |

## Non-threats in v1

- Multi-user or team deployments. The moment a server component appears, this document needs a new section.
- Malicious users attacking their own machine.
- Windows-specific attack surface.

## Review checklist

- [ ] Does any new code path write to a user repository?
- [ ] Does any new code path execute repository code outside the sandbox?
- [ ] Does any new agent-facing payload go through `wrapUntrusted()`?
- [ ] Any new listener, and is it loopback + token?
- [ ] Any new stored field that could contain secrets or full file contents?
- [ ] Any new dependency in `core`, and does it have an ADR note?
