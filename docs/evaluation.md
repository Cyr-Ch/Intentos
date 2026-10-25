# Evaluation

## What was measured (and how)

All metrics come from persisted run artifacts (`verification.json`, `metrics.json`, `run_events`). The benchmark
runner (`benchmarks/evaluate.ts`) never estimates; token usage is `"unknown"` unless the Codex SDK reported it.

### Offline matrix (simulated orchestration)

Run with `node --disable-warning=ExperimentalWarning benchmarks/evaluate.ts --offline`. Observed on 2026-10-25
(fixture revision `0286a55ff8`):

| task | variant | final state | route ok | task tests | invariants | architecture | scope | blocking | repairs |
|---|---|---|---|---|---|---|---|---|---|
| task-a-enterprise-promo | offline-good | REVIEW_READY | yes | pass | pass | pass | pass | 0 | 0 |
| task-a-enterprise-promo | offline-bad | FAILED | yes | FAIL | FAIL | FAIL | pass | 5 | 2 |
| task-b-immediate-upgrade | offline-nopatch | FAILED | yes | FAIL | pass | pass | pass | 3 | 2 |
| task-c-invoice-export-mode | offline-nopatch | FAILED | yes | FAIL | pass | pass | pass | 1 | 2 |
| task-d-already-fixed | offline-abstain | ABSTAINED | yes | n/a | n/a | n/a | n/a | n/a | 0 |

Interpretation: these rows validate the **gates**, not any model. The "bad" Task A patch passes the fixture's own
18 tests and even its own narrow promotion test, yet is blocked by INV-001 (locked contract receives the promo via
the checkout API), ARCH-001 (API layer imports `decimal`) and the hidden task tests (promotion not visible at the
quote level). The "good" patch, which extends `DiscountPolicy.applicable_discounts`, passes all 20 project tests,
4 hidden task tests, 11 invariant tests, 24 counterexample probes and 5 architecture rules.

### Live Codex

A real read-only planner run (model `gpt-5.6-terra`, thread `01a174f7-…`) produced a schema-valid contract with zero
compiler errors: requirements cited real evidence IDs, `DiscountPolicy`/`PricingService` were marked `must_reuse`
with the approved decision as basis, allowed paths were narrowed to three files, and the compiler injected only
INV-002. Usage: 35,390 input tokens (16,128 cached), 1,791 output, 489 reasoning. See
`IMPLEMENTATION_STATUS.md` for the full live `run` outcome and the blockers hit (workspace spend cap on the
ChatGPT account intermittently rejected requests; the configured default model `gpt-6.1-sol` is not available
to ChatGPT accounts).

No baseline-vs-IntentOS comparison has been measured. The runner supports `--mode baseline` (task-text-only
prompt, identical verifier) and must be run several times per task before any claim is made.

## Metrics definitions

- **Task pass rate** — hidden task tests (`pytest_hidden_task`) passed with ≥1 test collected.
- **Business invariant preservation** — zero blocking findings in the `business_invariant` track (hidden invariant
  tests + authoritative probes).
- **Architecture compliance** — zero blocking findings from `architecture_rules` + frozen-path checks.
- **Scope** — zero blocking scope findings.
- **Clarification/abstention quality** — final route equals `expected_route` in `tasks.json`.
- **Efficiency** — wall time, SDK-reported tokens, repair rounds, verification time.
- **Evidence quality** — every evidence ID in a contract must resolve (enforced by the compiler, so 100% by
  construction for accepted contracts; fabricated IDs are rejected).

## Honest limitations

- A single fixture with four tasks is a demonstration, not statistical evidence.
- Retrieval is lexical/graph-based; ranking quality on larger repos is untested.
- Static Python analysis misses dynamic dispatch; `CALLS` edges are low-confidence.
- Counterexample probes come from policy templates, not generated hypotheses; they are exploratory unless marked
  authoritative.
- Offline results exercise orchestration only.
