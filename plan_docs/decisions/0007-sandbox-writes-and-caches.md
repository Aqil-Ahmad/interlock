# ADR-0007: Sandbox writes and caches

- **Status:** accepted
- **Date:** 2026-10-13

## Context

ADR-0004 puts merged code in Docker "read-only with a tmpfs overlay". Docker
cannot lay a tmpfs over a bind mount, so that phrase does not describe anything
Docker can do, and something else has to say where a sandboxed command writes.
Three things want to write:

- every tool, somewhere: a home directory, `/tmp`, a compiler's scratch files;
- a build, into its own tree: `dist/`, `.tsbuildinfo`;
- ADR-0005's per-slot incremental state — `.tsbuildinfo` and the build
  orchestrator's cache — which must survive between checks of a slot or every
  check pays the cold cost.

What binds every answer: **no write made inside the container is ever trusted
by the host.** Merged code can write a symlink pointing at `~/.ssh` into any
writable mount. Anything the host later reads from that mount follows it — a
`git reset --hard` in the slot, the in-process type checker reading files, a
cleanup that walks the directory.

The daemon's data dir is 0700, and the slot lives in it, so the container's uid
decides whether the tree is readable at all.

Measured on 2026-10-13, Linux, Docker 29.8.2, a synthetic tree the size of
archestra's (293 MB, 6,605 files): copying it from a read-only bind mount into a
tmpfs inside the container, `cp -a`, five runs — 515, 411, 393, 377, 423 ms,
median 411 ms. A container start and stop with nothing to do is about 285 ms.

Measured too: a bind mount nested under a tmpfs gets its mount point directories
created by Docker, owned by root. A non-root command cannot write into them, so
"copy the tree into the tmpfs and mount dependencies inside the copy" fails for
any package below the root.

## Decision

1. **The tree is read-only, always.** It is bind-mounted read-only at `/work`.
   Dependencies mount read-only at their tree-relative positions under `/work`,
   so a relative pnpm workspace link resolves into the merged tree. The
   container's root filesystem is `--read-only` as well.
2. **Writes go to one tmpfs, at `/tmp`,** owned by the container's uid, mode
   0700, `nosuid,nodev`, sized to the memory limit (its pages are charged to
   the container's memory anyway). `HOME` points at it. It disappears with the
   container, and nothing in it reaches the host.
3. **A per-slot cache directory may be mounted writable,** at a path outside
   `/work`, and only from under a cache root the caller names. The runner
   refuses a writable mount outside that root, a cache root that overlaps the
   tree or a read-only source, and a socket or device as any source.
4. **The host never follows, reads or executes a cache.** It only ever deletes
   one, with a removal that unlinks symlinks rather than following them. A
   slot's cache is wiped when the slot is evicted or refilled, and when the
   dependency checkout it was built against changes. A poisoned cache can
   therefore reach only the later checks of the same pair, inside the sandbox,
   where all it can do is make that pair's result wrong — which the build
   analyzer must treat as it treats any other result from merged code.
5. **A build that writes into its tree copies it into the tmpfs first**
   (411 ms median at archestra's size, and counted against the memory limit).
   Because nested mount points are root-owned, the copy cannot have
   dependencies mounted inside it; the build analyzer has to solve that before
   relying on the copy, and until it does, a build whose workspace links would
   resolve outside the copy is `infra-failure`, never a result. That analyzer
   is where the layout is built; this record fixes only that the slot itself
   is never written.
6. **The container runs as the daemon's uid and gid.** That keeps the 0700
   data dir readable without loosening it. A daemon running as root is
   **refused with a remedy** rather than given a fixed unprivileged uid: a
   fixed uid can read the slot only if the data dir is opened to it, which is
   a weaker posture than ADR-0004's. On macOS Docker Desktop maps ownership
   across its file sharing; a data dir outside its shared paths fails the
   mount, and that failure is `SANDBOX_UNAVAILABLE`.

The remaining flags are ADR-0004's, made concrete: `--network none`,
`--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit`, `--cpus`,
`--memory` with `--memory-swap` equal to it, `--pull=never`, `--init`, and
`--log-driver none` so a command's output is never written to the Docker
host's disk. The wall-clock limit runs on the host.

## Consequences

**Easier:** the question "can a container write reach the host?" has one
answer per path — the tree is read-only, the tmpfs dies with the container, and
the cache is only ever deleted. `reset --hard` in a slot keeps working on files
no container could have touched.

**Harder:** builds pay a copy per check (about 0.4 s at archestra's size) and
the build analyzer inherits the nested-mount problem. Running the daemon as
root stops execution analyzers until it is run as a user.

**Committed to:** the cache wipe on eviction, refill and dependency change,
which the build analyzer must wire before it mounts a cache at all. Reversing
the read-only tree means re-deriving every claim above.

**Differs from ADR-0004, for a human decision (hard rule 8):** ADR-0004 names a
tmpfs _overlay_; this records a tmpfs beside a read-only tree, since an overlay
is not possible, and adds a writable per-slot cache mount ADR-0004 does not
mention. Neither loosens what the host trusts, but both change the posture's
wording; accepted by the maintainer on 2026-10-15.

## Alternatives considered

- **Copy the tree into the tmpfs for every run.** Simple, and builds just work —
  but it charges 0.4 s and the tree's size in memory to every command,
  including ones that never write, and it does not compose with dependency
  mounts below the root (see Context). Kept for builds only.
- **Mount the tree writable.** Rejected outright: the host runs `reset --hard`
  in the slot and the type checker reads it, so a planted symlink would be
  followed on the host.
- **No cache.** Safest, and every build check pays the cold cost — 88.8 s
  against 1.85 s for turbo on openselfservice (ADR-0005). The cache's risk is
  bounded by 3 and 4 above; its absence is not bounded at all.
- **A fixed unprivileged uid when the daemon is root.** Needs the data dir, or
  the slot, readable by that uid. Opening a 0700 directory to make the sandbox
  work trades one isolation property for another; refusing costs only running
  the daemon as a user, which is how it is meant to run.
- **Overlayfs inside the container.** Needs `CAP_SYS_ADMIN` or a user namespace
  in the container, which `--cap-drop ALL` is there to deny.
