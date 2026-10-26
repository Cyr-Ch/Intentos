# IntentOS — Implementation Status

Last updated: 2026-10-26 (container verifier and architectural-surprise signals landed). Everything below was observed in this checkout; nothing is projected.

## Summary

| Milestone | Status | Notes |
|---|---|---|
| M1 Index + evidence (`index`, `explain`) | **functional** | Python AST/git indexer, SQLite graph per revision, trusted-policy binding, lexical+graph retrieval with citations |
| M2 Contract-guided Codex execution (`plan`, `run`) | **functional (live + offline)** | Zod contract + strict JSON schema, deterministic compiler, worktrees, SDK adapter (read-only planner / workspace-write implementer), durable states + events |
| M3 Independent verification + repair + report (`verify`, `report`) | **functional** | hidden task/invariant tests outside the worktree, AST architecture rules (incl. anti-tampering `forbidden_names`), scope/frozen-path diff checks, hidden-test inventory cross-check, fail-closed invariants, counterexample probes, architectural-surprise review signals (§7.5), ≤2 repairs, revocable review state, report.md/json |
| M4 Decisions, conflicts, feedback gate, `resume` | **functional (initial)** | policy decisions with SUPERSEDES edges, proposed→approved gate, feedback as proposed memory, integrity-checked resume that re-enters an interrupted Codex turn (thread id saved at `thread.started`, ≤2 re-entries, then verifies); full re-index per HEAD (no diff-based invalidation yet) |
| M5 Benchmark runner + metrics | **functional (small scale)** | `benchmarks/evaluate.ts` offline matrix run; live full + one live baseline run; metrics from artifacts only |
| M6 Team deployment | **partial** | container-isolated verification runner (`INTENTOS_VERIFIER=docker`, fail-closed) done; GitHub App, tenant isolation and hosted runners not started (docs/security.md) |

Tests: `npm test` → 12 files, **76 passed** (4 of them need a Docker daemon plus the `intentos-verifier:0.1` image and skip otherwise; `tests/integration/resume.test.ts` covers thread id persisted at `thread.started`, re-entry, bounded re-entry, no-thread/offline fallbacks, moved-worktree guard); `npm run test:python` → **14 passed**; `npm run typecheck` clean.

## Independent audit (2026-10-26) and fixes
A separate reviewer agent compared the code with the spec and probed the verifier. Confirmed weaknesses, all fixed with regression tests:
1. **Forged test reports.** Candidate code runs inside the pytest process and could rewrite the JUnit file named on the command line and `os._exit(0)`; the verifier would have accepted it. Now: the names in a hidden-test JUnit report must equal the test functions discovered statically in the trusted hidden-test files (`TEST-INVENTORY-MISMATCH`, blocking), and the new `forbidden_names` rule kind (ARCH-006) statically rejects `sys.argv`, `os._exit`, and `junit`/`.intentos_hidden` literals in application and test code, with import aliases resolved. This raises the bar; only process isolation removes the risk (docs/security.md).
2. **Skipped blocking commands counted as passed.** If hidden invariant tests were unavailable, bound blocking invariants silently passed. Now each bound blocking invariant's `verified_by` file must be present or the run fails closed; a task without hidden acceptance tests gets a `NO-ACCEPTANCE-TESTS` review finding (→ HUMAN_REVIEW, never REVIEW_READY).
3. **`verify` could not revoke a result.** A failing re-verification left REVIEW_READY untouched. Now REVIEW_READY → HUMAN_REVIEW/FAILED and HUMAN_REVIEW → FAILED are allowed only for independent re-verification (`applyReverification`), never upgrades.
4. **Hidden tests readable by the live implementer.** Codex's read-only sandbox can read any file on disk, including `benchmarks/hidden_tests`. Prevention needs isolation; detection added: recorded implementer commands/file changes referencing protected artifacts become `PROTECTED-ARTIFACT-ACCESS` review findings.
5. Uncovered routes now tested: conflicted constraint → clarify; stale-document and conflicted-source conflicts; empty task text rejected with exit 1.
The auditor also noted that hidden task tests bind only via `--task <id>` or an exact request-text match — by design (trusted config), documented in README.

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
- `resume` re-entry of an interrupted Codex turn is exercised with an injected stand-in engine only (`tests/integration/resume.test.ts`); no live `resumeThread` continuation has been observed yet. Offline runs and runs without a recorded thread id still verify the worktree as is.
- Architectural-surprise triage covers three detectors (new internal import, duplicate helper by name or normalised body, domain construction in the API layer) on Python files only; it is review-only by design and does not analyse test files for duplicates.
- Baseline comparison: one live baseline run only; no statistical claim is made.
- Container isolation is opt-in (`INTENTOS_VERIFIER=docker`); the default `host` mode still executes candidate code on the host. In docker mode the results mount lets candidate code write files into the attempt directory, so forged-report defences stay in place (see docs/security.md).

**Stubbed / not started:** M6 GitHub App, tenant isolation, hosted runners. Embedding-based retrieval. Plots.

## Blockers hit and how they were handled
1. Codex spend cap on the ChatGPT workspace rejected all requests for a period → built and tested everything offline first; retried later and completed live runs.
2. Default Codex model unsupported for ChatGPT accounts → `INTENTOS_CODEX_MODEL` override; documented.
3. Node strip-only TS mode forbids parameter properties → avoided (bin runs sources directly, no build step required).
4. Verifier initially reported `passed` when pytest failed to start (no JUnit cases) → fixed with explicit non-pass findings, zero-tests-collected findings and a consistency guard; regression test added.

## Live benchmark matrix (2026-10-26)
Clean full-vs-baseline rows for all four tasks are in docs/evaluation.md. Headline: baseline Codex edited protected
policy/ADR docs on 3 of 3 implementation tasks (caught by the scope gate, repaired once); guided runs needed 0 repairs
and touched only contract-scoped files; IntentOS clarified on C and abstained with evidence on D. One row per cell.

## External-repository validation (2026-10-26)
Indexed and queried `encode/httpx` with the fallback policy; three defects found and fixed (duplicate node ids,
catch-all allowed paths from the offline planner, weak lexical ranking). Retrieval now uses corpus IDF weighting and
scores constructor signatures. See docs/evaluation.md. Benchmark note: live runs executed while the laptop entered
sleep states show inflated wall times and spurious Codex timeouts; such rows are excluded from any comparison.

## Container-isolated verifier (2026-10-26)
`INTENTOS_VERIFIER=docker` runs every executing trusted command (project suite, hidden task/invariant tests,
counterexample probes) in `intentos-verifier:0.1` (`docker/verifier/Dockerfile`: python:3.12-slim-bookworm, git,
pytest 9.1.1, unprivileged user) with the snapshot mounted read-only at `/work/snapshot`, the attempt directory at
`/work/results` for JUnit output, `--network none`, read-only root FS + tmpfs `/tmp`, `--cpus 1 --memory 1g
--pids-limit 256 --cap-drop ALL --security-opt no-new-privileges`, policy `timeout_s` then `docker kill`. Static
builtins stay on the host. Unavailable daemon/image ⇒ `VERIFIER-UNAVAILABLE` blocking findings, no host fallback.
Observed on this laptop (Docker Desktop 29.5.2, image `sha256:c1e55dda…`):
- `tests/unit/sandbox.test.ts` (7): argv translation, no-host-path guard, flags, names, modes, settings.
- `tests/integration/container_verifier.test.ts` (4): fail-closed with `INTENTOS_DOCKER_BIN=/nonexistent/docker`
  (run `FAILED`, three `VERIFIER-UNAVAILABLE` findings, no pytest log on the host, static builtins still ran);
  good patch `REVIEW_READY` with hidden tests executed in the container; bad patch `FAILED` with ARCH-001 + INV-001
  exactly as on the host; inside the container only `lo` is up and an outbound connect raises `OSError`.
- `benchmarks/evaluate.ts --offline` in both modes: identical outcomes for all five rows (A good REVIEW_READY 0
  blocking; A bad FAILED 5 blocking / 2 repairs; B and C nopatch FAILED 3 and 1 blocking; D ABSTAINED). Wall time
  roughly doubles in docker mode (0.9 s → 2.0 s for the good row; 2.1 s → 4.4 s for the bad row) from container start-up.
- Docker Desktop's VM kernel lists unused tunnel devices in `/sys/class/net` under `--network none`; the test checks
  link state and connectivity instead of the directory listing.

## Architectural-surprise signals (2026-10-26)
`architecture_surprise` builtin (advisory, `required: true` in `policies/startup_billing.yaml` and in the fallback
policy) runs `python/architecture_surprise.py` over the changed Python files against base-revision sources read with
one `git cat-file --batch`. Findings are `category: architecture`, `severity: review`, `authority: deterministic`,
rule ids `SURPRISE-NEW-DEPENDENCY` / `SURPRISE-DUPLICATE-HELPER` / `SURPRISE-API-DOMAIN-CONSTRUCTION`, with
`location`, `expected`, `observed` and a message stating they are risk triage, not proof of bad design. Observed:
- `python/tests/test_architecture_surprise.py` (7): one finding per new internal module; new files not flagged;
  duplicate by renamed-parameter body and by name; 2-statement bodies and test fixtures never matched; Enum access
  and pre-existing calls not flagged; parse errors become `errors`, never findings; `ignore_names` honoured.
- `tests/integration/pipeline.test.ts`: the known-good Task A patch produces `0 signal(s)` and stays `REVIEW_READY`;
  `benchmarks/offline_patches/fixtures/surprise.patch` (good patch + `app.domain.money`/`app.services.exports`
  imports and a `subtract_money` copy of `Money.__sub__` in `pricing.py`, a `Customer(...)` built in
  `app/api/checkout.py`) yields exactly the three rule ids (4 findings), zero blocking findings, ends `HUMAN_REVIEW`,
  and the report gains an "Architectural surprise (review signals)" section.
- `benchmarks/evaluate.ts --offline`: the five recorded rows keep their outcomes (A good REVIEW_READY, A bad FAILED,
  B/C nopatch FAILED, D ABSTAINED).

## Next steps
1. Diff-based incremental re-index and assertion re-validation across revisions.
2. Run `evaluate.ts --mode full` and `--mode baseline` several times per task (A–D) and record variance before any comparative claim.
3. Resume re-entry: done with a stand-in engine (2026-10-26); still to do: observe one real `resumeThread` continuation with live credentials.
4. Symlink-escape checks on snapshot copy; stronger-than-Docker isolation (gVisor/VM) for the container verifier.
