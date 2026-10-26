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

### Live Codex (model `gpt-5.6-terra`, ChatGPT session, 2026-10-25/26)

All rows are real `@openai/codex-sdk` threads; metrics come from `metrics.json` / `verification.json`. "Full" is the
IntentOS pipeline (evidence pack → planner → compiled contract → implementer → verifier). "Baseline" is vanilla Codex:
no planner, no evidence, task text only, but the same worktree, allowed paths, repair budget and verifier. Rows
recorded while the laptop slept (one Task B full attempt aborted by a Codex timeout after 2 h) are excluded.
n = 1 per cell; this is a demonstration, not a measurement.

| task | variant | outcome | repairs | first-attempt blocker | tokens in (cached) / out |
|---|---|---|---|---|---|
| A promo | full | **REVIEW_READY** | 0 | – | 264,214 (207,104) / 9,339 |
| A promo | baseline | REVIEW_READY | 1 | SCOPE-PROTECTED: edited `docs/business-policy.md` | 536,354 (446,208) / 10,157 |
| B immediate upgrade | full | **REVIEW_READY** | 0 | – (re-pointed the API at the existing payment-confirmed flow; 2 files) | 209,221 (168,448) / 6,917 |
| B immediate upgrade | baseline | REVIEW_READY | 1 | SCOPE-PROTECTED: edited `docs/business-policy.md` (3 files, 77 insertions) | 945,200 / 17,295 |
| C export mode | full | **CLARIFICATION_REQUIRED** (which format?) bound to `InvoiceExportService`, DEC-002 flagged superseded | – | – | 34,334 (16,128) / 1,683 |
| C export mode | baseline | REVIEW_READY: added XML to `InvoiceExportService` (not the legacy adapter) | 1 | SCOPE-PROTECTED: edited `docs/adr-003-invoice-export-service.md` | 477,575 / 10,040 |
| D already fixed | full | **ABSTAINED** with cited policy, code and regression test | – | – | 56,413 (35,328) / 1,389 |
| D already fixed | baseline | HUMAN_REVIEW: made no changes (NO-CHANGES review finding) | 0 | – | 264,928 (225,024) / 3,312 |

What this shows: on every implementation task the vanilla baseline produced acceptable business code but **also
rewrote protected policy/ADR documents** to match its change (3 of 3), which the scope gate blocked and one repair
removed; the guided runs touched only contract-scoped files and needed no repairs. On C the baseline picked the
correct module without being told, so the stale-ADR hazard did not bite in this sample. On D vanilla Codex recognised
the bug was already fixed and changed nothing; IntentOS turned the same judgement into an evidence-backed abstention.
The earlier Task B full run (2026-10-25) needed one repair only because the first version of the hidden test
discovered the entry point by name; the test is now behaviour-driven (see its docstring) and both worktrees pass it.
Guided runs used 2–4× fewer tokens than baselines in this sample, mostly because the baseline's repair round re-sent
the repository context.

### Validation on a real external repository (2026-10-26)

`encode/httpx` (clone at `b5addb6`, 125 tracked files, 60 Python modules, 1,204 symbols, 539 tests, 458 doc
sections) was indexed with the auto-generated fallback policy in 0.9 s. Problems found and fixed on the spot:
property getter/setter pairs and repeated CHANGELOG headings produced duplicate node ids (now suffixed); the
offline planner proposed the catch-all universe `**` as allowed paths (now derives `httpx/**`, `tests/**` from the
probable impact, and the compiler rejects catch-alls explicitly); retrieval ranked a dozen exception classes above
`HTTPTransport(retries=...)` for "Add support for a per-request retry limit when a connection error occurs" because
generic terms such as "error" were not down-weighted and constructor signatures were not scored. After adding
inverse-document-frequency weighting, constructor-signature scoring and a breadth bonus, the top hits are
`Limits`, `AsyncHTTPTransport`, `HTTPTransport`, `ConnectError`, `Client`/`AsyncClient`. Without a trusted policy
the pack contains no invariants or architecture rules and says so; verification was not run on the external code
(it would execute untrusted tests on the host).

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
