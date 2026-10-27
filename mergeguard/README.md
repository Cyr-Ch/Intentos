# mergeguard

**Main is the meeting point.** A working, local coordination harness for parallel Python coding agents: specific sync notes, proportional human review, and incident-driven review floors.

Built under **Cyr-Ch**. Python 3.11+, Git, pytest, and PyYAML. No hosted service, model API, or GitHub account is needed for the deterministic demo.

```text
Laptop A ── PR ──┐                         ┌─ exact API-change notes
                 ├── main ◀── sync gate ──┤
Laptop B ── PR ──┘     │                   └─ current-head approval gate
                      │ failing tests
                  guardian → undo PR → incident ledger → review floors
```

## Start here

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[test]'
python -m pytest -q

# Each command creates a fresh world OUTSIDE this tool repo. act1..act5 are the demo acts;
# prevent/review/recover/learn/evaluate are the same acts by name.
./demo/run_demo.sh act1 ../mergeguard-prevent     # rename merges mid-task, B gets a specific note
./demo/run_demo.sh act2 ../mergeguard-review      # tier 0 / 1 / 2 routing with reasons and evidence
./demo/run_demo.sh act3 ../mergeguard-recover     # S4 meaning change: guardian finds culprit + partner, opens undo
./demo/run_demo.sh act4 ../mergeguard-learn       # two incidents trip the breaker; next change needs two reviewers
./demo/run_demo.sh act5                           # scripted evaluation -> eval/results.md
./demo/run_demo.sh live ../mergeguard-live        # two-laptop demo with a real agent (prints what to type)
```

`prevent` shows a rename, a blocked PR, a repair, human approval, and passing main. `review` compares six actual PRs across tiers 0/1/2 and merges the proven low-risk ones without reviewers. `recover` shows the semantic blind spot, first-parent bisect, a two-PR clash, and a validated undo. `learn` runs two distinct incidents and raises the invoices review floor to tier 2. The reviewers `priya` and `sam` in scripted demos are explicitly **simulated humans**.

Each world contains `origin.git`, `engineer_a`, `engineer_b`, a shared append-only ledger, a PR registry, and generated `report.md` / `report.html`. Setup refuses to overwrite an existing world. Open the HTML file directly; it has no external dependencies. Completed [learning](docs/report.html) and [review routing](docs/review-report.html) reports are included.

## What works

| Component | Behavior |
| --- | --- |
| Sync gate | AST indexes functions/classes/methods, identifies removed/renamed/moved symbols and incompatible call signatures, including positional reordering. Checks committed, staged, unstaged, and untracked branch changes. |
| Hooks (Codex and Claude Code) | One hook definition serves both agents. After-command evidence and deduplicated specific context; 60-second fetch throttle (`MERGEGUARD_FETCH_INTERVAL`); stop continuation; a SessionStart memory note built from recent ledger incidents. Hook errors log and allow the session. CLI/PR errors fail closed. |
| Review router | Trusted-author + docs/AST/docstring proof for tier 0, and with `zero_review_additive` an additive-only code proof (new definitions, nothing existing changed); default tier 1; protected paths, deleted tests, removed assertions, or a proven public API break (`api_break_tier`, default 2) tier 2. How-made evidence can only raise risk. |
| PR gate | Distinct human approvals tied to the exact head; authors/bots/agents excluded; optional prompter rule; the branch's own test suite must be green (cached per head). Fetches and recomputes everything at merge. |
| Guardian | Three reruns at bad and good; real `git bisect --first-parent`; culprit-alone test; binary partner search; validated revert branch and simulated PR. |
| Breaker | Rebuilds floors from ledger; deduplicates culprit + revert as one incident; automatically tightens after a cluster. Human approval is required to loosen. |
| Evidence | Markdown/HTML PR report, raw evaluation logs, generated result tables, unit/integration tests, probe payloads, and build notes. |

Policy is read from **main**, never the proposed branch. No agent-to-agent messaging, PR-description trust, or model-based lowering exists.

## Manual two-laptop workflow

```bash
./demo/setup_demo.sh ../my-world
python -m mergeguard.demo prepare --world ../my-world --scenario S1
cd ../my-world/engineer_b

python -m mergeguard sync-check --fetch --json    # exit 1: concrete rename note
python -m mergeguard pr open --branch s1/task-b --title 'Account summary'
python -m mergeguard pr approve 2 --user priya
python -m mergeguard pr merge 2                  # still blocked by the sync issue
```

Apply the suggested change after merging `origin/main` into the feature branch, rerun tests, commit, and run `pr open` again to update the existing PR. Every new head clears earlier approvals. A merge uses a temporary worktree and an atomic compare-and-swap update of bare main; it preserves both laptops' checkouts.

Inspect evidence with `pr show 2 --json`, refresh it with `pr check 2 --json`, or generate the report with `report --html report.html`. Report decisions are saved snapshots; the merge gate always recomputes them.

## Inherited from Codex vs. built here

| Inherited (the agent runtime) | Built (this repository) |
| --- | --- |
| The model and its coding loop, file editing and shell execution, sandboxing, non-interactive runs (`codex exec`, `claude -p`), parallel sessions and worktrees, and the hook contract itself (PostToolUse, Stop, SessionStart with JSON on stdin/stdout). | The sync gate (symbol-level change and use detection, exact notes, hooks plus PR check), the how-made log, the review router and approvals gate, the guardian (flaky check, first-parent bisect, alone check, partner search, validated undo), the append-only ledger, the breaker, the offline two-laptop world, and the scripted and live evaluation harnesses. |

Nothing in the decision path calls a model. The agent is a black box that runs commands; mergeguard only observes those commands and main.

## Live two-laptop demo (Claude Code or Codex)

```bash
./demo/run_demo.sh live ../mergeguard-live --agent claude   # or --agent codex, or both
```

This prepares laptop A's change as an open PR and leaves laptop B on a clean feature branch, then prints exactly what to type: start the agent in `engineer_b`, give it the task, and from a second terminal run `python -m mergeguard.demo merge-a --world ../mergeguard-live` while the agent is still working. The agent's next shell command fetches main, receives the specific note, and the Stop hook blocks the session if the branch is still stale. `MERGEGUARD_DISABLE=1` in the agent's environment reproduces the broken baseline.

- **Claude Code** reads the hooks from the clone's `.claude/settings.json`; nothing else is needed.
- **Codex** requires each project hook definition to be reviewed and trusted by hash. `python -m mergeguard.demo trust --world W` prints a `-c hooks.state=...` override that trusts exactly the generated definitions for one invocation; it is the same record the interactive `/hooks` review writes, and it never touches `~/.codex`. The generated `.codex/config.toml` uses `[features] hooks = true`.

Hook commands use the absolute interpreter path of the environment that created the world, so **regenerate the world when moving the tool environment**. Neither agent includes a shell exit status in its PostToolUse payload (verified on Codex 0.154.0 and Claude Code 2.1.310); the log keeps `exit_code: null`, and `python -m mergeguard run -- python -m pytest -q` writes an exact receipt. [Hook compatibility and probe evidence](docs/hooks.md) lists what was verified.

## Commands

```bash
python -m mergeguard changes BASE HEAD --json
python -m mergeguard uses --base BASE --json
python -m mergeguard sync-check --fetch --json
python -m mergeguard route --base BASE --head HEAD --author engineer_b --json
python -m mergeguard guardian --good GOOD --bad BAD --json
python -m mergeguard breaker status
python -m mergeguard breaker suggest
python -m mergeguard report --html report.html
```

Use `--repo PATH` before the subcommand to operate on another checkout. `sync-check` and `pr check` return 0 for pass and 1 for blocked; CLI errors return 2. `guardian` returns 2 if diagnosis or undo is inconclusive. `run` preserves the command's exit code. Library entry points mirror the modules, for example `sync_check.check(repo)` and `guardian.investigate(repo, good=..., bad=...)`.

## Evaluate

```bash
python eval/live_compare.py --agent claude --model haiku --repeats 3      # live agents, both arms, S1-S5
python eval/live_compare.py --agent codex  --model gpt-6-astra --repeats 3
python eval/compare.py --repeats 3                                       # scripted mechanics
python eval/policy_eval.py                                               # router on labelled diffs, guardian tests, breaker timeline
python eval/guardian_eval.py --repeats 5                                 # guardian on 20-50-commit histories with an injected flaky test
python eval/render.py                                                    # regenerate results.md from raw logs
```

**Live comparison.** Each run builds a fresh bare origin and two clones, opens change A as a PR, starts a real agent on task B in `engineer_b`, merges A after the agent's first tool call, commits whatever the agent left, tests the branch alone, opens the PR, and integrates it: the harness arm through the real gate and guardian, the baseline arm (`MERGEGUARD_DISABLE=1`) through raw Git. It records notes delivered, false notes on S5, stop-hook blocks, PR-check blocks, clean integration, breaks, recoveries, tool calls, tokens, and wall time. Raw agent event streams, stderr, how-made logs, branch patches, and result JSON live under `eval/runs/<timestamp>-live-<agent>-<model>/`.

**Scripted comparison.** Deterministic repairs after a note, used to check the mechanics reproducibly without a model.

[eval/results.md](eval/results.md) is generated from all three; tables are never edited by hand and it carries a "What didn't work" section.

## Boundaries

- Python, explicit imports, and ordinary callable signatures only. Dynamic imports, reflection, wildcard imports, runtime re-exports, and methods on objects of unknown type are not resolved. Argument splats are treated conservatively.
- Meaning changes with unchanged signatures are invisible to the sync gate. The guardian needs tests that expose the break; it runs those tests with normal local process privileges.
- A sync check compares changes since the Git merge-base. Once a branch incorporates main, API deltas may disappear from that comparison; the branch's tests and normal CI are still essential.
- The offline PR registry simulates identity and approval. It does not authenticate humans or replace GitHub branch protection. `.github/workflows/pr.yml` runs the same sync check and router as a PR check and comments the tier, but it has not been exercised against a hosted repository. There is no hosted approvals gate, merge queue, MCP guardian, or model escalation in this prototype.
- Partner bisection assumes monotonic failure across the interval. Patch conflicts or test infrastructure errors produce an unresolved result rather than a guessed culprit.
- A local disk is the shared authority in the demo. It is not a tamper-proof audit store. File locks serialize simulator writes; a process crash between Git and JSON/ledger writes can require manual reconciliation.
- Cooldown makes a loosening suggestion eligible; it does not silently lower a floor. A human-reviewed `breaker.resets` timestamp in main's policy can reset acknowledged history. This resolves the brief's cooldown ambiguity in favor of its strict human-only loosening principle.

[Design and trade-offs](docs/design.md) · [45-minute demo runbook](docs/demo-runbook.md) · [Build log](BUILD_LOG.md)
