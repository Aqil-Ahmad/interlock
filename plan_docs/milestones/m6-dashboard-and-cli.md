# M6 — Dashboard and CLI

**Goal:** The thing people can see.

**Exit criteria:** a stranger follows the README quickstart on a fresh machine
and reaches a live conflict heatmap in 10 minutes or less. The UI updates within
a second of a Finding.

**Depends on:** M5.

## Tasks

- [ ] **Expand this milestone before starting it**
      **Files:** this file
      **What:** the tasks below are one line each. Rewrite them to the depth of `m1-watcher-and-git-core.md` — per-task edge cases, failure modes, the tests each needs, and the constraints it can breach by accident.
      **Done when:** every task below carries a `Done when` naming an observable check, and nothing in it contradicts what earlier milestones learned.

- [ ] **Bring the dashboard back into the build**
      **Files:** `packages/dashboard/package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`
      **What:** install react, react-dom, vite, `@vitejs/plugin-react`, the type packages, jsdom and testing-library, then re-add the package to the workspace, the solution tsconfig and the Vitest projects. It was excluded from all three because it declared no dependencies.
      **Done when:** `pnpm verify` passes with the dashboard included.

- [ ] **Branch map**
      **Files:** `packages/dashboard/src/`
      **What:** what is in flight per repo, with dirty state and owning session.

- [ ] **Conflict heatmap**
      **Files:** `packages/dashboard/src/`
      **What:** the pairwise grid. This is the screenshot the product is sold on.

- [ ] **Finding detail**
      **Files:** `packages/dashboard/src/`
      **What:** both diffs, the symbol trail, analyzer output, and which branch introduced which half.
      **Done when:** a developer can decide what to do without leaving the page.

- [ ] **Event timeline**
      **What:** the `causedBy` chain, rendered. Walk a Finding back to the edit that caused it.

- [ ] **WebSocket updates**
      **Files:** `packages/daemon/src/api/`, `packages/dashboard/src/lib/api.ts`
      **Done when:** a Finding appears without a refresh, under a second.

- [ ] **`interlock init`**
      **Files:** `packages/cli/src/commands/`
      **What:** set up a repo including agent hooks and the MCP config.
      **Done when:** under two minutes on a repo the tool has never seen.

- [ ] **Daemon UX**
      **Files:** `packages/cli/src/commands/`
      **What:** `daemon start|stop|status|logs`, autostart, and `stop --purge` as the kill switch.
      **Done when:** someone can turn it off and reclaim all disk without reading docs.

- [ ] **`interlock doctor`**
      **What:** diagnose git, Docker, toolchain and permissions.
      **Done when:** each failure names the fix, not just the fault.
