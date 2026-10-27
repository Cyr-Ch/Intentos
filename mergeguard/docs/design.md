# Design decisions

## One shared meeting point

Every agent pulls main. The simulator's bare Git origin represents GitHub; the shared PR registry and ledger represent platform state. Sessions never send one another hints. A note names the actual changed symbol, replacement if known, call site, change commit, and required action.

The tool is importable Python with an argparse CLI. The only runtime dependency is PyYAML; pytest is used to run and observe repository tests. There is no model in the decision path.

## Changes and uses

`changes.py` parses Python files at both immutable refs. It indexes top-level functions, classes, and direct class methods. Removed definitions match added definitions by normalized AST, ignoring the definition name, first within a module and then across modules. Ambiguous identical bodies stay `removed` with no invented replacement. Private symbols are included only when imported elsewhere.

Signatures preserve parameter names, kinds, required/default status, and variadic arguments. Optional trailing parameters and implementation-only changes do not create API-break events. Required additions, removals, renames, kind changes, and positional reordering do. Source history attributes a break to the first relevant commit rather than an unrelated later file edit.

`uses.py` scans only branch-changed files, including the working tree and untracked Python files. It resolves explicit aliases, dotted imports, and package-relative imports. A call records positional count, named keywords, and splats. Unknown object types stay unknown. This is a small static analysis, not a type checker or a complete Python resolver; unusual scoping, rebinding, generated code, and dynamic imports can evade it.

`sync_check.py` intersects the two sets. Missing names are reported at calls if available, otherwise at imports. Signature checks validate required bindings, unsupported keywords, excess positional values, duplicated bindings, and reordered positional parameters. Unknown splat values do not justify invented missing-argument warnings.

Every API use in a changed file is considered, not only added lines. This deliberately favors coverage when existing code in a changed file is affected. The default gate cannot discover a delta that is no longer between merge-base and main after rebase/merge; ordinary CI remains necessary.

## Routing and trust

Tier 0 requires a trusted author, permissive policy, no protected paths, and a proof for every changed file. Markdown and `docs/` are documentation by policy. Existing Python files need AST equality or equality after stripping docstrings. Docstring changes are explicitly labelled because `__doc__` is technically observable. With `zero_review_additive` on (the demo policy; off by default), a third proof exists: an additive-only change, where every existing statement survives unchanged and in order and the rest are new functions, classes, methods or imports, or a brand-new module. Such a change cannot break an existing caller, which is the failure parallel agents actually cause; it still needs a human if it touched a protected path, received a sync note, edited an existing test, or broke a public API, and the gate requires the branch's own CI to be green before any merge. A changed module-level constant or a changed body is not additive. The guardian remains the net for a no-human merge that interacts badly with a concurrent meaning change.

Any ordinary executable change requires one human. `always_two` paths and test-file/assertion removal require two. So does any public API break that the change detector can prove (a removed, renamed, moved, or signature-changed symbol), because that is exactly the kind of change that breaks parallel sessions; the policy knob `api_break_tier` sets that tier and defaults to 2. This rule was added after the labelled-diff evaluation showed a module move routing to one reviewer on path rules alone. Assertion replacements are conservatively treated as removal, even if they may strengthen a test. Existing test edits require at least one human. A missing or falsified how-made summary cannot lower any of these decisions.

The router reads policy from a trusted ref. The simulator explicitly uses current `origin/main` even when the diff starts at an older merge-base. It recomputes diff rules, sync issues, breaker floors, and approvals at merge time. Reviewers are distinct, case-normalized humans; authors and bots/agents do not count; prompters need an explicit policy opt-in. New pushed heads dismiss previous approvals.

The offline `--user` flag is a simulation, not authentication. A real integration would obtain human identity, head SHA, review state, and repository policy from GitHub APIs under branch protection. This prototype does not claim that integration is complete.

## Recovering with evidence

The guardian operates in disposable worktrees. It discovers exact failing pytest node IDs with a trusted observer plugin, reruns them three times at bad and three times at good, and attributes only the tests that fail every time at bad and never at good. Tests that flicker are reported as flaky and excluded per test, so a flaky test next to a real break cannot hide the break; if nothing consistent remains, nobody is blamed. Infrastructure errors during reruns stop the investigation without blame. Missing historical test files pass for bisect; missing test functions, collection errors, and timeouts are infrastructure errors, not blamed commits.

It runs real `git bisect start --first-parent BAD GOOD` and `git bisect run`. A failing second parent means an ordinary defect; a passing second parent means an interaction. The partner search reapplies the culprit branch delta over main's first-parent interval and bisects the first failure. It reports patch conflicts or non-reproduction without guessing. Monotonicity is an explicit simplifying assumption; it is not proven for arbitrary repositories.

`git revert -m 1` produces an undo branch on current main. The entire surviving suite must pass before the undo PR opens; a test already classified as flaky is ignored there, and any other failure is rerun twice and rejects the undo only if it repeats, because the realistic-history evaluation showed a single flaky test otherwise vetoing a correct undo. The guardian does not auto-merge the undo, invent a fix, or claim that removing a feature is a permanent fix. The undo follows the same human review gate. A repeat diagnosis reuses an existing undo and avoids duplicate culprit ledger entries.

## Learning without silent relaxation

The JSONL ledger is append-only, file-locked, and fsynced. Malformed records fail CLI/PR processing closed. `MERGEGUARD_LEDGER` selects an explicit file; local bare origins otherwise share `.mergeguard-ledger.jsonl` beside the bare repo. Worktree-local hook state uses `git rev-parse --absolute-git-dir`, so worktrees do not share deduplication state accidentally.

Strikes map to the longest matching policy path, otherwise the top-level folder (`./` for root files). `culprit` and its `reverted` event share the same incident identity and count once. Earliest incident time is retained so a delayed undo cannot erase an old cluster. A threshold cluster raises the folder's normal code floor by one, capped at two. Cooldown produces a suggestion; a human-approved policy reset is needed to release it. Twenty clean merges with no strikes in 30 days also produce a suggestion only.

The ledger is not an atomic transaction with Git and the PR registry. Compare-and-swap prevents main from being overwritten by a racing update, but a crash between writes can need reconciliation. This is documented rather than hidden behind a claimed production guarantee.

## One hook contract, two agents

Codex adopted the hook contract Claude Code established: JSON on stdin with `hook_event_name`, `cwd`, `session_id`, `tool_name`, `tool_input`, and `stop_hook_active`; JSON on stdout with `hookSpecificOutput.additionalContext` or `decision: block` plus `reason`. The adapter therefore does not know which agent is running it, and the demo world carries the same definition in `.codex/hooks.json` and `.claude/settings.json`. This keeps the harness honest about what it is: an observer of commands and of main, not a feature of one vendor's agent. The one vendor-specific piece is trust. Codex requires each project hook to be trusted by hash; the demo reproduces that hash and passes trust per invocation instead of asking anyone to bypass the review.

## Session memory is read from the ledger, never written by the agent

The SessionStart note lists recent incidents per folder with the PR, the partner PR, the failing tests, and the current floor. It is derived on every start from the same append-only ledger the guardian and breaker use, so an agent cannot plant a reassuring memory and nothing in it ages into folklore. It is deliberately specific; a vague "payments is risky" would be the kind of warning that research found no better than silence.

## Evaluating with live agents

The live comparison merges change A after the agent's first tool call rather than before it starts, because the claim under test is that a session learns about main *while it works*. The agent's first fetch after that merge delivers the note. Two evaluation-only settings are recorded in the results: the fetch throttle is lowered from 60 seconds to 5 because the demo task takes about a minute, and simulated reviewers approve the tiers the router asks for. Nothing lowers a tier, and the baseline arm merges through raw Git with the hooks disabled, exactly as a team without the harness would.

## Scope choices

The must-have path is deterministic and offline. Stretch work was deliberately limited to a basic CI workflow and compatibility investigation. Hosted review enforcement, a ledger orphan branch, MCP tools, model escalation, automatic regression-test generation, and SessionStart memory are deferred. They would broaden integrations before strengthening the demo's core evidence.
