# Evaluation harness

Measures detection quality, lead time and overhead. Protocols: `plan_docs/evaluation.md`.

## Why this lives outside `packages/`

Evaluation code and datasets are not product code: different quality bars, different dependencies, and they must not be edited to make results look better. Keeping `/eval` out of the pnpm workspace makes that boundary structural.

## Layout

`run.ts` is the entry point and `reports/` holds generated output — git-ignored
except when a report backs a published claim.

Three suites are planned:

| Directory       | Contents                                                                  |
| --------------- | ------------------------------------------------------------------------- |
| `fixtures/`     | small synthetic repos with planted, labelled conflicts                    |
| `replay/`       | scripts that replay concurrent branch histories from real repos           |
| `agenticflict/` | adapters for the AgenticFlict dataset (the dataset itself is git-ignored) |

## Running

```bash
pnpm eval                      # regenerates every report into eval/reports/
pnpm eval --suite fixtures
pnpm bench                     # overhead benchmarks
```

## Adding a fixture

1. Create the repo generator under `fixtures/<name>/`.
2. Label the expected outcome exactly: which pair, which analyzer should catch it, which file and symbol.
3. Add the negative twin where it makes sense — a pair that looks similar and is genuinely independent.
4. Add the fixture before tuning the detector it exercises.
