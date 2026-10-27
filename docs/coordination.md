# Coordination between runs: mergeguard inside IntentOS

IntentOS verifies one run against one base revision: does this change belong, and does it hold the approved
invariants? It has no answer to the second question a team of parallel agents raises: is this change still safe to
merge now that other runs have landed on main since it started? That is what [mergeguard](https://github.com/Cyr-Ch/mergeguard)
does, a deterministic coordination harness (no model anywhere in it) for coding agents that share a repository. This
document describes how the two are combined.

## What each side contributes

| Question | Answered by | How |
|---|---|---|
| Does the change belong, and hold the business rules? | IntentOS | contract, hidden acceptance and invariant tests, architecture rules, scope |
| Did main change something this run uses, while it worked? | mergeguard sync gate | AST symbol index of main vs the worktree's imports and calls, delivered by hooks mid-session; the Stop hook refuses a stale finish |
| How many humans must look? | mergeguard router, with an IntentOS floor | proofs (documentation, AST-equivalent, additive-only), rules (API break, edited tests, protected paths), and tier ≥ 1 whenever IntentOS ended in `HUMAN_REVIEW` |
| Is the combination of this branch and the main of right now correct? | IntentOS verifier at the gate, and mergeguard's merged-tree test run | the branch merged onto current main is verified with the hidden tests before the main ref moves |
| Main broke anyway: who, with whom, and how do we get back? | mergeguard guardian and breaker | reruns per test to rule out flakiness, first-parent bisect over the merges, culprit-alone check, partner search, validated undo PR, review floors per folder |

The verification IntentOS already does is not duplicated: mergeguard's symbol check becomes one more verification
track, and mergeguard's gate calls back into IntentOS for the merged-result verification.

## How it runs

mergeguard is a Python package installed into the IntentOS venv (`.intentos/venv/bin/python -m pip install -e <path to
mergeguard>`). IntentOS drives it in **local mode**: the indexed repository is origin, its checked-out branch is main,
every run's worktree is a branch in waiting, and all mergeguard state lives under `INTENTOS_HOME/coordination/<repo>/`:
the PR registry, the incident ledger and the trusted policy, never inside the repository the agents edit. The trusted
policy is rendered from the IntentOS policy: the same protected paths need two humans at the merge, `intentos` is the
trusted author (its verifier already ran), and additive code may merge unseen.

`intentos coordination` says whether it is on; `INTENTOS_COORDINATION=0` turns it off.

### During a run

- **IMPLEMENTING / REPAIRING (live Codex only).** The Codex process of the turn gets a private `CODEX_HOME` under the
  run directory (`codex_home/`): the mergeguard hooks as `hooks.json`, hooks enabled, and the user's `auth.json` by
  symlink, never copied. Codex trusts the hooks through a `--config hooks.state` override that pins each one by the
  same SHA-256 the interactive `/hooks` review would record, scoped to that process; `~/.codex` is never touched.
  (Project `.codex/` files are not used: Codex reads them only below a `.git` *directory*, and a worktree's `.git` is a
  file, so hooks written into a worktree are never seen; a plain clone sees them, a worktree does not, wherever it
  sits.) After each shell command the PostToolUse hook compares the worktree's uses against main (no fetch, refs are
  shared) and delivers a note naming the symbol, the commit, the file and line, and the first step; the Stop hook
  refuses to let the thread finish while the tree is stale; SessionStart carries the ledger memory (what broke in these
  folders lately).
- **The implementer prompt** tells the agent the one way its HEAD may move: `git stash && git merge --ff-only <main> &&
  git stash pop`, never a commit. A worktree whose HEAD advanced only along main's own history is not an integrity
  failure: the run's base advances with it (`base.advanced` event, `base_commit.txt` rewritten) and verification diffs
  against the new base.
- **VERIFYING.** The same sync check is the `coordination` track: each symbol the tree uses that main renamed, moved,
  removed or re-signed since the run's base is a blocking `SYNC-STALE` finding carrying the note, so the repair loop
  tells the agent exactly what to do even without hooks (offline runs included). `verification.json` records
  `coordination: { main_branch, main, base, stale, issues }`.

### `intentos merge <run-id>`

For a `REVIEW_READY` or `HUMAN_REVIEW` run whose verification is current:

1. The worktree's uncommitted work becomes one commit on `intentos/<run-id>` (author `intentos`).
2. A mergeguard PR is opened or refreshed. Its review tier comes from the diff under the trusted policy, with a floor of
   1 when IntentOS ended in `HUMAN_REVIEW`; the branch's own test suite is run as its CI; approvals (`--approve <name>`,
   repeatable) are bound to the head and dismissed when it changes; the sync check against current main must be clean.
3. **Merged-result verification.** The branch is merged onto the main of right now in a throwaway worktree and
   verified with the run's contract, hidden acceptance tests and invariants (`merged_verification/attempt-N/` in the
   run directory). A blocking finding stops the merge. This is the check a branch-only CI and a symbol-level sync check
   cannot do: a change of meaning behind an unchanged name is caught here instead of on main.
4. mergeguard merges: it runs the project suite on its own merged tree as well (`MERGEGUARD_MERGE_CHECK`, rendered from
   the policy's `pytest_project` command), then fast-forwards main in the checkout, refusing a dirty tree, and records
   the merge in the ledger. IntentOS re-indexes main.

`intentos merge <pr-number> --repo <path>` merges a PR that is not a run, such as an undo PR. `intentos prs <repo>` lists
them. `merge.json`, `result_json.merge` and `merge.*` events keep the outcome with the run.

### `intentos guard <repo>`

When main is red: the guardian reruns the failing tests three times and drops the flaky ones, bisects first-parent from
the parent of the first ledger merge (or `--good`) to main over the consistently failing tests, checks whether the
culprit merge fails on its own branch, searches the merges since its base for the partner it clashed with, and opens an
undo PR whose revert must pass the whole suite first. The breaker then reports review floors: two incidents in a
folder within a week raise it to two humans until a person lowers it. The undo PR merges through `intentos merge
<n> --repo <path>` with the same gate and merged-tree checks.

## What the tests show

`tests/integration/coordination.test.ts` (offline runs, real verifier, real mergeguard, startup_billing fixture):

- every run carries a `coordination` track; the implementer prompt carries the sync instruction
- a verified run merges: tier 1 with the IntentOS floor, one head-bound approval, merged-result verification
  `needs_review` (the run's own review finding) with zero blocking findings, mergeguard's merged-tree suite green,
  main fast-forwarded with a clean checkout, ledger `merged`, index refreshed, state kept outside the repository
- a change of meaning with no symbol change (quotes keep only registered discount codes) lands on main; a run that
  adds a promotion, verified green at the old base, passes the gate (CI green, sync clean, approval present: GitHub
  would merge it) and is refused by the merged-result verification (hidden acceptance test fails on the combination),
  and independently by mergeguard's merged-tree run of the project suite
- with both bypassed (`INTENTOS_COORDINATION_MERGE_CHECK=0`, evaluation only) the merge lands and main is red; the
  guardian returns `clash` with the culprit PR and the partner PR, opens a validated undo PR (tier 2: it deletes an
  existing test file), and the undo merges through the gate with two approvals; main is green, the ledger records
  `reverted`
- a public class rename is tier 2 (API break) whatever IntentOS asked; a run that imports the old name is told
  ``` `app.services.audit.AuditLog` was renamed to `app.services.audit.EventLog` in commit … Your code uses it at
  tests/test_audit_log_events.py:5. First bring main into your branch (git merge main) … ```, its re-verification has
  one blocking `SYNC-STALE`, its PR is blocked at the gate, and it merges after main is brought in and the name updated
- the live sync path: a worktree fast-forwarded to main advances the run's base (`base.advanced`), re-verification has
  no `WORKTREE-HEAD` finding and sees only the run's own file, and the run merges

mergeguard's own suite covers local mode (`tests/test_local_mode.py`): trusted policy from the file, fast-forward of the
checkout, a stale worktree told and blocked without any remote, refusal on a dirty checkout, the tier floor and the
merged-result check.

## Live status (2026-10-27, Codex CLI 0.154.0, model gpt-6-astra)

- First attempt wrote the hooks into the worktree: the run reached `HUMAN_REVIEW` with the `coordination` track green,
  but no hook fired. With `RUST_LOG=codex_hooks=debug`, a plain clone of the same fixture fires SessionStart and
  PostToolUse while a worktree fires nothing, under a trusted path or not, with or without a repository above it:
  Codex stops project discovery at the worktree's `.git` file.
- With the private `CODEX_HOME`: a direct `codex exec` in a worktree fired SessionStart, PostToolUse and Stop (two
  each) and the hook wrote `howmade.jsonl` under the worktree's git dir. Then a full `intentos run` ("Add a
  Money.half() method … with a unit test"): `coordination.hooks_installed` names `runs/<id>/codex_home`, three hook
  records were logged during the turn, verification `needs_review` (no acceptance tests bound) with `sync_check`
  passed, and `intentos merge <id> --approve sam --by priya` opened PR #1 at tier 1 (reasons: IntentOS asked for a
  human; existing tests modified; how-made evidence from the hooks), verified the merged result, and fast-forwarded
  main to the merge commit. The user's `~/.codex` was not modified.

## Limits

- Hooks run only for the live Codex engine; the simulated engine has no agent to hook. The `coordination` verification
  track and the gate apply to both.
- The private `CODEX_HOME` carries none of the user's global Codex configuration (MCP servers, global hooks, profiles);
  the model and reasoning effort still come from `INTENTOS_CODEX_MODEL` / `INTENTOS_CODEX_REASONING`.
- mergeguard's own CI and bisect run the suite with the IntentOS venv interpreter (`python -m pytest` with its probe
  plugin, 60 s per run); a repository whose tests need its onboarded venv is verified by IntentOS with that venv, but
  mergeguard's branch CI would need mergeguard installed there too.
- The sync check sees imports, attribute chains on imported names and calls on them; a method called on an instance
  (`Money.of(…).percent_off(…)`) is not resolved, which is why a change of meaning behind an unchanged name is the
  merged-result verification's job, by design.
- A PR waiting for review is rechecked against main at merge time, but nobody is told automatically; the author or a
  new run must bring main in. A production version would re-run the check on every push to main.
- `intentos merge` moves the checkout's main; it refuses when the checkout has uncommitted changes.
