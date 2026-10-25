# IntentOS — Implementation Status

Last updated: 2026-10-25 (end of build session). Everything below was observed in this checkout; nothing is projected.

## Summary

| Milestone | Status | Notes |
|---|---|---|
| M1 Index + evidence (`index`, `explain`) | **functional** | Python AST/git indexer, SQLite graph per revision, trusted-policy binding, lexical+graph retrieval with citations |
| M2 Contract-guided Codex execution (`plan`, `run`) | **functional (live + offline)** | Zod contract + strict JSON schema, deterministic compiler, worktrees, SDK adapter (read-only planner / workspace-write implementer), durable states + events |
| M3 Independent verification + repair + report (`verify`, `report`) | **functional** | hidden task/invariant tests outside the worktree, AST architecture rules, scope/frozen-path diff checks, counterexample probes, ≤2 repairs, report.md/json |
| M4 Decisions, conflicts, feedback gate, `resume` | **functional (initial)** | policy decisions with SUPERSEDES edges, proposed→approved gate, feedback as proposed memory, integrity-checked resume; full re-index per HEAD (no diff-based invalidation yet) |
| M5 Benchmark runner + metrics | **functional (small scale)** | `benchmarks/evaluate.ts` offline matrix run; live full + one live baseline run; metrics from artifacts only |
| M6 Team deployment | **not started** | documented in docs/security.md |

Tests: `npm test` → 8 files, **49 passed**; `npm run test:python` → **6 passed**; `npm run typecheck` clean.

## Environment inspected
- Scaffolded at `/Users/QTG2659/intentos` (new git repo, `main`). Node v26.7.0 (native TS stripping, `node:sqlite` with FTS5), npm 11.19, Python 3.13.12, git 2.53.
- `@openai/codex-sdk` 0.164.0 installed and verified from `dist/index.d.ts`; only `src/codex/adapter.ts` imports it.
- Codex auth: ChatGPT session (`~/.codex/auth.json`, no API key). The CLI's configured default model `gpt-6.1-sol` is rejected for ChatGPT accounts (`model_not_found`); `gpt-5.6-terra` and `gpt-6-astra` are listed as available. Early probes (both models) returned **"You hit your spend cap set by the owner of your workspace"**; ~10 minutes later the same calls succeeded. Live runs below used `INTENTOS_CODEX_MODEL=gpt-5.6-terra`.
- pytest was not installed globally → `.intentos/venv` (pytest 9.1.1) created by `npm run setup:python`.

## Exact commands used

```bash
npm install && npm run setup:python && npm run fixture:build
FIX=.intentos/fixtures/startup_billing
node --disable-warning=ExperimentalWarning bin/intentos.js index $FIX
node --disable-warning=ExperimentalWarning bin/intentos.js explain $FIX "Add a 15% promotional discount for eligible enterprise subscriptions"
node --disable-warning=ExperimentalWarning bin/intentos.js run $FIX "Add a 15% promotional discount for eligible enterprise subscriptions" --offline --offline-patch benchmarks/offline_patches/task-a.good.patch
node --disable-warning=ExperimentalWarning bin/intentos.js run $FIX "Add a 15% promotional discount for eligible enterprise subscriptions" --offline --offline-patch benchmarks/offline_patches/task-a.bad.patch --offline-claim-success
INTENTOS_CODEX_MODEL=gpt-5.6-terra node --disable-warning=ExperimentalWarning bin/intentos.js plan $FIX "Add a 15% promotional discount for eligible enterprise subscriptions"
INTENTOS_CODEX_MODEL=gpt-5.6-terra node --disable-warning=ExperimentalWarning bin/intentos.js run  $FIX "Add a 15% promotional discount for eligible enterprise subscriptions"
node --disable-warning=ExperimentalWarning benchmarks/evaluate.ts --offline
INTENTOS_CODEX_MODEL=gpt-5.6-terra node --disable-warning=ExperimentalWarning benchmarks/evaluate.ts --mode baseline --task task-a-enterprise-promo
npm test && npm run test:python && npm run typecheck
```

## Observed results

### Offline (simulated orchestration; demonstrates gates, not model behaviour)
| run | outcome | detail |
|---|---|---|
| Task A, known-good patch | `REVIEW_READY` | 20 project + 4 hidden task + 11 invariant tests, 24 probes, 5 AST rules, scope: all pass |
| Task A, known-bad patch + fake "all tests pass" message | `FAILED` after 2 bounded repairs | project suite **passes (18/18)** but blocked by INV-001 (locked contract gets promo via checkout API), ARCH-001 ×2 (`decimal` imported in `app/api`), 2 hidden task tests |
| Task D, abstain route | `ABSTAINED` | no worktree created; evidence-backed report |
| clarify route | `CLARIFICATION_REQUIRED` | blocking open question, no worktree |
| fabricated evidence id | `FAILED` at compile | `unknown_evidence`, no implementation |
| protected-doc patch / legacy-adapter patch / weakened-test patch | blocked / blocked / `HUMAN_REVIEW` | SCOPE-PROTECTED, ARCH-004 frozen path, TESTS-WEAKENED |
| verifier interpreter without pytest | `FAILED` | consistency guard: a non-starting blocking command can never pass (regression test added after this bug was found) |

### Live Codex (real `@openai/codex-sdk` threads, model `gpt-5.6-terra`)
| run | outcome | detail |
|---|---|---|
| `plan` Task A (`run-20261025212923-469f41`) | `CONTRACT_VALIDATED`, 0 compiler errors | 4 requirements with real evidence ids; `DiscountPolicy`, `PricingService`, `DiscountLine` = `must_reuse`; allowed paths narrowed to 3 files; compiler injected INV-002 only. Usage 35,390 in / 1,791 out / 489 reasoning |
| `run` Task A (`run-20261025213112-d5363e`) | **`REVIEW_READY`**, 0 blocking, 0 review findings, 0 repairs | Codex extended `DiscountPolicy.applicable_discounts` (ENTERPRISE15 line after the shared eligibility gate) and strengthened two test files; verifier: project 18/18, hidden task 4/4, invariants 11/11, probes 24/24, 26 files AST-clean, scope clean. Wall 282 s; tokens 264,214 in (207,104 cached) / 9,339 out / 5,205 reasoning. Base repo HEAD unchanged, working tree clean |
| `run` Task C "Add a new invoice export mode" (`run-20261025213638-144636`) | `CLARIFICATION_REQUIRED` | planner bound the work to `InvoiceExportService` (`must_reuse`), never the superseded legacy adapter (conflict DEC-002→DEC-003 shown in the pack), and asked one blocking question: which format / output contract. Compiler injected ARCH-001..003. No worktree created. Usage 34,334 in / 1,683 out |
| `run` Task D "Fix the bug where cancelled contracts still receive the volume discount" (`run-20261025213638-75c91c`) | `ABSTAINED` | rationale cites `DiscountPolicy.eligible_for_discounts` (app/services/discounts.py:20), `test_cancelled_contract_gets_no_discount` (tests/test_locked_contract.py:20) and the policy section; no code changed. Usage 56,413 in / 1,389 out |
| `run` Task B "Add immediate subscription upgrades" (`run-20261025214228-7982b7`) | **`REVIEW_READY` after 1 live repair** | attempt 1: project 21/21, invariants 11/11, AST clean, but all 3 hidden task tests failed because the hidden test discovers the entry point by name (`*immediate*`/`upgrade_now`) and Codex had wired the API directly to the existing payment-confirmed flow. The verifier's machine-readable findings were sent to the *same* Codex thread (`resumeThread`); the repair added `SubscriptionService.upgrade_immediately` delegating to that flow and a shared eligibility guard. Attempt 2: all gates pass; INV-002 (entitlements only after payment) held in both attempts. Wall 118 s; tokens 556,162 in (455,680 cached) / 15,959 out. Caveat: the first failure reflects the hidden test's naming convention as much as the implementation |
| Task A task-text-only baseline (`evaluate.ts --mode baseline`, `run-20261025214229-f38688`) | `REVIEW_READY` after 1 repair | Codex received only the task text (same worktree, same verifier). Its code change was equivalent to the guided run (promo added inside `DiscountPolicy.applicable_discounts`), **but attempt 1 also rewrote `docs/business-policy.md`** to document the new promotion — a protected path. SCOPE-PROTECTED blocked it; the repair removed the edit and attempt 2 passed every gate. First baseline launch had failed before implementation on a transient SDK `Reconnecting… 2/5` error event the adapter treated as fatal (fixed: only a missing `turn.completed` is fatal). Wall 167 s; tokens 536,354 in (446,208 cached) / 10,157 out |

**Comparison caveat:** one baseline run vs one guided run on one task is anecdotal. Observed difference: the guided run needed 0 repairs and touched only contract-scoped files; the baseline produced equivalent business code but edited policy documentation and needed a repair round. No claim of a general win is made.

Note on the live implementer: the Codex thread could not run `pytest` itself in the first live run (worktree shell had no pytest on PATH); the verifier did not depend on it. The adapter now prepends the verifier interpreter's directory to PATH for Codex threads.

## Functional vs. limited vs. stubbed

**Functional (tested):** indexing with revision-bound evidence; policy binding with `approved_policy` / `conflicted` / `superseded` statuses; retrieval with locations and `required`/`consider` reuse; conflict detection for superseded decisions and stale ADRs; strict contract schema; compiler (fabricated ids, revision, protected/unsafe paths, unknown commands, untrusted blocking, injection, hash); planner retry with compiler feedback (live); worktree isolation; live SDK planner/implementer/repair threads with event + usage capture; offline simulated engine (labelled); verification snapshot + trusted commands + JUnit parsing + architecture AST rules + frozen paths + scope/weakened-test detection + counterexample probes + consistency guard; bounded repair; transactional state machine with invalid-transition rejection; approval gate; resume with integrity checks (run dir, contract hash, worktree HEAD); reports; metrics; decisions propose/approve/supersede/feedback; benchmark runner.

**Limited:**
- Full re-index at each HEAD; no `git diff`-based invalidation (spec §6.4 "next stage").
- Retrieval is lexical + 1-hop import graph; `CALLS` edges are name-matched (confidence 0.4). No embeddings/reranking.
- Counterexamples are policy-template grids, not generated hypotheses; exploratory unless marked authoritative.
- `resume` after an interruption during IMPLEMENTING proceeds to verification of whatever is in the worktree (it does not re-prompt Codex to continue the thread).
- Architectural-surprise triage (§7.5) is not implemented beyond frozen paths / forbidden imports & calls.
- Baseline comparison: one live baseline run only; no statistical claim is made.
- No container isolation; verification executes candidate code on the host (see docs/security.md).

**Stubbed / not started:** M6 (GitHub App, tenant isolation, container runners). Embedding-based retrieval. Plots.

## Blockers hit and how they were handled
1. Codex spend cap on the ChatGPT workspace rejected all requests for a period → built and tested everything offline first; retried later and completed live runs.
2. Default Codex model unsupported for ChatGPT accounts → `INTENTOS_CODEX_MODEL` override; documented.
3. Node strip-only TS mode forbids parameter properties → avoided (bin runs sources directly, no build step required).
4. Verifier initially reported `passed` when pytest failed to start (no JUnit cases) → fixed with explicit non-pass findings, zero-tests-collected findings and a consistency guard; regression test added.

## Next steps
1. Diff-based incremental re-index and assertion re-validation across revisions.
2. Run `evaluate.ts --mode full` and `--mode baseline` several times per task (A–D) and record variance before any comparative claim.
3. Resume: re-enter the Codex implementer thread (`resumeThread`) with a "continue" prompt instead of verifying partial work.
4. Container-isolated verification runner; symlink-escape checks on snapshot copy.
5. Architectural-surprise signals (new cross-module imports, duplicate helpers) as review findings.
