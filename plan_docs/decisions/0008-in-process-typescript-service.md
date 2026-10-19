# ADR-0008: TypeScript in core, as a language service per slot in a worker thread

- **Status:** accepted
- **Date:** 2026-10-14

## Context

The compiler is Interlock's semantic detector. ADR-0005 measured the cost of
asking it through `tsc`: 436 ms of process start and compiler load before any
work, against about 350 ms of real work for an incremental check. Paid per
check, the floor is most of the cost. So the M3 typecheck runner hosts the
TypeScript language service in the daemon and keeps one alive per hot pool
slot, which needs three decisions this record makes together.

**A dependency in `core`.** Hard rule 7. `typescript` is the compiler itself;
there is no lighter way to host it.

**Where the service runs.** A check is synchronous inside the compiler. Measured
on this repository's committed tree (46,637 lines of TypeScript across six
projects, checked through its solution tsconfig) on a 4-core Linux container,
Node 22.22 and TypeScript 6.0.3:

| Check                    | In the daemon's thread | In a worker thread |
| ------------------------ | ---------------------- | ------------------ |
| Cold                     | 2,682 ms               | 2,769 ms (median)  |
| Warm, nothing changed    | 37 ms                  | 33 ms (median)     |
| Warm, one file changed   | —                      | 598 ms (median)    |
| Longest event-loop stall | 2,680 ms               | 32 ms              |
| Heap / RSS per instance  | — / +167 MiB           | 214 MiB / +305 MiB |

In the daemon's thread a cold check holds off the watcher, the API and every
other run for its whole length. In a worker the main thread pays a message
each way. archestra, the large measurement target, was not available where
this was measured; its numbers are owed before M3's exit criteria are judged.

**What the service may read and run.** The tsconfig comes from an
agent-written merged tree. An `extends` chain into `node_modules` can name a
language-service plugin, which the host process loads and executes. `include`,
`files`, `paths` and `typeRoots` can name any path on the machine, and a
tracked symlink can point anywhere. And the slot's `node_modules/typescript`,
if the service loaded it, is files an agent can write.

## Decision

`typescript`, pinned to an exact version, is a dependency of `@interlock/core`.
Each type-check service runs in a `worker_thread` of its own, one per tree,
started on the first check of that tree and stopped when its pool slot is
evicted, when a bound on live services needs the room, when its heap passes a
bound, or when the daemon stops. The worker loads Interlock's own compiler,
never the tree's. The service strips `plugins` from every project's resolved
options, and confines every read through its own host to three roots: the
slot, `node_modules` answered from the dependency checkout, and Interlock's own
`lib` directory.

## Consequences

**Easier:** a warm check costs the change, not the process floor or the
repository; the daemon stays responsive while a large one runs; a check is
cancelled where it stands by a shared flag the compiler polls. The read
confinement and the plugin strip are each one function with tests, and the
diagnostics are `tsc`'s, compared on fixtures.

**Harder:** a worker per hot slot is real memory — 305 MiB of RSS for this
repository, four at a time by default — so the number of live services is
bounded by the pool size and a service's heap by `DEFAULT_SERVICE_HEAP_MB`,
enforced both as the worker's heap limit and by stopping a service found over
it after a check, since a process-wide `--max-old-space-size` overrides a
worker's own limit. Code that runs in a worker is not counted by the test
coverage, so the service is written to run in the test's own thread too, and
is tested there.

**Committed to:** no plugin ever loads in the daemon. If one is ever needed,
the service moves to a subprocess with its own sandboxing, never back into the
daemon. Reads stay explicit in the host; `ts.sys` is used for nothing that
touches the disk. A dependency the user installed by linking outside the
checkout (`npm link`) cannot be read, so it is reported missing; that error is
pre-existing on every tree of the pair, which the baseline differ cancels out.

`include` is expanded by `ts.matchFiles`, which TypeScript does not declare
publicly. It is what `tsc` uses, over listings the host supplies, so the file
set is `tsc`'s; walking the disk by hand would give another one. The version is
pinned exactly, and the service fails its check rather than guessing if the
function is ever missing.

Reversing it — back to a `tsc` per check — costs the measured floor per check
and nothing else; the diagnostics shape survives.

## Alternatives considered

- **`tsc` per check, in the sandbox or on the host.** The 436 ms floor per
  check, and no state carried between checks except `.tsbuildinfo`.
- **The language service on the daemon's main thread.** Measured above: a cold
  check stalls the event loop for its whole length, 2.7 s on a small
  repository.
- **One subprocess per service.** Isolation the worker does not give, and the
  natural home if plugins were ever wanted; costs a second Node process per
  hot slot and a protocol over pipes, and buys nothing while nothing from the
  repository is loaded.
- **A small pool of workers shared by every slot.** Fewer threads, but a
  service's incremental state lives in the thread it was built in, so moving a
  slot between workers rebuilds it: the rotation ADR-0005 rejected for slots.
- **The tree's own `node_modules/typescript`.** Version parity with what the
  repository builds with, at the cost of executing files an agent can write.
  The baseline differ compares the four trees with the same compiler, so a
  version difference cancels out of what is reported.
- **Read confinement through a patched `ts.sys`.** Global to the thread, and
  every default TypeScript reaches for would widen it silently.

## Amendment — the slot is its listing, a check ends at a deadline, a worker starts bare

The decision above stands: one service per tree in a worker of its own,
Interlock's own compiler, no plugin, reads explicit in the host. What follows
changes how it reads, how a check ends and what a worker starts with.

**What exists is the merged tree's listing, not the slot's directory.** A slot
keeps whatever `reset --hard` does not remove — `.tsbuildinfo`, an earlier
tree's build output — and a stale `dist/*.d.ts` read as this tree's
declarations is a wrong answer with no error. The caller lists the tree
(`listTree`) and sends the listing with each check; the host answers what
exists from it, follows a link the tree holds through it, and reads only the
files it names. A file's version is its blob id, which names its content: the
epoch a cold fill bumped, and the slot's fill kind it was read from, are gone,
and a slot rewritten whole keeps what did not change. A path that leaves
`node_modules` for the dependency checkout's own source is answered by the
tree, component by component past a path the checkout lacks, so a file only
the merge added to a sibling package exists.

**Files under `node_modules` keep the install's version.** The package
managers' records under each install root — the checkout's own and each
lockfile's directory, since a workspace installed below the root keeps its
records there — are hashed on the main thread before and after each check.
While the hash holds, a dependency file's version is the hash, and the disk is
not asked about it again; a check during which it changed is discarded. With no
record, every file is versioned by its stat on every check, as before.
Something that writes into `node_modules` without installing — a client
generated there — is not seen until an install changes or the service starts
again.

**A failed lookup is retried only when something it tried can have appeared.**
A file whose import did not resolve is re-resolved while the tree or the
install has moved since the last whole check, and not otherwise; re-resolving
it builds every program anew. On archestra, whose backend holds eight
unresolved imports, that was a warm check of 2.5 s; it is now 220 ms.

**A check ends at its deadline.** `typecheck.deadlineMs` from when it is sent:
the shared flag is set, the compiler stops where it stands and the service
keeps its program. A worker still running `typecheck.graceMs` later is
terminated, since the compiler does not poll while it builds a program, and a
check queued behind it starts a new service. How a check ended is an outcome
— checked, cancelled, timeout, out of memory, crashed, or an infrastructure
failure carrying its reason — and the registry resolves to one rather than
rejecting; none is a Finding.

**A worker starts with an empty environment and a configured heap.** The
compiler reads `NODE_ENV` as it loads, and nothing the daemon was started with
belongs in the thread that reads merged code. `DEFAULT_SERVICE_HEAP_MB` is now
`typecheck.maxHeapMb`, at least 128 MiB, refused below it when the config is
read and by the registry: V8 aborts the whole process, not the worker, for a
heap too small to start in. The bound checked after each check stays.

**Not done:** resolving each read twice and comparing the open descriptor with
the path. The race it closes needs a writer of the slot or of the dependency
checkout, and whoever can write either can read the target directly.

**Flagged for a human decision — the defaults cannot check a repository of
archestra's size.** Its backend's cold check holds 7,214 MiB of heap and
7,651 MiB of RSS; at the 3,072 MiB default it ends out of memory after 25 s.
The deadline holds: 73 s cold and 61 s for an edit to a module most of it
imports, on 12 cores. Fitting it is a memory budget of about 7.5 GiB per
service, times the number of live services. Measured numbers are in
`plan_docs/log.md`.
