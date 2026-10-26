# Architecture

IntentOS is a modular monorepo with one controller (TypeScript) and two deterministic Python helpers.
Codex remains the code-editing engine; IntentOS supplies grounded context, a compiled contract, an
isolated execution environment and independent verification.

```
intentos CLI (src/cli*.ts)
   │
   ▼
Orchestrator (src/orchestrator)  ── durable state machine (SQLite runs/run_events + run dir mirror)
   │   CREATED → INDEXED → CONTEXT_RETRIEVED → CONTRACT_PROPOSED → CONTRACT_VALIDATED
   │        → CLARIFICATION_REQUIRED | ABSTAINED | APPROVED → IMPLEMENTING → VERIFYING
   │        → REVIEW_READY | REPAIRING→VERIFYING (≤2) | HUMAN_REVIEW | FAILED
   │
   ├── UNDERSTAND  src/knowledge  ── python/index_repo.py (AST + git) → nodes/edges/evidence @ HEAD sha
   │                                 policy binding (policies/*.yaml → invariants/rules/decisions nodes)
   │                                 retrieval.ts (lexical + graph) → EvidencePack; conflicts.ts
   ├── CONTRACT    src/contracts  ── Zod schema → strict JSON schema for Codex structured output
   │                                 compiler.ts: deterministic validation + injection of trusted constraints
   ├── CODEX       src/codex      ── adapter.ts (@openai/codex-sdk only here): read-only planner thread,
   │                                 workspace-write implementer thread in the worktree; offline.ts simulated engine
   ├── VERIFY      src/verification ── snapshot worktree → copy hidden tests beside it → run only allowlisted
   │                                 commands (pytest/junit), AST architecture rules, scope/frozen-path diff checks,
   │                                 bounded counterexample probes → VerificationResult
   └── REPORT      src/reports    ── report.md / report.json from persisted artifacts only
```

## Engineering World Model

SQLite (`node:sqlite`, WAL) with the spec's tables (`repositories`, `nodes`, `edges`, `evidence`, `decisions`,
`runs`, `run_events`) plus `schema_migrations`. Graph rows are keyed by `(id, repo_id, revision)`, so several
revisions coexist and a re-index at a new HEAD never mutates older revisions. Evidence IDs are content-addressed
(`EV-<sha256(revision|type|path|lines|name)>`), so the same span at the same revision always has the same ID and
a planner cannot "guess" valid IDs for other revisions.

Node kinds: `module`, `symbol`, `test`, `doc_section`, `invariant`, `architecture_rule`, `decision`.
Edges: `DEFINES`, `IMPORTS`, `VALIDATED_BY` (test module imports module/symbol; confidence 0.7–0.8), `CALLS`
(name-resolved only; confidence 0.4, `extraction_method=ast_name_match`), `DOCUMENTED_IN`, `DECIDED_IN`,
`CONSTRAINS`, `SUPERSEDES`.

Authority is never derived from repository text alone: a doc section starts as `historical_precedent`; it becomes
`approved_policy`/`approved_decision` only when a trusted policy file binds it (by path + heading, optionally pinned
by content hash → `conflicted` when the text changed). ADRs whose own text says "Superseded" are stored with status
`superseded`, and a policy that still calls such a decision approved is flagged as conflicted.

## Evidence pack (`explain`)

Lexical query expansion (built-in + policy synonyms) scores symbols, docs and tests; one-hop reverse imports give
probable impact (`static_imports_only`); `VALIDATED_BY` edges give existing tests; invariants/rules/decisions are
filtered by scope tags and token overlap. `reuse_recommendation` is `required` only when an approved decision names
the symbol; everything else is `consider`. Facts (symbols, tests, docs, policy) are separated from `suggestions`.

## Engineering Change Contract

`src/contracts/schemas.ts` defines the contract (all fields required → strict structured output). The compiler:
rejects revision mismatches, unknown/unlinked evidence, unknown symbols/invariants/rules/commands, unsafe or
protected paths, blocking constraints without trusted authority or with conflicted status, and implement decisions
with blocking open questions (→ `clarify`). It *injects* every applicable binding invariant/rule and every required
trusted command the planner omitted, forces policy-blocking constraints back to blocking, and hashes the result
(`contract_hash`) so `verify`/`resume` can detect tampering. Live planner rejections get one retry with the issue
list; a second rejection fails the run.

## Role separation

| Role | Context | Can write |
|---|---|---|
| Planner | Codex thread, `sandboxMode: read-only`, network off, cwd = repo | nothing |
| Implementer | Codex thread, `workspace-write`, cwd = detached worktree at base SHA | the worktree (scope-checked afterwards) |
| Verifier | orchestrator process; snapshot copy + hidden tests from `benchmarks/hidden_tests`; with `INTENTOS_VERIFIER=docker` the executing commands run in a container (read-only snapshot, no network, resource limits) and only JUnit files come back | run dir only |
| Human | `approve`, `decision approve`, `feedback` | decisions table, approvals |

## Verification result

Findings carry `category` (functional / business_invariant / architecture / scope / counterexample / process),
`severity` (blocking / review / info), `rule_id`, `source_evidence_ids`, `expected/observed`, log path and
`authority` (trusted_policy / hidden_test / project_test / exploratory / deterministic). `REVIEW_READY` requires zero
blocking findings; review findings route to `HUMAN_REVIEW`. A consistency guard turns any non-passing blocking command
into a blocking finding even when no test case was parsed, and "passed with zero tests collected" is itself a finding.
The result records `verifier: {mode, image, image_digest}`; in docker mode an unavailable daemon or image produces
`VERIFIER-UNAVAILABLE` blocking findings instead of a silent fallback to the host (`src/verification/sandbox.ts`).

## Architectural surprise (review signals)

`architecture_surprise` is a builtin verification command (advisory, injected by the compiler when the policy lists
it) that compares the changed Python files against the base revision with `python/architecture_surprise.py` and
emits **review-only** findings (`category: architecture`, `authority: deterministic`, rule ids `SURPRISE-*`):
a changed file importing an internal module it did not import at base (`SURPRISE-NEW-DEPENDENCY`), an added
function whose name or normalised body (docstring dropped, parameters renamed positionally, ≥ 3 statements) matches
an existing one (`SURPRISE-DUPLICATE-HELPER`), and a new construction of a domain class inside the API layer
(`SURPRISE-API-DOMAIN-CONSTRUCTION`; Enum access is not a construction). Paths come from the optional policy block
`architecture_surprise: {api_paths, domain_paths, ignore_names}` (defaults `app/api/**`, `app/domain/**`). Base
sources are read with one `git cat-file --batch`; test files are not analysed for duplicates. These signals are risk
triage, not proof of bad design: a run with only these findings ends in `HUMAN_REVIEW`, and the report lists them
under "Architectural surprise (review signals)".

## Resume and thread re-entry

`intentos resume <run-id>` first runs the integrity checks (run dir, contract hash, worktree at base SHA; plus the
informational `codex_thread_known`). A run interrupted during IMPLEMENTING or REPAIRING is then re-entered rather
than merely verified: the implementer thread id is persisted the moment the SDK emits `thread.started` (not only
when a turn completes), and the orchestrator sends a continuation prompt to that same thread
(`continue_prompt.N.txt`, "your previous turn was interrupted; inspect `git status`/`git diff`, do not start over"),
records the turn like any other implementation turn, and only then verifies. Re-entry requires a live engine, a
known thread id and a worktree still at the base SHA, and happens at most twice per run (counted from
`resume.reentered` events); otherwise a `resume` event states why and verification runs on the worktree as is.
Nothing the re-entered turn claims is trusted: verification decides, exactly as for a first turn.

## Incremental indexing

Currently the repository is re-indexed in full at each new HEAD (fast for fixture-sized repos). Diff-based
invalidation is the next step; assertions are never carried across revisions implicitly.
