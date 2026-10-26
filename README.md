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
proposed ADRs. You delete what is wrong, edit the rest and approve by pasting. Afterwards
`npm run intentos -- suggest ~/repos/demandlib --record` learns from what you kept, so the next run is quieter.

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

## Environment variables

| Variable | Purpose |
|---|---|
| `INTENTOS_HOME` | runtime data dir (default `.intentos/`) |
| `INTENTOS_PYTHON` | interpreter for indexer/verifier (default: `.intentos/venv/bin/python`, else `python3`) |
| `INTENTOS_CODEX_MODEL` | Codex model (default: the CLI's configured default; may be unsupported for ChatGPT accounts) |
| `INTENTOS_CODEX_REASONING` | reasoning effort passed to Codex |
| `INTENTOS_CODEX_PATH` | override the Codex binary used by the SDK |
| `INTENTOS_CODEX_TIMEOUT_MS` | per-turn timeout (default 20 min) |
| `INTENTOS_RUN_TIMEOUT_MS` | whole-run wall budget (default 60 min) |
| `INTENTOS_VERIFIER` | `host` (default) or `docker`: run every executing verification command in the verifier container; fails closed (`VERIFIER-UNAVAILABLE`) when Docker or the image is missing |
| `INTENTOS_VERIFIER_IMAGE` | verifier image (default `intentos-verifier:0.1`; build with `npm run verifier:image`) |
| `INTENTOS_DOCKER_BIN` | docker client used by the verifier (default `docker`) |
| `INTENTOS_VERIFIER_CPUS`, `INTENTOS_VERIFIER_MEMORY` | container limits (default `1`, `1g`) |
