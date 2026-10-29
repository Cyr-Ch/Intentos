# Architecture

IntentOS is a modular monorepo with one controller (TypeScript) and deterministic Python helpers.
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
   │                                 commands (pytest or vitest/jest, junit), AST architecture rules (Python, TS), scope/frozen-path diff checks,
   │                                 bounded counterexample probes → VerificationResult
   └── REPORT      src/reports    ── report.md / report.json from persisted artifacts only
```

## Engineering World Model

SQLite (`node:sqlite`, WAL) with the spec's tables (`repositories`, `nodes`, `edges`, `evidence`, `decisions`,
`runs`, `run_events`) plus `schema_migrations`. Graph rows are keyed by `(id, repo_id, revision)`, so several
revisions coexist and a re-index at a new HEAD never mutates older revisions. Evidence IDs are content-addressed
(`EV-<sha256(revision|type|path|lines|name)>`), so the same span at the same revision always has the same ID and
a planner cannot "guess" valid IDs for other revisions.

Node kinds: `module`, `symbol`, `test`, `doc_section`, `invariant`, `architecture_rule`, `decision`, `precedent`
(a resolved ticket plus its merged pull request, from `<home>/precedents/<repo-id>.json`; see
[precedents.md](precedents.md)).
Edges: `DEFINES`, `IMPORTS`, `VALIDATED_BY` (test module imports module/symbol; confidence 0.7–0.8), `CALLS`
(name-resolved only; confidence 0.4, `extraction_method=ast_name_match`), `DOCUMENTED_IN`, `DECIDED_IN`,
`CONSTRAINS`, `SUPERSEDES`, `TOUCHES` (precedent → symbol/module it changed; 1.0 exact or traced rename, 0.6 bare
name), `ADDS_TEST` (precedent → test it introduced).

Authority is never derived from repository text alone: a doc section starts as `historical_precedent`; it becomes
`approved_policy`/`approved_decision` only when a trusted policy file binds it (by path + heading, optionally pinned
by content hash → `conflicted` when the text changed). ADRs whose own text says "Superseded" are stored with status
`superseded`, and a policy that still calls such a decision approved is flagged as conflicted.

## Evidence pack (`explain`)

Lexical query expansion (built-in + policy synonyms) scores symbols, docs and tests; one-hop reverse imports give
probable impact (`static_imports_only`); `VALIDATED_BY` edges give existing tests; invariants/rules/decisions are
filtered by scope tags and token overlap. `reuse_recommendation` is `required` only when an approved decision names
the symbol; everything else is `consider`. Facts (symbols, tests, docs, policy) are separated from `suggestions`.
Precedents are ranked by the same lexical scoring plus structural overlap (symbols, files and tests the precedent
changed that were retrieved for the task); the top three travel in the pack with their evidence ids, a `stale` one
also as a `stale_precedent` conflict.

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

## Evidence digest (`intentos evidence`, MCP `evidence`)

IntentOS has no rule miner of its own. `python/policy_evidence.py` (read-only, stdlib) builds a **digest of facts**
the model reads before stating rules, and `loadDigest` (`src/propose.ts`) caches it per revision in
`<out>/evidence.json`: every test (pytest function, or vitest/jest `it`/`test` title with its `describe` chain) with
its first assertion and the production files it imports (relative imports and `tsconfig` path aliases resolved, so
the model knows which code each test exercises; `rule_like` marks names with negation or modal tokens), every commit
that touched code with the source and test files it changed and the tests it added (`looks_like_fix` marks fix-shaped
subjects), every modal sentence (must/never/always/only/required/not allowed) from Markdown/RST documents with its
heading and line, ADRs with `status` and `supersedes`, import edges between directories, directories nobody has
touched in a long time, changelog deprecations, **code notes** (modal sentences in docstrings and comments of
production code, from `ast.get_docstring` and `tokenize` for Python and JSDoc/line comments for TypeScript, with the
symbol they document; pragmas, licences and TODOs excluded), and **resolved tickets** from the synced precedents file
(`--precedents`, passed by `loadDigest` when `precedents sync` has run; a new sync invalidates the cache): title, the
first modal sentence of the body, the pull request that settled it with its merge commit, files, symbols and the tests
it added. Evidence types `code` (`path:line`, checked like a document line) and `ticket` (`#n`, checked against the
synced file; refused when nothing is synced) let the model cite them. Nothing is scored, clustered or classified: `renderDigest` prints
the same facts for a person, the MCP `evidence` tool serves the digest whole or by section, and the skill tells the
model to read the code behind the facts that look like rules before stating any. What the model decides is checked by
the `Ingestor` (next sections), never trusted.

## Review UI (`intentos review`)

`src/review.ts` serves a single page from a Node `http` server bound to 127.0.0.1 with a random token in the URL
(every API call must carry it; nothing is reachable from other hosts or without the printed link). The page lists the
candidates of the last `propose` or `mine` run and shows one card at a time: rule statement (editable), evidence, where it applies, the source it will cite, and the hidden test that
will be written. Approving calls `acceptCandidate`: the next free `INV-`/`ARCH-`/`DEC-` id is allocated from the policy
document, the block is appended with `yaml`'s document API so comments survive, the file is validated against
`PolicySchema` and restored on failure, the hidden-test draft is written under `benchmarks/hidden_tests/<id>/invariants/`
with a header stating its origin and any TODOs, and a candidate without a Markdown source gets a section in
`docs/intentos-policy.md` of the repository (created on first use) so the policy can bind it by heading. Rejections
and skips are persisted in `review-decisions.json`; Finish re-indexes and stops the server. Related candidates (same
production paths or scope tag, `relatedCandidates`) can be folded into one approval as extra hidden tests.

## MCP server (`intentos mcp`)

`src/mcp.ts` builds an `McpServer` (SDK v2) with the MCP Apps extension. Model-visible tools: `explain` (evidence
pack), `policy` (approved rules with sources), `evidence` (the digest), `review_start` (loads the last `propose`/`mine` run into a review session;
`_meta.ui.resourceUri` points at `ui://intentos/review.html`). App-only tools (`_meta.ui.visibility: ["app"]`):
`review_session`, `review_state`, `review_decide`, `review_finish`; they also require the session's widget token, which
only `review_session` returns, so a model-initiated approval is refused even by a host that ignores visibility. The
widget resource is the same review page in `widget` mode: the apps browser bundle is inlined as a classic script that
leaves its exports on `globalThis.__mcpApps`, the page connects to the host over `PostMessageTransport` and routes
its three API calls to the app-only tools. When the client does not declare the UI extension (`getUiCapability`),
`review_start` starts the local HTTP review server and returns its token-protected URL. For hosts that declare
elicitation, `review_next` builds a form (decision enum defaulting to skip, editable statement, optional reason, fold-related toggle
listing the related candidates) and obtains the reviewer's answer through the host: on
2026-07-28-era clients by returning an `input_required` result that the client fulfils and retries
(`acceptedContent` on the retry), on earlier clients through the push-style `elicitInput` request. `review_close`
confirms finishing the same way. The session remembers how the host showed the review (`ui: widget | link`): when the
widget was rendered, `review_next` returns a deferral (not an error) instead of a form, so a host with both
capabilities (the Codex app declares the UI extension at call time and elicitation) shows each candidate once, in
the widget. Client capabilities, negotiated protocol version and tool calls are logged to `.intentos/mcp.log`.

Onboarding from the host: `status` reports whether the repository has a policy file (and how many approved rules), an
index, host-authored candidates and how many are undecided, plus the state of a running job and the next tool
to call. `onboard` validates the request (Git checkout, no existing policy unless `force`), then runs `intentos
onboard` as a child process of the server with `--json` and builds the evidence digest (their stderr progress
lines become the job log) and returns immediately with a job id, because hosts time out tool calls long before a
venv, a test run and an index finish; the model polls `status`. The server declares MCP `instructions` with the
working order (status → onboard → status… → review_start → review_next… → review_close; explain and policy before
planning) so the host needs no prompt engineering, and `review_start` answers a not-onboarded repository with the
same instruction. The stdio entry point widens `PATH` with the node binary's directory, Homebrew, `/usr/local/bin`
and `~/.local/bin` because GUI hosts start servers with a bare environment, and the printed Codex registration uses
the absolute node path for the same reason.

## Host-authored candidates (`skills/intentos-policy-mining`, `intentos propose`)

The review list is what a model selected and backed with a test. The skill (`SKILL.md` with the
`name`/`description` frontmatter Codex requires, plus `agents/openai.yaml` for the desktop app) tells the agent what a
business rule is, where to look in which order, how to state a rule with evidence and how to supply a test: an
existing test node, or a self-contained test module it writes (pytest, or vitest/jest importing production code
relative to the hidden directory). `installSkill` symlinks the folder into
`~/.agents/skills` (Codex follows symlinked skill folders); the `mining_guide` tool serves the same text to hosts
without skills, and the server instructions point at both.

`ingestProposals` (`src/propose.ts`) is the trust boundary. Shape errors reject one proposal, never the batch
(`ProposalSchema`). The Python `Ingestor` (`policy_evidence.py --ingest`) checks every reference against the
tracked files and the commit graph, refuses test paths in `applies_to_paths`, requires a test for every invariant,
lifts an existing test (a pytest test with its imports, constants, fixtures and class setup; a vitest/jest file
copied whole with its relative imports re-pointed to `../../src/…` and the chosen test marked `.only`) and builds the
policy block; a written test is only parsed there (and, for TypeScript, its relative imports must resolve to tracked
files). Back in TypeScript each test runs at HEAD in the repository's environment: Python in the venv with the
policy's `pythonpath`, TypeScript through the repository's vitest/jest with a wrapper config under
`<repo>/.intentos_hidden/` (removed afterwards); a written module from `<out>/proposed_tests/`, an existing test by
its node id or title; a failure rejects the candidate with the runner's tail. Accepted candidates are written as
`suggestions.json` with `authored_by: "codex"` and the agent's category and rationale, so
`review_start`, the widget, the elicitation forms and `acceptCandidate` work unchanged; `append` keeps an earlier
host-authored list and continues the ids, a plain call replaces it and clears stale decisions. The hidden-test header
says whether the test was lifted or written by the agent and validated at the base revision.

## The independent miner (`src/mine.ts`, `intentos mine`, MCP `mine`)

`mineWithModel` is the second author of host-shaped candidates: the same skill, run by IntentOS in a separate
read-only Codex thread with a model the user names, so the model that finds the rules is not the one driving the
session or later implementing under them. It builds one prompt from the skill text (frontmatter stripped, a preamble
that maps the MCP steps onto the thread: the rendered digest from `loadDigest` is inlined in place of `evidence`,
the structured answer replaces `propose`, there is no `review_start`) and runs it through `LiveCodexEngine.plan`; the engine now
takes `{model, reasoningEffort}` overrides and `plan` resumes a thread by id. The answer is structured output under
`MINE_SCHEMA`: every field present, null or an empty list where it does not apply, because strict schemas allow no
optional keys; `normalizeProposal` strips those to the shape `ProposalSchema` takes, and `ingestProposals` runs
unchanged with `author: {via: "side_thread", model, engine, thread_id}`. Rejections become `buildFixPrompt` for a
second round in the same thread, ingested with `append: true`, at most `rounds` times (default 2); what was never
resubmitted stays in `rejected`. Prompts and raw answers go to `<out>/mine/prompt-N.txt` and `round-N.json`, the
summary to `result.json`; `ReplayEngine` feeds saved answers back through the checks without Codex. In the MCP server
`mine` is a background job of the same kind as `onboard` (`Job.kind`), run in-process with the SDK (a test passes a
fake engine through `McpOptions.mineEngine`); `status` reports the phase (`mining`, `checking`), the model and the
counts, and `review_start`, `publicState` and the widget header carry `author`. The model is required (`model`, else
`INTENTOS_MINING_MODEL`): the server cannot know which model the host runs, so it never defaults to one.

## TypeScript repositories

The same pipeline runs on a TypeScript repository (`policy.language: typescript`). The probe reads `package.json`
(name, scripts, vitest or jest, package manager), `tsconfig.json` and the source/test directories, and the draft
policy's commands use `{node}` and `{node_modules}` placeholders with `env` (`CI=1`). `src/knowledge/ts_extract.ts`
(TypeScript compiler API) adds modules, functions, classes, imports and `it`/`test` titles to the same world model
the Python indexer fills. The verifier copies hidden tests as `.test.ts` files beside the snapshot and runs them
through the repository's own vitest/jest with a wrapper config (`writeVitestWrapperConfig`) that includes only the
hidden directory and allows `.only`; the snapshot links the repository's `node_modules`, and `isToolingPath` keeps
`node_modules` and `.intentos_hidden` out of dirtiness, scope and diff checks. `src/verification/ts_rules.ts`
evaluates the same architecture-rule kinds (`forbidden_import` by specifier or resolved repository path,
`forbidden_call` including `new`, `required_import`, `forbidden_names`) over the files the rules target; the Python
and TypeScript checkers both run when a change touches both languages. Acceptance tests (`intentos acceptance`) are
written as vitest modules and judged at base the same way as pytest modules. `fixtures/ts_ledger` (a small ledger
with `src/domain`, `src/db`, `src/api`) and `policies/ts_ledger.yaml` are the TypeScript counterpart of the Python
fixture; `tests/integration/typescript.test.ts` runs the offline pipeline on it, good patch to `REVIEW_READY` and bad
patch to `FAILED` on an architecture rule and a failing hidden task test. Docker-mode verification stays Python-only.

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

