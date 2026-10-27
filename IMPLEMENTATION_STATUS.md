# IntentOS — Implementation Status

Last updated: 2026-10-27 (precedents: ticket history linked to the code, after `intentos onboard`, `intentos suggest`, the review UI, the MCP server and the M4–M6 features). Everything below was observed in this checkout; nothing is projected.

## Summary

| Milestone | Status | Notes |
|---|---|---|
| M1 Index + evidence (`index`, `explain`) | **functional** | Python AST/git indexer, SQLite graph per revision, trusted-policy binding, lexical+graph retrieval with citations |
| M2 Contract-guided Codex execution (`plan`, `run`) | **functional (live + offline)** | Zod contract + strict JSON schema, deterministic compiler, worktrees, SDK adapter (read-only planner / workspace-write implementer), durable states + events |
| M3 Independent verification + repair + report (`verify`, `report`) | **functional** | hidden task/invariant tests outside the worktree, AST architecture rules (incl. anti-tampering `forbidden_names`), scope/frozen-path diff checks, hidden-test inventory cross-check, fail-closed invariants, counterexample probes, architectural-surprise review signals (§7.5), ≤2 repairs, revocable review state, report.md/json |
| M4 Decisions, conflicts, feedback gate, `resume` | **functional** | policy decisions with SUPERSEDES edges, proposed→approved gate, feedback as proposed memory, integrity-checked resume that re-enters an interrupted Codex turn (thread id saved at `thread.started`, ≤2 re-entries, then verifies); diff-based incremental re-index (blob-id change detection, cached raw extraction, merge proven equivalent to a full index) with bound-section re-validation: a changed policy section is `conflicted` until re-approved |
| M5 Benchmark runner + metrics | **functional (small scale)** | `benchmarks/evaluate.ts` offline matrix run; live full + one live baseline run; metrics from artifacts only |
| M6 Team deployment | **partial** | container-isolated verification runner (`INTENTOS_VERIFIER=docker`, fail-closed) done; GitHub App, tenant isolation and hosted runners not started (docs/security.md) |

Tests: `npm test` → 21 files, **141 tests** (24 of them in `tests/unit/precedents.test.ts` + `tests/integration/precedents.test.ts`) (3 of them need a Docker daemon plus the `intentos-verifier:0.1` image and are skipped otherwise; `tests/integration/resume.test.ts` covers thread id persisted at `thread.started`, re-entry, bounded re-entry, no-thread/offline fallbacks, moved-worktree guard; `tests/integration/incremental_index.test.ts` proves incremental == full; `tests/integration/onboard.test.ts` covers the onboarding command); `npm run test:python` → **31 passed**; `npm run typecheck` clean. Suggestion-ranking benchmark on the fixture (`tests/integration/suggest_rank.test.ts`): precision@10 = 0.90, no unit-test/preamble noise in the top 10, mean score of policy material 0.64 vs 0.46 for noise.

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

**Functional (tested):** indexing with revision-bound evidence; incremental re-index (`index-cache` + `git ls-tree` blob diff + `--only-files` partial extraction, set-equal to a full index; `--full` override) with bound-section change detection; policy binding with `approved_policy` / `conflicted` / `superseded` statuses; retrieval with locations and `required`/`consider` reuse; conflict detection for superseded decisions and stale ADRs; strict contract schema; compiler (fabricated ids, revision, protected/unsafe paths, unknown commands, untrusted blocking, injection, hash); planner retry with compiler feedback (live); worktree isolation; live SDK planner/implementer/repair threads with event + usage capture; offline simulated engine (labelled); verification snapshot + trusted commands + JUnit parsing + architecture AST rules + frozen paths + scope/weakened-test detection + counterexample probes + consistency guard; bounded repair; transactional state machine with invalid-transition rejection; approval gate; resume with integrity checks (run dir, contract hash, worktree HEAD); reports; metrics; decisions propose/approve/supersede/feedback; benchmark runner.

**Limited:**
- Incremental re-index needs a clean working tree and a cache written by an earlier clean index of the previous revision; otherwise (and above 60 % changed files) it falls back to a full extraction. Renames are seen as delete + add.
- Retrieval is lexical + 1-hop import graph; `CALLS` edges are name-matched (confidence 0.4). No embeddings/reranking.
- Counterexamples are policy-template grids, not generated hypotheses; exploratory unless marked authoritative.
- `resume` re-entry of an interrupted Codex turn is exercised with an injected stand-in engine only (`tests/integration/resume.test.ts`); no live `resumeThread` continuation has been observed yet. Offline runs and runs without a recorded thread id still verify the worktree as is.
- Architectural-surprise triage covers three detectors (new internal import, duplicate helper by name or normalised body, domain construction in the API layer) on Python files only; it is review-only by design and does not analyse test files for duplicates.
- Baseline comparison: one live baseline run only; no statistical claim is made.
- Container isolation is opt-in (`INTENTOS_VERIFIER=docker`); the default `host` mode still executes candidate code on the host. In docker mode the results mount lets candidate code write files into the attempt directory, so forged-report defences stay in place (see docs/security.md).

**Stubbed / not started:** M6 GitHub App, tenant isolation, hosted runners. Embedding-based retrieval. Plots.

## intentos-setup skill (2026-10-27)
`skills/intentos-setup/SKILL.md`: a Codex skill that sets IntentOS up for a repository with checks at each step
(installation and `coordination`, `codex mcp add` from `mcp --print-codex-config`, `onboard` with the suite result at
base reported, `mine` with a model other than the session's and the rules written into the policy, optional
precedents, `explain` to confirm a first run can start), asking the user only for the checkout path, the repository,
the mining model and optional GitHub history. `intentos skill install` now installs both skills (`--name` for one).

## run, runs, merge and guard as MCP tools (2026-10-27)
A Codex session can now implement a ticket (`run`, background job polled through `status`, reports state and the
verification summary), list runs (`runs`), merge a verified run or a guardian's undo PR through mergeguard with the
user's approver names (`merge`), and investigate a red main (`guard`). The server instructions (steps 6–8) tell the host
to report only what the verifier recorded, to merge only on request, and never to invent approvers. Observed:
`tests/integration/mcp_run.test.ts` (offline run of task A → REVIEW_READY with acceptance pass → merge with one
approval, tier 1, merged-result verification passed, main fast-forwarded and re-indexed → guardian "healthy").

## Acceptance tests by a side model, and policies without a review step (2026-10-27)
`src/acceptance.ts` / `intentos acceptance`: a model other than the implementer writes a ticket's acceptance tests in a
read-only side thread (structured output); IntentOS runs them at the current revision with the repository's venv
(`--continue-on-collection-errors`, absolute `pythonpath` from the policy's project command) and keeps modules that fail
now for new behaviour or pass now for already-done tickets, sends rejections back once, writes survivors under
`benchmarks/hidden_tests/<policy>/tasks/<id>/` with author, thread, base and per-test status, and binds the task in
`benchmarks/tasks.json`. `tests/integration/acceptance.test.ts` (5) covers accept/reject/fix rounds, file naming,
collection errors, `--expect pass`, `--force`, the empty case and the ticket-file mapping.
`src/review.ts` `autoApprove`: `suggest --approve`, `mine --approve`, `review --auto`, and the MCP `mine` tool by default
(`review=true` keeps the old flow) write every kept candidate with a test into the policy and hidden tests as
`approved_by: auto:<model>`; testless invariants stay pending; the MCP instructions tell the host to inform the user
where to edit the file. `tests/integration/autoapprove.test.ts` (2). Trade-off recorded in README: auto-approved rules
carry blocking authority.

## Coordination between runs: mergeguard (2026-10-27)
mergeguard (the deterministic coordination harness for parallel coding agents) is part of this repository under
`mergeguard/` (package, 90 tests, design notes, demo, evaluation scripts and raw run logs; `npm run setup:python`
installs it into the venv; every invocation uses `python -I` so the directory never shadows the package). It runs inside IntentOS in local mode: the
indexed repository's checked-out branch is main, run worktrees are branches in waiting, and all mergeguard state (PR
registry, ledger, policy rendered from the IntentOS policy) lives under `INTENTOS_HOME/coordination/`. Pieces:
`src/coordination/mergeguard.ts` (client, local-mode environment, hook install/remove, `syncedBase`),
`src/coordination/merge.ts` (`intentos merge`, `intentos guard`, `intentos prs`), the `coordination` verification track
(`SYNC-STALE` blocking findings, `verification.coordination`), hook files written into the worktree for each live
implementer turn with hash-pinned trust passed as a Codex `--config` override, `base.advanced` when a worktree
fast-forwarded to main, and a merged-result verification (branch merged onto current main, verified with the hidden
tests) before mergeguard fast-forwards main. mergeguard itself gained local mode (`MERGEGUARD_MAIN`,
`MERGEGUARD_STATE_DIR`, `MERGEGUARD_POLICY_FILE`), `hooks install|remove`, a PR tier floor and `MERGEGUARD_MERGE_CHECK`.
Observed: `tests/integration/coordination.test.ts` (6 scenarios, offline runs with the real verifier and real mergeguard
on the fixture: merge with tier and approvals; meaning change behind unchanged names refused by the merged-result
verification and by mergeguard's merged-tree suite; bypassed merge → guardian `clash` with culprit and partner PRs →
validated undo PR (tier 2) merged through the gate; public rename tier 2 and a stale run told the exact symbol, blocked,
then merged after syncing; live sync path advancing the base), mergeguard `tests/test_local_mode.py` (5). See
docs/coordination.md. **Live (gpt-6-astra):** hooks written into the worktree were ignored by Codex (it reads project
`.codex/` only below a `.git` directory; a worktree's `.git` is a file; confirmed with `RUST_LOG=codex_hooks=debug` on
a clone vs a worktree), so each live turn now gets a private `CODEX_HOME` (`runs/<id>/codex_home/`: hooks.json, hooks
enabled, auth.json symlinked, hash-pinned trust by `--config`). Observed: SessionStart, PostToolUse and Stop fire in a
worktree; a full `intentos run` logged three hook records, verified `needs_review` with `sync_check` passed, and
`intentos merge --approve sam` landed it on main as PR #1 (tier 1) after the merged-result verification. Not done: a PR
waiting for review is not told automatically when main moves; mergeguard's branch CI uses the IntentOS venv
interpreter; the private CODEX_HOME carries none of the user's global Codex configuration.

Note on this machine: `tests/integration/pipeline.test.ts` "a verifier whose test runner cannot start" assumes `python3`
has no pytest; the default `python3` here (miniforge) has it, so that test fails for environmental reasons unrelated to
any change.

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

## Onboarding command (2026-10-26)
`intentos onboard <repo>` does the mechanical part of bringing a repository under IntentOS and refuses to invent
the authoritative part. `python/onboard_probe.py` (read-only, stdlib) reports project name and declared dependencies
(pyproject `[project]`, poetry, setup.cfg, requirements files), `src`/flat layout, packages, test directories, pytest
configuration, tox `PYTHONPATH` hints, Markdown documents and packaging files worth protecting. `src/onboard.ts` then
creates `.intentos/venvs/<repo-id>` with pytest plus the declared dependencies (never the package itself, because
verification runs from a snapshot copy), writes a DRAFT `policies/<id>.yaml` that parses under `PolicySchema` with
commands/paths/scope tags filled in and invariants/rules/decisions empty, runs the drafted `pytest_project` command
once at the base revision and records the JUnit result, and indexes. `repoInterpreter()` makes the verifier, the
counterexample probes, the container argv translation and `environment.json` use the repository's venv when it
exists; `INTENTOS_PYTHON` still overrides everything. `docs/policies.md` explains what a policy can say.
Two indexer fixes surfaced by onboarding a real src-layout repository (oemof/demandlib): module names now drop the
leading `src/` (so `oemof.demand.*` imports resolve as internal; 45 import edges instead of none on demandlib), and
the incremental cache carries an extractor fingerprint so a changed extractor forces a full re-index instead of
carrying stale names. Real run on demandlib: venv with numpy/pandas/matplotlib/geopandas, draft `oemof_demand.yaml`
(`src/**`, `tests/**` allowed; docs/packaging protected; `pytest src tests docs -o "pythonpath=src tests"`), suite
49 passed / 1 failed (`test_no_warning_with_empty_holidays`, a pandas-deprecation warning under pandas 3 — an
upstream environment issue, reported honestly), 26 files indexed, `explain` ranks `ElecSlp`, `set_holidays_in_df`
and the holiday tests for a holiday-calendar task.
Observed: `python/tests/test_onboard_probe.py` (4: src layout + optional test extras + tox hint, flat layout with
requirements/setup.cfg, explicit pytest pythonpath and self-dependency dropped, CLI entry point);
`tests/integration/onboard.test.ts` (7: src-layout draft + passing smoke + index with the fallback-policy warning when
written outside `policies/`, `--force` guard and an honest `failed` smoke, the startup_billing fixture (flat layout,
`pythonpath=.`), interpreter precedence, a draft that parses without packaging metadata, declared testpaths with
trailing slashes and doctest roots kept out of allowed paths, CLI `--json`); `python/tests/test_index_repo.py`
src-layout module names; `tests/integration/incremental_index.test.ts` extractor-fingerprint invalidation.

## Policy suggestions (2026-10-26)
`intentos suggest <repo>` (also `onboard --suggest`) mines the repository for policy CANDIDATES and writes
`policy-suggestions.md` (review document with evidence, paste-ready block and hidden-test draft per candidate),
`policy-suggestions.yaml` (blocks grouped as the policy expects them, every one with `approved_by: TODO`) and, with
`--write-adrs`, `docs/decisions/ADR-nnnn-*.md` drafts with `Status: Proposed` for candidates that have no document of
their own. `python/policy_suggest.py` (read-only, stdlib) mines fix/revert/prohibition commits (housekeeping subjects
filtered, same subjects merged, regression tests added in the commit linked), rule-like test names (negations rank
higher; the function source becomes the hidden-test draft), must/never sentences per document section (contributor
guides skipped), ADR fields (status + lineage), one-directional imports between sibling or parent/child package
directories, frozen directories and changelog deprecations. `--with-codex` sends the candidates to one read-only
planning thread with a strict JSON schema; ADRs citing candidate ids that were not offered are dropped. Nothing is
read back as authority. Observed:
- startup_billing fixture: the "Fix: cancelled contracts received volume discounts" commit merges into the
  `test_cancelled_contract_gets_no_discount` candidate (high) with a hidden-test draft; ADR-001..003 become decisions
  with the ADR-002→ADR-003 lineage; `app/domain must not import app/services` and the other two layering rules match
  ARCH-002; `app/legacy` is proposed frozen (matches ARCH-004); `docs/business-policy.md#Locked contracts` keeps its
  source heading (matches INV-001).
- oemof/demandlib (real repository): 53 raw candidates before tightening, 28 after, incl. the holiday rules
  (`test_weekdays_no_holidays`, `test_no_warning_with_empty_holidays`), `test_energy_demand_zero_sum`, two
  parent/child layering rules, one changelog deprecation. Remaining noise is for the reviewer to delete, by design.
- Review of the first real output (demandlib) fixed four defects: hidden-test drafts lifted from class-based tests
  now include the class header, its setup methods and decorators, the pytest fixtures they use (from the file or any
  conftest.py above it, recursively) and the module constants they reference, with notes for anything unresolved
  (`standalone: false`), and every draft is checked to be valid Python; `from pkg import submodule` resolves to the
  submodule so `applies_to_paths` names `tools.py` rather than the package `__init__`; commit-derived paths follow
  files that moved since (unique basename), otherwise the loss is recorded as evidence; scope tags no longer contain a
  stray `x`. Resolving re-exports also removed two false parent/child layering rules on demandlib (the package
  `__init__` does import its subpackages).
- Tests: `python/tests/test_policy_suggest.py` (9), `tests/integration/suggest.test.ts` (3, incl. the Codex evidence
  guard with an injected engine).

## Suggestion ranking, classification and review feedback (2026-10-26)
The first demandlib run needed a person to go from 26 candidates to 2; that filtering is now computed. The miner
builds a domain vocabulary from the repository's own identifiers, docstrings and headings (generic and infrastructure
words excluded, plurals folded) and scores every candidate: domain density 0.35, rule shape vs fix shape 0.15,
corroboration by distinct evidence types across its cluster 0.2, import-graph centrality 0.1, test age (`git log -S`)
0.1, source prior 0.1. Clusters link candidates sharing rarity-weighted distinctive terms (cap 8). Results are ordered
by score with `relevance` bands; `--min-score` cuts the tail. `--classify` sends the top candidates (default 40, batches
of 20) to one read-only Codex thread with a strict schema (category, keep, reason, one-sentence rule, cluster,
duplicate_of): unknown ids are ignored, a rewrite using an identifier absent from the evidence is rejected and the
original statement kept, set-aside candidates stay in the review document under a rescue heading and out of the YAML.
`--record` compares the last `suggestions.json` with the policy file (adopted hidden test, cited heading, matching rule,
statement overlap) and writes `feedback.json` with accept/reject terms the next ranking applies (accepted terms weigh
1.25, rejected ones count as infrastructure). Observed:
- Fixture benchmark: precision@10 = 0.90, 0 negatives in the top 10, locked/cancelled contract rules share a cluster
  with the `Locked contracts` section, largest cluster 5 of 28. Feedback test: after a policy adopts the cancelled
  contract rule, that candidate's score rises and the money value-object tests sink.
- demandlib: the holiday cluster (4 tests) leads at 0.86/0.77, robustness rules (negative factors, invalid TRY region,
  zero-sum demand) score 0.64–0.66, the pandas/merge/pip/datapath commits fall to 0.14–0.41 (low) — the ordering a
  reviewer produced by hand, now computed.
- Live `--classify` on demandlib (gpt-5.6-terra, ChatGPT session, 2 batches): first run kept 10 of 26 but set aside two
  holiday tests "because the test name gives no expected behaviour" — the prompt had only shown names. With each test's
  body in the prompt the second run kept 11 (all four holiday rules, the zero-sum and negative-factor robustness rules,
  the documented house-parameter constraints) and set aside all pandas/merge/pip/datapath/tooling candidates; rewrites
  cite the real functions (`add_weekdays2df` with `holidays=[]` must issue no warning and no weekday equal to 0;
  `create_bdew_load_profiles` with `holidays=None` must warn "No holidays given"). One rewrite was rejected by the
  evidence guard in each run. The 26 → 2 that a person did by hand is now 26 → 11 by machine, with the 11 readable.
- Tests: `tests/integration/suggest_rank.test.ts` (6: benchmark, --min-score, classification with an injected engine,
  rewrite guard, CLI, feedback loop); python tests updated for score/rank/cluster fields.

## Review UI (2026-10-26)
`intentos review <repo>` replaces the copy-paste review: a Node `http` server bound to 127.0.0.1 with a random token in
the URL serves one page that walks the candidates of the last `suggest` run one by one (rule statement prefilled with
the classifier's rewrite and editable, evidence, where it applies, the source it will cite, the hidden test that will
be written; keys A/R/S). Approving allocates the next `INV-`/`ARCH-`/`DEC-` id from the policy document, appends the
block with the reviewer's name using the YAML document API (comments preserved; the file is validated and restored on
failure), writes the hidden-test draft under `benchmarks/hidden_tests/<id>/invariants/` with an origin header and any
TODOs, and adds a section to `docs/intentos-policy.md` in the repository when the candidate has no Markdown source so
the policy can bind it by heading. Rejections carry a reason; Finish records feedback, re-indexes and stops the server.
Related candidates (the ranker's clusters: shared distinctive terms, so usually one rule family, sometimes a false
member) are listed on the card with checkboxes, preselected for invariants that have a test; approving folds the ticked
ones into the same policy entry as extra `verified_by` hidden tests, and they are marked as merged into that id so they
cannot be approved twice. Observed on the fixture (`tests/integration/review.test.ts`, 7): approving the cancelled-contract candidate yields
INV-001 with the hidden test file and a new notes section; a doc-sourced candidate cites `business-policy.md#Locked
contracts`; a layering rule becomes ARCH-001 with its paths and forbidden modules; an ADR becomes DEC-001 (the
file-based `supersedes` is dropped with a warning); duplicate approvals, unknown ids and bad actions are refused;
the two entitlement candidates fold into INV-003 with two hidden tests and one entry; Finish reports 5 approved, 1
folded, 1 rejected, 1 skipped, writes feedback with the accepted terms, re-indexes with zero unresolved sources, and
the server stops. The page is a single file with no external resources (works offline, light and dark).

## MCP server and review widget (2026-10-27)
`intentos mcp` runs IntentOS as an MCP server on stdio (SDK v2 `@modelcontextprotocol/server`, apps extension
`@modelcontextprotocol/ext-apps`). Model-visible tools: `explain` (evidence pack, text + structured), `policy`
(approved invariants/rules/decisions with sources), `review_start` (loads the last `suggest` run; `_meta.ui.resourceUri`
= `ui://intentos/review.html`). App-only tools (`_meta.ui.visibility: ["app"]`): `review_session`, `review_state`,
`review_decide`, `review_finish`, all requiring the session's widget token that only `review_session` returns, so a
model-initiated approval is refused even by a host that ignores visibility. The widget is the review page in `widget`
mode: the apps browser bundle (`app-with-deps.js`, ~410 KB) is inlined as a classic script exposing
`globalThis.__mcpApps`; the page connects to the host over `PostMessageTransport` and routes its three API calls to
the app-only tools. A client without the UI extension gets the token-protected local URL from `review_start`
instead. `.intentos/mcp.log` records the client's declared capabilities. `codex mcp add intentos -- node
~/intentos/bin/intentos.js mcp` registers it (printed by `intentos mcp --print-codex-config`).
Observed: `tests/integration/mcp.test.ts` (4): tool visibility and the resource (bundle + page compile as classic
scripts); UI-capable client → `ui: "widget"`, no token in the model-visible result, approvals without or with a wrong
token refused and the policy untouched, approval via the session token lands INV-001 with its hidden test, finish;
client without the extension → `ui: "link"` with a working token-protected page; CLI registration command. The real
stdio process answers `tools/list` and `resources/read` (7 tools, 415 KB page).
- Headless Codex (`codex exec --approve-for-me`, Codex CLI 0.154.0, model gpt-5.6-terra) against the real stdio server
  on demandlib: the client identified as `codex-mcp-client` and declared `elicitation: {form, url}` plus an
  experimental `codex/auth-change` capability — **no MCP Apps UI extension**, so Codex does not render the widget today.
  It listed exactly `explain`, `policy`, `review_start` (the app-only tools were not offered to the model), `explain`
  returned the evidence pack (15 symbols; first three `BDEW25Profile`, `ElecSlp.create_bdew_load_profiles`,
  `IndustrialLoadProfile`), `review_start` took the fallback path and returned `ui: "link"` with the token-protected
  URL, and when asked to approve a candidate itself the model reported that `review_decide` was not visible. A first
  run without `--approve-for-me` had every tool call blocked by `codex exec`'s approval policy before it reached the
  server.
- Elicitation path (same day): `review_next` presents one candidate through the host's own prompt (form: decision
  enum defaulting to skip, editable statement prefilled with the classifier's rewrite, optional reason, fold-related
  toggle) and applies the reviewer's answer; `review_close` confirms finishing. Both support the 2026-07-28
  multi-round-trip (`input_required` + retry, `acceptedContent`) and the earlier push-style `elicitInput`, chosen by
  the negotiated protocol version. Tests with an in-memory host that answers the prompts: approval with an edited
  statement lands INV-001 (plus folded tests), a declined prompt records nothing, a rejection with reason is recorded,
  `review_close` honours a declined confirmation and finishes on a confirmed one; a host without elicitation is
  pointed at the review page.
- Headless Codex (0.154.0) with the elicitation tools: Codex negotiated protocol 2025-06-18 (legacy era), so the
  server used the push-style `elicitInput`; Codex relayed the form request and, having no human in `codex exec`,
  answered `cancel`; the server reported "CAND-001 left undecided (reviewer cancel)" and recorded nothing. The round
  trip server → Codex → reviewer → server is proven; in the interactive Codex app or CLI the same request is shown to
  the reviewer as a form.
- Onboarding from the host (2026-10-26): `status` (where a repository stands, job progress, the next tool to call) and
  `onboard` (runs `intentos onboard` then `intentos suggest --classify` as child processes, returns a job id at once,
  refuses to overwrite a policy without `force`), so the user says one sentence; MCP `instructions` carry the working
  order and `review_start` points a not-onboarded repository at `onboard`. Found on the way: the Codex app starts MCP
  servers with an empty PATH (`MCP startup failed: No such file or directory`), so the registration now uses the
  absolute node path and the stdio server widens PATH for its children; the CLI now prints progress to stderr in
  `--json` mode too. Tests: instructions and `status` on the fixture, `review_start` on a missing policy, refused
  re-onboard, `status` on a non-repository, a full background onboard of the fixture (install=false, classify=false)
  polled through `status` (second `onboard` and early `review_start` refused while it runs) and then reviewed.
- Headless Codex (0.154.0) on a throwaway copy of the fixture, prompt "Bring this repository under IntentOS with the
  intentos MCP server and walk me through the policy candidates", no tool names given: Codex called `status`
  ("not onboarded: call onboard"), `onboard` (defaults: venv, suite, index, mining, classification), polled `status`
  every 20–40 s through the classifying phase (about 4 minutes), then `status` again ("11 candidate(s) await the
  reviewer"), `review_start` and `review_next`; the headless session cancelled the form, and Codex reported the
  outcome (17 tests passed at the base revision, 28 candidates, 11 kept, 0 approved) with the review link as the
  fallback. The CLI was never typed by anyone.
- Widget first (2026-10-26): in the Codex app the same review appeared twice, as the inline widget and as the
  elicitation form, because the app declares the UI extension (`text/html;profile=mcp-app`, seen at call time in
  `mcp.log`, not at initialize) and elicitation, and the model followed the instructions into `review_next`. The
  session now records `ui: widget | link`; with the widget rendered, `review_next` returns a deferral (not an error)
  and the instructions and `review_start`'s result say to wait for the reviewer instead. The Codex CLI client still
  has no UI extension and keeps the form path. Test: a UI-capable host calling `review_next` after `review_start`
  gets the deferral.
- Mining by the host (2026-10-26): the candidates a reviewer sees are the ones Codex selected and backed with a test.
  IntentOS ships the instructions as a Codex skill (`skills/intentos-policy-mining/SKILL.md`, installed into
  `~/.agents/skills` by `intentos skill install`, served by the `mining_guide` tool to hosts without skills) and
  takes the result through `propose`: shape errors per proposal, `from_mined` inheritance from the cached raw list
  (`mined` tool), references checked against tracked files and the commit graph (Python `Ingestor`), a test required
  for every invariant, existing tests lifted with the miner's machinery and run at HEAD, written tests run in the
  repository's venv, rejections with the pytest tail, accepted candidates written as `suggestions.json` with
  `authored_by: codex` so the review path is unchanged; `append` continues an earlier list. `onboard` no longer
  classifies by default; `status` reports who authored the list and says to mine with the skill. Tests: Python
  (`--ingest`: lifting, evidence lines, rejections, CLI), `tests/integration/propose.test.ts` (lifted / written /
  architecture rule accepted; failing test, invented reference, untested invariant and malformed proposal rejected;
  approval writes the agent's test; append and replace; `from_mined`; skill install and CLI), MCP (`mining_guide`,
  `mined`, `propose`, `status` with `authored_by`, `review_start` on the host-authored list).
- Headless Codex (0.154.0) on a throwaway copy of the fixture with the skill discoverable in `.agents/skills`, prompt
  "Bring this repository under IntentOS and walk me through the policy candidates", no tool or skill names given:
  `status` → `onboard` (11 s on the fixture) → `status` ("the current 28 candidates are the miner's; author your own
  with the skill") → `mined` → two minutes of reading → `propose` with 18 candidates: 17 accepted, 1 rejected
  (`sources` sent as strings), resubmitted twice with `append=true` until the shape was right → `review_start` with
  18 candidates. All 16 invariants cite an existing test that was lifted and passed at HEAD (the fixture has a test
  for every rule, so Codex rightly wrote none); the other two are an architecture rule and a decision. Codex's
  summary grouped them (financial correctness, pricing, subscription safety, export contracts, design decisions) and
  handed over the review link. The one rejection led to accepting a bare path string as a `sources` entry and to
  documenting the shape in the skill.
- The independent miner (2026-10-27): the model that mines the rules can be one other than the model driving the
  session (which later implements under those rules), so one model's bias does not write the policy. `intentos mine
  <repo> --model <slug>` and the MCP `mine` tool run the same skill in a separate read-only Codex thread with that
  model (`LiveCodexEngine` takes model and reasoning overrides; `plan` resumes a thread), take the structured answer
  (`MINE_SCHEMA`, nulls stripped by `normalizeProposal`) through `ingestProposals` unchanged, send the rejections back
  to the same thread for one more round, and record `author: {via: side_thread, model, engine, thread_id}` in the
  review list; `status`, `review_start` and the widget header name the author. The model is required (`model` or
  `INTENTOS_MINING_MODEL`, and `status` steers the host to `mine` when the variable is set); `append` puts a second
  model's list next to the first's; `--replay` re-checks saved answers (`<out>/mine/round-N.json`) without Codex. Tests:
  `tests/integration/mine.test.ts` (prompt contents, two rounds in one thread, author recorded, CLI replay, refusals,
  normalisation) and MCP (`mine` refused without a model or a policy, background job gated by a fake engine, status
  while running and when done, `review_start` and the widget session naming the author, `INTENTOS_MINING_MODEL`).
- Headless proof of the independent miner (2026-10-27): Codex 0.164.0 (`gpt-6.1-sol`, the SDK's bundled binary; the
  0.154.0 CLI rejects the GPT-6 models on a ChatGPT account) on a throwaway copy of the fixture, prompt "Bring this
  repository under IntentOS, have gpt-6-astra mine the business rules independently of you, and walk me through the
  policy candidates": `status` → `mine` with `model=gpt-6-astra` → 17 `status` polls over eleven minutes (the host read
  the repository meanwhile and explained what the review would cover) → done: round one 19 candidates, 15 accepted,
  4 rejected and sent back; round two all 4 fixed; 10 invariants lifted from existing tests, 4 with tests Astra wrote
  and that passed in the venv, 5 rules without tests → `review_start` with 19 candidates. Two findings: lifted drafts
  that pull a conftest put its `from __future__` import after the module's own imports (now hoisted, covered by the
  Python test), and the host re-submitted Astra's list with `propose`, which recorded itself as the author; the server
  instructions now say not to.

## Next steps
1. Run `evaluate.ts --mode full` and `--mode baseline` several times per task (A–D) and record variance before any comparative claim.
2. Resume re-entry: done with a stand-in engine (2026-10-26); still to do: observe one real `resumeThread` continuation with live credentials.
3. Symlink-escape checks on snapshot copy; stronger-than-Docker isolation (gVisor/VM) for the container verifier.

## Precedents: ticket history as evidence (2026-10-27)
`intentos precedents sync <repo> --issues owner/name [--pulls owner/name]` fetches the tracker's closed issues and
the merged pull request that resolved each one (links in the ticket text + issue timeline, via `gh`), reads the
pull request's diff from the local history (files, enclosing Python definitions of changed lines, tests added) and
stores `.intentos/precedents/<repo-id>.json`; every `index` re-links the precedents to HEAD (`precedent` nodes,
`TOUCHES`/`ADDS_TEST` edges, `historical_precedent` evidence) following renames (`git diff -M`, then path tail) and
marks them `current` / `partially_stale` / `stale` / `unlinked`. `explain` ranks them (lexical + structural overlap),
the planner may cite their evidence ids, the implementer prompt names their location and tests, the verifier adds
review-only `PRECEDENT-FOLLOWED` / `PRECEDENT-DIVERGENCE` signals, the report has a Precedents section, and the MCP
server exposes `precedents`. Observed on `oemof-demand` (43 reconstructed tickets on the fork
`Cyr-Ch/oemof-demand`, pull requests upstream, package renamed `demandlib` → `oemof.demand` in between): all 43
linked to their diff; at HEAD 19 current, 12 partially stale, 12 stale (pre-rename examples, `setup.py`, removed
modules). `explain "Raise an error instead of a warning when a profile is created without holidays"` returns #43
(`oemof.demand.tools.set_holidays_in_df`, the two holiday tests) at relevance 1, then #25 and #41.
Limits: definitions by indentation walk-up only; first merged pull request per ticket; ranking is heuristic.
