# demandlib comparison: Codex alone versus Codex under IntentOS

A benchmark on a real repository (oemof/demandlib, fork `Cyr-Ch/oemof-demand`) with fresh tickets, so neither the
model's training data nor the precedents IntentOS loads can contain the answers.

## Design

- **Tickets.** `tickets.yaml`: fifteen tickets written on 2026-10-27 against demandlib at `6757f4f`, before any run.
  Twelve expect an implementation, one is deliberately vague and should end in a clarification, two are already fixed in
  the repository's history and should end in an abstention, two resemble merged PRs so the precedent feature is
  tested on fresh work. Each entry carries the issue text the agents see and, separately, the expected route, the
  invariants in play and the acceptance tests to write. `file_issues.py` files the issue texts on the fork.
- **Acceptance tests.** Written by a model other than the implementer, before the first run:
  `intentos acceptance <repo> --tickets benchmarks/demandlib/tickets.yaml --model <slug>` gives the side model the
  ticket text only (never the `acceptance` plans, which stay here as the reviewer's checklist), runs its modules at the
  base revision, keeps those that fail now for implement tickets and pass now for the already-fixed controls, and writes
  them to `benchmarks/hidden_tests/oemof_demand/tasks/<id>/` with the author recorded, bound in `benchmarks/tasks.json`.
  T05 (clarify) gets none. A person compares each module against the ticket's `acceptance` plan before any run.
- **Arms.** Same worktree, same verifier, same repair budget. `baseline`: vanilla Codex with the ticket text only
  (`benchmarks/evaluate.ts --mode baseline`). `full`: the IntentOS pipeline. Ablations when credits allow: evidence
  pack without the contract compiler; full pipeline without the repair loop. Coordination: several tickets run from
  the same base and merged in sequence through `intentos merge`.
- **Repeats.** At least three runs per ticket per arm. Failed runs count and are kept.

## Metrics

Deterministic, from the run artifacts (`verification.json`, `metrics.json`, `run_events`, `merge.json`):

| Question | Metric |
|---|---|
| Solved? | acceptance tests pass at first attempt; after bounded repairs |
| Would it have shipped a rule violation? | blocking invariant findings at first attempt |
| In its lane? | protected paths touched; changed files vs the ticket's modules |
| Knew when not to code? | route correctness on T05 (clarify), T06 and T15 (abstain) |
| Verdict | REVIEW_READY / HUMAN_REVIEW / FAILED / CLARIFY / ABSTAIN |
| Cost | repair rounds, tokens in and out, wall time |
| Reviewer burden | findings to read; tests-weakened and surprise signals |
| Coordination | stale merges blocked; broken-main count; approvals needed vs one per PR |

Quality, by an LLM judge with `rubric.md`: pairwise, blinded, order-swapped, a different model from the implementer,
calibrated against a person on ten pairs before any aggregate is reported.

## Threats

- The tickets were written by the people evaluating the system. Mitigation: written and committed before any run,
  with acceptance tests reviewed by a person; the judge never sees which arm produced a diff.
- Invariants were mined from the repository's history; none was mined from these tickets, since they are new.
- Public repository: the model has seen demandlib's code, equally in both arms.
- n = 3 per cell is the floor for a claim, not a comfortable number. Report per-ticket wins and losses, not one average.

## Running it

```bash
cd ~/intentos
export INTENTOS_CODEX_MODEL=gpt-6-astra          # the implementer, both arms
# 1. acceptance tests by another model (done; benchmarks/hidden_tests/oemof_demand/tasks/)
node --disable-warning=ExperimentalWarning bin/intentos.js acceptance ~/repos/demandlib --tickets benchmarks/demandlib/tickets.yaml --model gpt-5.6-terra
# 2. the comparison: one run per ticket per arm from the same base, then the merges in ticket order into each arm's clone
node --disable-warning=ExperimentalWarning benchmarks/compare.ts --repo ~/repos/demandlib --out .intentos/benchmarks/demandlib/run-1
#    --phase run | merge | all, --only T01,T02, --arms full,baseline, --resume <dir> to continue an interrupted batch
# 3. the judge: a third model, pairwise, blinded, order-swapped; calibration pairs first
node --disable-warning=ExperimentalWarning benchmarks/judge.ts --compare .intentos/benchmarks/demandlib/run-1 --calibrate
node --disable-warning=ExperimentalWarning benchmarks/judge.ts --compare .intentos/benchmarks/demandlib/run-1 --model gpt-5.6-sol
```

`compare.json` and `report.md` are rewritten after every run and every merge; `judge.json` and `judge.md` after every pair.

## Status

Run 1 (2026-10-27, implementer `gpt-6-astra`, acceptance tests by `gpt-5.6-terra`, judge `gpt-5.6-sol`): all fifteen
tickets in both arms, all merges, the judge pass. Artifacts and the interpretation are in `results/run-1/`
(`report.md`, `compare.json`, `judge.md`, `judge.json`, the calibration pairs without their key, and `README.md` with
the reading of the numbers and the caveats). One run per cell.
