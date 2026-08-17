# Evaluation protocols

How detection quality, latency and overhead are measured. Metric definitions are frozen before the final measurement run; changing one afterwards means re-running everything and saying so.

## Ground rules

1. **Every number is regenerable by one command** — `pnpm eval` writes `eval/reports/`.
2. **Definitions before data.** A metric whose definition moved after seeing results is not a result.
3. **Infra failures are reported separately** and never counted as detections or misses. A build that could not run is not a conflict and not a miss; putting it in either bucket flatters the numbers.

## Datasets

| Dataset                                | What it is                                                      | Labels                             | Used for                                                        |
| -------------------------------------- | --------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| **Golden fixtures** (`eval/fixtures/`) | small synthetic repos with planted conflicts                    | exact, by construction             | precision/recall per analyzer and per matcher; regression suite |
| **OSS replay** (`eval/replay/`)        | concurrent branch histories replayed from real TypeScript repos | whether the real merge or CI broke | realism; false-positive rate on genuinely independent work      |

Fixtures cover at minimum: textual overlap; adjacent additions; rename vs call site; signature change vs caller; moved export vs import; same-symbol dual edit; duplicate implementation; and near-miss negatives — pairs that look conflicting but are independent. Precision is only interesting against hard negatives.

## Metrics

### Detection quality

Per analyzer, per matcher, and combined:

- **Precision** = TP / (TP + FP)
- **Recall** = TP / (TP + FN)
- A **true positive** names the right pair _and_ the right location. Naming the pair for the wrong reason is not a hit.

Targets: AST-layer precision ≥ 0.9; combined recall ≥ 0.8, reported honestly whatever it is.

### Lead time

**Lead time** = (time the conflict would have surfaced at merge or CI) − (time Interlock raised the Finding).

From the replay timeline: `t_introduced` is when the second half of the conflicting pair was written, `t_detected` is the Finding's `firstSeenAt`, `t_baseline` is when the real merge or CI run surfaced it. Report the distribution, not just the mean.

### Cost of being wrong

- **False positives per day of normal work** — target < 1/day, measured on non-conflicting replay segments and on this repository in daily use.
- **Dismissal rate** — fraction of Findings marked `dismissed`. Trust erodes here first.

### Overhead

- Steady-state CPU and RSS with N = 2, 4, 8 branches
- Disk used by shadow worktrees and store over a week of use
- Time-to-verdict per pair, per analyzer, cached and uncached

### Ablations

Textual only → + typecheck → + AST → full pipeline. The question is what each layer adds in recall and what it costs in latency and false positives.

## Baselines

1. **Status quo**: `git merge` at integration time.
2. **PR-time dry run**: `git merge --no-commit --no-ff` when the PR opens.
3. Optionally, GitHub's conflict indicator.

No baseline detects semantic conflicts, so report textual detection against baselines and semantic detection as a capability none of them have — rather than claiming a like-for-like win.

## Protocol per experiment

Each experiment documents: dataset and version, exact command, environment (OS, CPU, Docker version, Node version), analyzer configuration, and where the report is written.

## Threats to validity

- Fixtures are authored by the same people who wrote the detectors; OSS replay is the only external check.
- Replay reconstructs a timeline that never happened concurrently; the lead-time claim inherits that assumption.
- Daily-use data is a sample of one team on one codebase.
- Agent behaviour is non-deterministic; report transcripts and the number of runs, not just outcomes.
