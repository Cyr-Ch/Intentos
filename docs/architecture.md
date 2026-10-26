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

## Onboarding (`intentos onboard`)

`src/onboard.ts` runs the read-only probe `python/onboard_probe.py` (project name and declared dependencies from
pyproject / poetry / setup.cfg / requirements files, `src` vs flat layout, test directories, pytest configuration,
tox `PYTHONPATH` hints, Markdown documents, packaging files to protect), creates `.intentos/venvs/<repo-id>` with
pytest plus the declared dependencies, renders a draft policy that parses under `PolicySchema` with empty
invariants/rules/decisions, runs the drafted `pytest_project` command once against the base revision and records
the JUnit result, then indexes. `repoInterpreter()` (`src/knowledge/venv.ts`) makes the verifier, the counterexample
probes and `environment.json` use the repository's venv when it exists; `INTENTOS_PYTHON` overrides it.

## Policy suggestions (`intentos suggest`)

`src/suggest.ts` runs the read-only miner `python/policy_suggest.py` and renders its candidates as a review
document, paste-ready YAML and ADR drafts. The miner reads `git log` (fix/revert/never/must messages and the files
they touched, with regression tests added in the same commit), test functions whose names contain rule tokens
(negations rank higher; the function source becomes a hidden-test draft), Markdown/RST sections with modal sentences
(one candidate per section, source = path + heading), ADR fields (`Status`, `Supersedes` → decision status and
lineage), module-level internal imports aggregated per layer directory (an edge A→B with no B→A becomes
"B must not import A"), directories whose name or history says frozen, and changelog deprecations. Candidates are
ranked by a business-relevance score and every policy block carries `approved_by: TODO`. The ranker builds a domain
vocabulary from the repository's own identifiers, docstrings and headings (generic and infrastructure words
excluded; plurals folded) and scores each candidate on domain density (0.35), rule shape versus fix shape (0.15),
corroboration by distinct evidence types across its cluster (0.2), import-graph centrality of the paths it applies
to (0.1), test age from `git log -S` (0.1) and a prior by source type (0.1). Clusters link candidates that share
rarity-weighted distinctive terms, capped at eight members so a common word cannot chain the whole list.
`tests/integration/suggest_rank.test.ts` is the precision benchmark against the fixture's real policy. With
`--classify`, batches of twenty top candidates go to one read-only planning thread with a strict JSON schema
(category, keep, reason, rule, cluster, duplicate_of); unknown ids are ignored, a rewrite that uses an identifier
absent from the evidence is rejected, and set-aside candidates remain visible. With `--with-codex` the kept
candidates' evidence goes to a thread that drafts ADR prose; an ADR whose `candidate_ids` include an id that was not
offered is dropped. `--record` compares the last `suggestions.json` with the policy file (adopted hidden test,
cited source heading, matching rule or statement) and writes accept/reject term weights the miner applies next time.
Nothing the command writes is read back as authority.

## Review UI (`intentos review`)

`src/review.ts` serves a single page from a Node `http` server bound to 127.0.0.1 with a random token in the URL
(every API call must carry it; nothing is reachable from other hosts or without the printed link). The page lists the
candidates of the last `suggest` run and shows one card at a time: rule statement (prefilled with the classifier's
rewrite when there is one, editable), evidence, where it applies, the source it will cite, and the hidden test that
will be written. Approving calls `acceptCandidate`: the next free `INV-`/`ARCH-`/`DEC-` id is allocated from the policy
document, the block is appended with `yaml`'s document API so comments survive, the file is validated against
`PolicySchema` and restored on failure, the hidden-test draft is written under `benchmarks/hidden_tests/<id>/invariants/`
with a header stating its origin and any TODOs, and a candidate without a Markdown source gets a section in
`docs/intentos-policy.md` of the repository (created on first use) so the policy can bind it by heading. Rejections
and skips are persisted in `review-decisions.json`; Finish records feedback, re-indexes and stops the server.

## MCP server (`intentos mcp`)

`src/mcp.ts` builds an `McpServer` (SDK v2) with the MCP Apps extension. Model-visible tools: `explain` (evidence
pack), `policy` (approved rules with sources), `review_start` (loads the last `suggest` run into a review session;
`_meta.ui.resourceUri` points at `ui://intentos/review.html`). App-only tools (`_meta.ui.visibility: ["app"]`):
`review_session`, `review_state`, `review_decide`, `review_finish`; they also require the session's widget token, which
only `review_session` returns, so a model-initiated approval is refused even by a host that ignores visibility. The
widget resource is the same review page in `widget` mode: the apps browser bundle is inlined as a classic script that
leaves its exports on `globalThis.__mcpApps`, the page connects to the host over `PostMessageTransport` and routes
its three API calls to the app-only tools. When the client does not declare the UI extension (`getUiCapability`),
`review_start` starts the local HTTP review server and returns its token-protected URL. For hosts that declare
elicitation, `review_next` builds a form (decision enum defaulting to skip, editable statement prefilled with the
classifier's rewrite, optional reason, fold-related toggle) and obtains the reviewer's answer through the host: on
2026-07-28-era clients by returning an `input_required` result that the client fulfils and retries
(`acceptedContent` on the retry), on earlier clients through the push-style `elicitInput` request. `review_close`
confirms finishing the same way. Client capabilities, negotiated protocol version and tool calls are logged to
`.intentos/mcp.log`.

Onboarding from the host: `status` reports whether the repository has a policy file (and how many approved rules), an
index, mined and classified candidates and how many are undecided, plus the state of a running job and the next tool
to call. `onboard` validates the request (Git checkout, no existing policy unless `force`), then runs `intentos
onboard` and `intentos suggest [--classify]` as child processes of the server with `--json` (their stderr progress
lines become the job log) and returns immediately with a job id, because hosts time out tool calls long before a
venv, a test run and an index finish; the model polls `status`. The server declares MCP `instructions` with the
working order (status → onboard → status… → review_start → review_next… → review_close; explain and policy before
planning) so the host needs no prompt engineering, and `review_start` answers a not-onboarded repository with the
same instruction. The stdio entry point widens `PATH` with the node binary's directory, Homebrew, `/usr/local/bin`
and `~/.local/bin` because GUI hosts start servers with a bare environment, and the printed Codex registration uses
the absolute node path for the same reason.

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

Every index of a clean working tree caches its raw extraction under
`<INTENTOS_HOME>/index-cache/<repo-id>/<revision>.json`, together with the git blob id of each indexed file
(`git ls-tree -r`). The next `intentos index` of a clean tree lists the blobs at HEAD, re-extracts only the files
whose blob id changed (`python/index_repo.py --only-files`, which still computes the module list from the whole tree
so imports resolve against files that were not parsed), carries the cached extraction of unchanged files
explicitly after the blob-id check, drops deleted files, and rebuilds the entire graph for HEAD from the merged
extraction with the unchanged graph builder. Equivalence with a full index therefore holds by construction, and
`tests/integration/incremental_index.test.ts` asserts set equality of nodes, edges and evidence against a full
index of the same HEAD. Evidence ids are revision-scoped, so carried files get fresh ids. `--full`, a dirty tree, a
missing or mismatching cache, or more than 60 % changed files fall back to a full extraction with a note in
`limitations`; the summary reports `mode`, `changed_files`, `deleted_files`, `carried_files` and `cache_file`.

Assertions are never transferred implicitly (spec §6.4). Each policy-bound section records its `content_hash` and
an `approved_content_hash` (the policy's `content_sha256` pin, or the hash bound when the section was first
confirmed). When the current hash differs from the approved one the source and its constraint become
`conflicted`, the section is listed in `unresolved_sources` as "section content changed since <rev>", the evidence
pack shows the constraint as non-binding and the compiler rejects any contract that makes it blocking, routing the
planner to clarify. The conflict persists across later revisions until a human re-approves it by pinning the new
`content_sha256` in the policy or by restoring the section text.
The cache records a fingerprint of `python/index_repo.py`; a cache written by a different extractor version is never
reused (full re-index with a note), so extractor changes such as the `src/` layout handling cannot leak stale
names through the incremental path. Module names drop a leading `src/` component (src layout), so absolute imports
like `from oemof.demand.tools import …` resolve as internal.

