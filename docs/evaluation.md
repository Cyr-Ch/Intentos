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

### Live Codex (model `gpt-5.6-terra`, ChatGPT session, 2026-10-25)

All five live runs below are real `@openai/codex-sdk` threads; metrics come from `metrics.json` / `verification.json`.

| run | result | repairs | verifier | tokens in (cached) / out |
|---|---|---|---|---|
| Task A `plan` only (`run-…212923-469f41`) | contract valid, 0 compiler errors, 3 narrowed allowed paths, `DiscountPolicy`/`PricingService` must_reuse | – | – | 35,390 (16,128) / 1,791 |
| Task A full IntentOS (`run-…213112-d5363e`) | **REVIEW_READY** | 0 | project 18/18, hidden 4/4, invariants 11/11, probes 24/24, AST clean, scope clean | 264,214 (207,104) / 9,339 |
| Task A baseline, task text only, same verifier (`run-…214229-f38688`) | REVIEW_READY | 1 | attempt 1 blocked: SCOPE-PROTECTED (edited `docs/business-policy.md`); attempt 2 all gates pass; code equivalent to guided run | 536,354 (446,208) / 10,157 |
| Task B full (`run-…214228-7982b7`) | **REVIEW_READY** | 1 | attempt 1: 3 hidden task tests failed (entry point not discoverable by name); repair in the same thread added `upgrade_immediately`; INV-002 held in both attempts | 556,162 (455,680) / 15,959 |
| Task C full (`run-…213638-144636`) | CLARIFICATION_REQUIRED | – | planner bound work to `InvoiceExportService`, flagged DEC-002 superseded, asked which format; no worktree | 34,334 (16,128) / 1,683 |
| Task D full (`run-…213638-75c91c`) | ABSTAINED | – | cited policy section, `eligible_for_discounts` and the regression test; no code changed | 56,413 (35,328) / 1,389 |

What this does and does not show: the gates worked on real model output (a protected-doc edit by the baseline was caught and repaired; a naming mismatch on Task B was repaired through machine-readable findings); the planner produced evidence-grounded contracts and chose clarify/abstain where appropriate. It does **not** show that IntentOS beats vanilla Codex: on Task A the baseline's business code was equivalent, and n=1 per variant. The baseline that succeeded is disclosed as-is.

Blockers encountered: the ChatGPT workspace spend cap rejected all requests for ~10 minutes early in the session; the CLI default model `gpt-6.1-sol` is unsupported for ChatGPT accounts; one SDK stream emitted a transient `Reconnecting… 2/5` error event (adapter now treats only a missing `turn.completed` as fatal).

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
