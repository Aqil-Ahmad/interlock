# ADR-0007: TypeScript in core, as a language service per slot in a worker thread

- **Status:** proposed
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
