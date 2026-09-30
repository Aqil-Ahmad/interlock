# Evaluation harness

Measures detection quality, lead time and overhead. Protocols: `plan_docs/evaluation.md`.

## Why this lives outside `packages/`

Evaluation code and datasets are not product code: different quality bars, different dependencies, and they must not be edited to make results look better. Keeping `/eval` out of the pnpm workspace makes that boundary structural.

## Layout

`run.ts` is the entry point and `reports/` holds generated output — git-ignored
except when a report backs a published claim.

Two suites are planned:

| Directory   | Contents                                                        |
| ----------- | --------------------------------------------------------------- |
| `fixtures/` | small synthetic repos with planted, labelled conflicts          |
| `replay/`   | scripts that replay concurrent branch histories from real repos |

## Running

```bash
pnpm eval                      # regenerates every report into eval/reports/
pnpm eval --suite fixtures
pnpm bench                     # overhead benchmarks
```

## The fixture suite

A fixture is a declarative spec in `fixtures/textual.ts` or `fixtures/semantic.ts`,
in the format `fixtures/format.ts` defines: the base files, each branch's
operations — committed, and left uncommitted in its worktree — and the expected
outcome. `fixtures/generate.ts` is the one generator that turns any spec into a
repository; `fixtures/runner.ts` takes it through discovery, the watcher's
capture into the shadow, the speculative merge and every analyzer in core's
`ANALYZER_PIPELINE` — the calls the daemon makes, in its order, but not the
daemon's run pipeline itself, so its verdict cache and Finding reconciliation
are not measured here; and
`fixtures/score.ts` matches what was found against the labels, by the rule
printed at the head of every report.

The report is `reports/fixtures.md`, with the same data in `fixtures.json`.
Two runs on the same machine write the same bytes.

## Adding a fixture

1. Write the spec. Label the expected outcome exactly: the analyzer and class
   that should catch it, the path it is about, the symbol, and the lines on each
   branch, in that branch's own copy of the file.
2. Add its negative twin — a pair that looks the same and is genuinely
   independent. Precision is measured only against twins.
3. Add the fixture before the analyzer or rule it exercises, and never change a
   label or a fixture to improve a number: add a new one instead.
