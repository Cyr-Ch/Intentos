# Interview demo runbook: IntentOS with mergeguard, in one Codex window, on demandlib

Prepared by `demo/prepare.ts` (four live Codex runs, once). Restored by `demo/reset.sh` in seconds, as often as you
rehearse. The exact run ids for the sentences below are in `~/intentos-demo/state.json`; `reset.sh` prints them.

## Before the session

1. `demo/reset.sh`, then start Codex on the demo home: `INTENTOS_HOME=~/intentos-demo/home INTENTOS_CODEX_MODEL=gpt-6-luna codex`
   (the IntentOS plugin's server reads both from the environment; without the plugin, `demo/prepare.ts --register`
   registers an `intentos-demo` server instead).
2. Laptop on power, `caffeinate -i` in a spare terminal, Codex credits checked, network checked.
3. Start the local dashboard in a second terminal:
   `INTENTOS_HOME=~/intentos-demo/home node --disable-warning=ExperimentalWarning bin/intentos.js dashboard ~/intentos-demo/demandlib`
   (run from the IntentOS checkout). Put its Live runs view beside the Codex chat. The Policy tab shows the
   automatically created rules and lets the user edit their statement or enforcement; the Knowledge base tab shows
   indexed evidence and linked ticket history.
4. Fallback open in a browser tab: the rehearsal's `report.md`, `merge.json` and the guardian output from the last
   successful run-through (copy them out of `~/intentos-demo/home/runs/` after rehearsing).

## The flow (about ten minutes of stage time)

**Opener, 1 min.** "What does IntentOS know about this repository? Show me status and the policy." Codex calls
`status` and `policy`: onboarded, 39 approved invariants with hidden tests, index at the base revision, 43 precedents.
One sentence from you: the rules were mined from the repository's own history by a different model and approved into
the policy; every one of them is a hidden test the verifier runs.

**Moment A, the hook mid-task, 4 min.** Paste `sentences.momentA_start` from state.json (T12, overlapping day
categories; its file imports `add_weekdays2df`). Codex calls `run` and starts polling `status`. After the status log
shows "implementing in …", say `sentences.momentA_during`: "Merge PR #1, approvals from Priya and Sam." PR #1 renames
`add_weekdays2df`, a public API (the old definition is gone, a deprecated alias remains), so the gate asks for two
humans; it lands and main moves. Keep polling `status` for
the T12 run: the log shows the hook's note reaching the implementer (the symbol, the commit, the file and line, "first
bring main into your branch"), the runner syncing the worktree after the agent turn, and verification ending green against the new main with
`coordination: up to date`. Then `sentences.momentA_after`: "Merge the T12 run, approval from Priya." Tier 1, merged
result verified, main fast-forwarded.

What to say while it runs: the implementer is a separate Codex thread in a git worktree with its own `CODEX_HOME`;
the hook fires after every shell command and refuses a stale finish; nothing here is a model deciding, it is an AST
index of main against the worktree's imports.

If the merge of P1 lands after the T12 run already finished, nothing is lost: skip to Moment B's sentence with the T12
run instead, and the gate refuses it the same way.

**Moment B, the gate, 2 min.** `sentences.momentB`: "Merge run <P2>, approval from Priya." P2 was verified green
before the rename and still is on its own branch. The gate refuses with the exact line: `add_weekdays2df` was renamed
to `annotate_weekdays` in commit …, your code uses it at `src/oemof/demand/particular_profiles.py:…`, first bring main
into your branch. Say: this PR is green and would merge on GitHub by default; its author gets the fix instruction
instead of a broken main.

**Moment C, the guardian, 2 min.** `sentences.momentC`: "Main of ~/intentos-demo/red/demandlib is red. Investigate."
Codex calls `guard`: the failing test, three reruns to rule out flakiness, a first-parent bisect to the culprit merge,
the check that it passes alone, the partner merge it clashed with (a ValueError for negative demand against a feature
that needs negative demand), and a validated undo PR. Then `sentences.momentC_after`: "Merge that undo PR, approvals
from Priya and Sam." Main is green. Say: this is the case the symbol check cannot see by design, and in the normal flow
the merged-result verification refuses it before main moves; here both checks were switched off to show the recovery.

**Then the evidence.** `benchmarks/demandlib/results/run-1/README.md` for this repository, and
`mergeguard/eval/results.md` for the parallel-agent numbers.

## Rehearsing

- Stop the dashboard with Ctrl-C before `demo/reset.sh`; it restores everything, including the prepared runs and the red clone. Restart the dashboard and Codex after it.
- Moment A spends one live run per rehearsal (T12). Moments B and C spend nothing.
- For a timed command-line rehearsal, use `demo/rehearse-moment-a.sh --model gpt-6-luna --delay 35` after reset. The 35-second merge reached the hook during the live run; stage timing can vary, so merge as soon as status says "implementing".
- To rebuild from scratch (new prepared runs): `demo/reset.sh --destroy`, then `demo/prepare.ts` again.

## If something fails on stage

- Codex credits or network: open the fallback artifacts and narrate from them; every moment has a report or a
  merge.json.
- The T12 run ends before P1 merges: use the T12 run for Moment B.
- `status` says a job is already running: wait for it; one job per repository at a time.
