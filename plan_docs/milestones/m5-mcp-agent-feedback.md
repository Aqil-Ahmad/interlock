# M5 — MCP server and agent feedback

**Goal:** Agents adapt mid-task instead of colliding blindly. This is the
product bet — everything before it only tells a human.

**Exit criteria:** the same two-agent collision, recorded with and without
Interlock enabled. With it, at least one agent visibly changes course —
acknowledges the peer change, edits elsewhere, or coordinates. Transcripts
archived as evaluation artifacts.

**Depends on:** M4.

## Tasks

- [ ] **Expand this milestone before starting it**
      **Files:** this file
      **What:** the tasks below are one line each. Rewrite them to the depth of `m1-watcher-and-git-core.md` — per-task edge cases, failure modes, the tests each needs, and the constraints it can breach by accident.
      **Done when:** every task below carries a `Done when` naming an observable check, and nothing in it contradicts what earlier milestones learned.

- [ ] **Server lifecycle**
      **Files:** `packages/mcp-server/src/server.ts`, `packages/mcp-server/src/main.ts` (create in this milestone)
      **What:** the `interlock-mcp` binary, loopback only, authenticating to the daemon with its bearer token.
      **Done when:** an agent can connect and list tools.

- [ ] **Implement the four tools**
      **Files:** `packages/mcp-server/src/tools/index.ts`
      **What:** the schemas already exist — `get_conflicts_for_my_branch`, `check_file_overlap`, `get_pending_changes`, `propose_merge_order`.
      **Done when:** each returns real data from the daemon API and nothing a human could not see in `interlock status`.

- [ ] **Rate limiting**
      **Files:** `packages/mcp-server/src/`
      **What:** cap deliveries at `mcp.maxWarningsPerHour` per session.
      **Done when:** a noisy repo cannot flood a session. Whatever sorts to the top is effectively the only thing that gets said, so the cap and the ranking have to work together.

- [ ] **Injection boundary**
      **Files:** `packages/mcp-server/src/sanitize.ts`
      **What:** `wrapUntrusted` is written; make sure every payload path uses it.
      **Done when:** a peer branch containing text shaped like instructions is delivered as delimited data and cannot be read as a command by the receiving agent. Add that adversarial case to the test suite.
      **Constraints:** this package is the prompt-injection boundary. Content forwarded here was written by another agent and is hostile until proven otherwise.

- [ ] **Claude Code integration recipe**
      **Files:** `docs/`
      **What:** hooks plus a CLAUDE.md snippet so sessions consult Interlock before large edits.
      **Done when:** a fresh session picks it up with no manual wiring.

- [ ] **Dogfood**
      **What:** run Interlock on this repository while developing it.
      **Done when:** every false positive it produces is filed as an issue. This is the cheapest source of real evaluation data available.
