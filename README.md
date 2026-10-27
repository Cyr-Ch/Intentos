# IntentOS

*The code works. But does it belong?*

IntentOS is an engineering-intent intelligence and verification layer for Codex coding agents. It indexes a
repository into a versioned Engineering World Model (symbols, imports, tests, docs, trusted policy), turns a
task into an evidence-grounded **Engineering Change Contract**, runs Codex inside an isolated Git worktree
under that contract, and then verifies the result **independently** (hidden acceptance tests, business
invariant tests, deterministic architecture rules, scope checks) before producing a semantic review report.

Status: working M1–M5 prototype on a Python fixture. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)
for what is functional vs. limited, and [docs/](docs/) for architecture, security and evaluation notes.

## Requirements

- Node.js ≥ 22.6 (uses built-in `node:sqlite` and native TypeScript type stripping; developed on Node 26)
- Python ≥ 3.11 with `venv` (pytest is installed into `.intentos/venv`)
- Git ≥ 2.30
- For live runs: the Codex CLI/SDK credentials (`codex login` ChatGPT session, or `CODEX_API_KEY`), and a
  model your account can use (set `INTENTOS_CODEX_MODEL`, e.g. `gpt-5.6-terra`).

## Quick start

```bash
npm install
npm run setup:python          # creates .intentos/venv with pytest
npm run fixture:build         # materializes the demo repo with Git history at .intentos/fixtures/startup_billing

FIX=.intentos/fixtures/startup_billing
npm run intentos -- index $FIX
npm run intentos -- explain $FIX "Add a 15% promotional discount for eligible enterprise subscriptions"

# Without Codex credentials: replay a known-good / known-bad patch through the full pipeline (simulated orchestration)
npm run intentos -- run $FIX "Add a 15% promotional discount for eligible enterprise subscriptions" --offline --offline-patch benchmarks/offline_patches/task-a.good.patch
npm run intentos -- run $FIX "Add a 15% promotional discount for eligible enterprise subscriptions" --offline --offline-patch benchmarks/offline_patches/task-a.bad.patch --offline-claim-success

# With Codex:
INTENTOS_CODEX_MODEL=gpt-5.6-terra npm run intentos -- plan $FIX "Add a 15% promotional discount for eligible enterprise subscriptions"
INTENTOS_CODEX_MODEL=gpt-5.6-terra npm run intentos -- run  $FIX "Add a 15% promotional discount for eligible enterprise subscriptions"

npm run intentos -- verify <run-id>     # re-run independent checks on the run's worktree
npm run intentos -- report <run-id>     # report.md / report.json
npm run intentos -- resume <run-id>     # integrity-checked recovery; re-enters an interrupted Codex turn
npm run intentos -- runs                # list runs
```

`bash scripts/demo.sh` runs the offline demonstration end to end. Add `--json` after `intentos` for
machine-readable output; every command exits non-zero on critical failure.

## Commands and what they write

| Command | Writes |
|---|---|
| `onboard <repo>` | `.intentos/venvs/<repo-id>/` (pytest + the repository's declared dependencies, never the package itself), a **draft** `policies/<policy-id>.yaml` (commands, allowed/protected paths, scope tags; invariants/rules empty on purpose), `.intentos/onboard/<repo-id>/smoke.log` + JUnit from one run of the project suite at the base revision, then the index. `--no-install`, `--no-test`, `--no-index`, `--force`, `--out <file>`, `--policy-id <id>`, `--python <interpreter>` |
| `suggest <repo>` | `.intentos/onboard/<repo-id>/{suggestions.json, policy-suggestions.md, policy-suggestions.yaml}`: policy **candidates** mined from commits that record fixes, rule-like test names, must/never sentences in documents, ADR files, one-directional layer imports, frozen directories and changelog deprecations, each with its evidence, a business-relevance score (the repository's own vocabulary, rule shape, corroboration across sources, import-graph centrality, test age) and a paste-ready block (`approved_by: TODO`); candidates expressing one rule are clustered. `--min-score` cuts the tail; `--classify` lets Codex sort the top candidates (keep/drop, category, one-sentence rule rewrite, cluster) in a read-only thread, with every verdict validated against the evidence and dropped candidates kept in a rescue section; `--record` compares the last run with the policy file and writes `feedback.json`, which the next run uses to raise accepted terms and lower rejected ones. `--write-adrs` adds `docs/decisions/ADR-nnnn-*.md` drafts (`Status: Proposed`); `--with-codex` lets Codex write the ADR prose from the evidence (an ADR citing evidence it was not given is dropped). `onboard --suggest` runs it after indexing. Nothing it writes is approved |
| `review <repo>` | opens a local one-page UI (127.0.0.1, token in the URL) that walks the candidates of the last `suggest` run one by one; **Approve** appends the block to `policies/<id>.yaml` with the next `INV-`/`ARCH-`/`DEC-` id and your name (file comments preserved), writes the hidden-test draft to `benchmarks/hidden_tests/<id>/invariants/`, and adds a section to `docs/intentos-policy.md` in the repository when the candidate has no document source; related candidates (same cluster) can be folded into one approval as extra hidden tests of a single invariant; **Reject** records the reason; **Finish** writes `feedback.json` and re-indexes. `--by`, `--no-open`, `--include-filtered`, `--policy-file` |
| `mcp` | IntentOS as an MCP server on stdio: `status` and `onboard` let the agent bring a repository under IntentOS itself (the CLI runs in a child process; the agent polls `status`); `explain` and `policy` give a coding agent the evidence pack and the approved rules from inside its session; `review_start` opens the policy review as an MCP Apps widget in hosts that render it (Claude, VS Code, …), `review_next` / `review_close` run it through the host's own elicitation prompts (Codex), and the token-protected local URL is the fallback. The tools that change the policy are app-only and require a widget token, so the model cannot approve. `--print-codex-config` prints the `codex mcp add` line; `.intentos/mcp.log` records the client's declared capabilities |
| `propose <repo> --file <json>` | validates host-authored candidates (the `intentos-policy-mining` skill's output): references checked against the repository, existing tests lifted and run, written tests run in the repository's venv; writes the review files with `authored_by: codex` (`--append` keeps an earlier list) |
| `mine <repo> --model <slug>` | the independent miner: runs the `intentos-policy-mining` skill in a separate read-only Codex thread with the named model (`INTENTOS_MINING_MODEL` as the default), takes the answer through the same checks as `propose`, sends the rejections back to that thread once, and writes the review files with the author recorded (`author: {via: side_thread, model, thread_id}`); `--append` keeps the current list; `--reasoning`, `--rounds`; `--replay <dir>` re-checks saved answers (`<out>/mine/round-N.json`) without Codex |
| `skill install` / `skill show` | symlinks `skills/intentos-policy-mining` into `~/.agents/skills` (`--dir` for another skills directory) / prints the skill text |
| `index <repo>` (`--full` to skip the incremental path) | `.intentos/intentos.db`: `repositories`, `nodes`, `edges`, `evidence`, `decisions` rows bound to the HEAD SHA; `.intentos/index-cache/<repo-id>/<sha>.json` (raw extraction + blob ids, reused by the next incremental index) |
| `explain <repo> "<task>"` | nothing (prints the evidence pack; `--out file` saves JSON) |
| `plan <repo> "<task>"` | a run dir with `task.json`, `evidence.json`, `planner_prompt.txt`, `planner_output.json`, `contract.json`, `contract_validation.json`; run row in state `CONTRACT_VALIDATED` / `CLARIFICATION_REQUIRED` / `ABSTAINED` |
| `run <repo> "<task>"` | the above plus a worktree in `.intentos/worktrees/<run-id>`, `implementation_prompt.txt`, `codex_events.jsonl`, `implementer_result.json`, `diff.patch`, `verification/attempt-N/*` (snapshot, logs, JUnit), `verification.json`, `metrics.json`, `report.md`, `report.json` |
| `verify <run-id>` | a new `verification/attempt-N/` and refreshed `verification.json` + report |
| `report <run-id>` | `report.md`, `report.json` |
| `resume <run-id>` | integrity checks (`run_events`), then continues from the persisted state; an interrupted IMPLEMENTING/REPAIRING turn is re-entered in its Codex thread (`continue_prompt.N.txt`, `resume.reentered` event, at most 2 per run) before verification |
| `approve <run-id> --by <who>` | `APPROVED` transition with approver recorded (use `run --require-approval`) |
| `decision propose/approve/supersede/list`, `feedback <run-id> "<text>"` | `decisions` rows; feedback is always *proposed* until approved |

Runtime data lives in `.intentos/` (gitignored). Trusted configuration lives in `policies/*.yaml` and
`benchmarks/hidden_tests/` inside this checkout — never inside the target repository. What a policy can say, and
how it is used at each stage, is in [docs/policies.md](docs/policies.md).

## Onboarding a repository

```bash
git clone https://github.com/oemof/demandlib ~/repos/demandlib
npm run intentos -- onboard ~/repos/demandlib
#   probes the layout (src/ vs flat, test dirs, pytest config, declared dependencies)
#   creates .intentos/venvs/<repo-id> with pytest + dependencies (the package itself is never installed:
#   verification runs from a snapshot copy, so tests import the code through pythonpath)
#   writes policies/demandlib.yaml as a DRAFT and runs the suite once at the base revision
#   indexes the repository
npm run intentos -- explain ~/repos/demandlib "<task>"
```

The draft gets a run to `HUMAN_REVIEW`. `REVIEW_READY` needs the parts only a person can write: invariants with
Markdown sources and hidden tests, and architecture rules (see docs/policies.md). Verifier commands use the
repository's venv automatically (`INTENTOS_PYTHON` still overrides it).

To avoid writing those from scratch, `npm run intentos -- suggest ~/repos/demandlib --classify --write-adrs` mines
the repository for candidates (fix commits, rule-like tests, must/never sentences, layer imports), ranks them by
business relevance, lets Codex sort and reword the top ones, and writes a review document, paste-ready YAML and
proposed ADRs. Then `npm run intentos -- review ~/repos/demandlib` opens the review UI in your browser: approve, edit
or reject each candidate with one key, and every approval lands in the policy, the hidden tests and the repository's
policy notes by itself. Finishing records the feedback the next `suggest` run ranks with.

## Layout

```
src/cli.ts, src/cli_run.ts, src/cli_decisions.ts   CLI
src/knowledge/     storage (SQLite migrations), indexer (graph + policy binding), retrieval, conflicts, decisions, policy
src/contracts/     Zod contract schema, deterministic compiler, prompts
src/codex/         adapter (the only module importing @openai/codex-sdk), offline simulated engine
src/orchestrator/  workflow state machine, run store/artifacts, runner (pipeline), limits, recovery, task binding
src/verification/  runner (snapshot + trusted commands), policy checks (scope/architecture), counterexamples, JUnit parser
src/reports/       report.md / report.json generation, explain rendering
python/            index_repo.py (AST + git), architecture_rules.py, build_fixture.py, tests/
fixtures/          startup_billing source tree + history steps used to build the demo Git repo
policies/          trusted policy for the fixture (commands allowlist, invariants, architecture rules, decisions, probes)
benchmarks/        tasks.json, hidden tests (protected), offline patches, evaluate.ts
tests/             vitest unit + integration tests
docs/              architecture, security, evaluation
```

## Tests

```bash
npm test                 # vitest: unit + integration (builds the fixture in a temp INTENTOS_HOME per file)
npm run test:python      # pytest for the indexer and architecture checker
npm run typecheck
npm run verifier:image   # optional: build the container used by INTENTOS_VERIFIER=docker (end-to-end container tests skip without it)
```

## Using IntentOS from inside Codex (or another MCP host)

```bash
$(npm run -s intentos -- mcp --print-codex-config)   # registers the server with the absolute node path (GUI hosts start servers with a bare PATH)
npm run -s intentos -- skill install                   # symlinks skills/intentos-policy-mining into ~/.agents/skills, where Codex looks
codex                                                  # in the target repository
> bring this repository under IntentOS and walk me through the policy candidates
```

The server tells the host how to use it (MCP `instructions`), so one sentence is enough. Codex then calls `status`
(where the repository stands and which tool to call next), `onboard` when it is not onboarded (venv and dependencies,
draft policy, one run of the suite, index, raw candidate mining; it runs in the background and Codex polls `status`
until it is done), mines the business rules itself with the skill (next section) and submits them with `propose`, or
hands the mining to a model other than its own with `mine` when you ask for an independent opinion or set
`INTENTOS_MINING_MODEL`, then `review_start`. `onboard` refuses to overwrite an existing policy unless `force=true`.

## Mining the rules: the skill, the proposal, the check

The candidates a reviewer sees are the ones **Codex** selected and backed with a test, not the deterministic miner's.
IntentOS ships the instructions for that as a Codex skill, `skills/intentos-policy-mining/SKILL.md`: what a business
rule is and is not, where to look and in which order (tests, fix commits, must/never sentences in documents, the
import graph and frozen directories), how to state a rule, how to cite evidence, when to pick an existing test and
when to write one, and the `propose` contract. `intentos skill install` symlinks it into `~/.agents/skills`; Codex
loads it when the task matches its description or when you type `$intentos-policy-mining`, and a host without skills
can read the same text through the `mining_guide` tool.

Codex starts from `mined` (the deterministic raw list, cached per revision, with ready-made hidden-test drafts for
rule-like tests), reads the repository, and calls `propose` with its candidates. IntentOS trusts nothing in that
submission: every evidence reference must exist (file and line, test node, commit sha), `applies_to_paths` must match
production code, an invariant must come with a test, and the test is run at the current revision in the repository's
venv, whether Codex picked an existing one (lifted with its imports, fixtures and class setup, as the miner does) or
wrote a new module. Failing tests, invented references and untested invariants are rejected with the reason, and Codex
resubmits the fixed ones with `append=true`. What passes becomes the review list (`suggestions.json`, marked
`authored_by: codex`); an approval writes the test file under `benchmarks/hidden_tests/<policy>/invariants/` and names
it in the invariant's `verified_by`, so every approved rule has a verifier. `intentos propose <repo> --file c.json`
is the same path from the command line.

**Another model, so one model's bias does not write the rules.** The model driving the Codex session is also the one
that will later implement changes under the rules it mined, and any one model has its own blind spots. `mine` (the MCP
tool, or `intentos mine <repo> --model gpt-6-astra`) runs the same skill in a separate read-only Codex thread with the
model you name: the thread reads the repository and answers with candidates as structured output, IntentOS checks and
tests them exactly as it does a `propose` submission, sends the rejections back to the same thread once, and writes the
review list marked with its author (`via: side_thread`, the model, the thread id). `status`, `review_start` and the
widget header say who mined the list. Set `INTENTOS_MINING_MODEL` and `status` steers Codex to `mine` by itself; say
"mine with gpt-6-astra" and Codex passes the model; `append=true` puts a second model's candidates next to the first's.
The model is never defaulted to the host's own: `mine` without a model is refused with the reason. Prompts and answers
are kept under `<out>/mine/`, and `--replay` re-checks them without a new Codex call.

The Codex app renders MCP Apps, so there the review appears inline as the widget (list, progress, approve / reject /
fold, finish) and `review_next` steps aside: a host that rendered the widget never also gets the form. The Codex CLI
(`codex exec`, the terminal UI) does not render widgets but supports **elicitation**, so there `review_next` shows a
form (approve / reject / skip, the editable rule statement, fold related tests) and `review_close` asks to confirm.
Either way the answers travel host → server; the model only sees the outcome and cannot decide for you, and the
instructions tell it not to invent candidates. Hosts with neither get the token-protected local link from
`review_start`. `.intentos/mcp.log` shows what the client declared and every tool call.

## Environment variables

| Variable | Purpose |
|---|---|
| `INTENTOS_HOME` | runtime data dir (default `.intentos/`) |
| `INTENTOS_PYTHON` | interpreter for indexer/verifier (default: `.intentos/venv/bin/python`, else `python3`) |
| `INTENTOS_CODEX_MODEL` | Codex model (default: the CLI's configured default; may be unsupported for ChatGPT accounts) |
| `INTENTOS_CODEX_REASONING` | reasoning effort passed to Codex |
| `INTENTOS_MINING_MODEL` | model for the independent miner (`mine`); with it set, `status` steers the host to `mine` instead of mining itself |
| `INTENTOS_CODEX_PATH` | override the Codex binary used by the SDK |
| `INTENTOS_CODEX_TIMEOUT_MS` | per-turn timeout (default 20 min) |
| `INTENTOS_RUN_TIMEOUT_MS` | whole-run wall budget (default 60 min) |
| `INTENTOS_VERIFIER` | `host` (default) or `docker`: run every executing verification command in the verifier container; fails closed (`VERIFIER-UNAVAILABLE`) when Docker or the image is missing |
| `INTENTOS_VERIFIER_IMAGE` | verifier image (default `intentos-verifier:0.1`; build with `npm run verifier:image`) |
| `INTENTOS_DOCKER_BIN` | docker client used by the verifier (default `docker`) |
| `INTENTOS_VERIFIER_CPUS`, `INTENTOS_VERIFIER_MEMORY` | container limits (default `1`, `1g`) |
