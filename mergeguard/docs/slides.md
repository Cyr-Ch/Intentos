# Slides

Eleven slides, one claim each. Numbers from eval/results.md, generated 2026-10-27.

1. Writing PRs got cheap. Merging them didn't.
   FastMerge: a harness that takes merging off the critical path for a startup running coding agents in parallel.

2. Priya's Tuesday: 18 agent PRs by lunch, two reviewers, one broken main that stalls everyone.
   Six engineers, three Codex sessions each, one repo, no platform team, no Enterprise merge queue. (picture: 18 PRs, 2 reviewers, 1 broken main)

3. The break git cannot see.
   Agent A renames get_user, tests pass. Agent B, same base, calls get_user, tests pass. Git merges both, no conflict: main ImportError. (three frames)

4. Three jobs around the agent.
   Prevent: tell the agent exactly what changed on main while it works. Decide: send each PR to 0, 1 or 2 humans from a proof in the diff. Detect: find the culprit, undo it, remember it.
   The model does the work and gets specific context; what merges is decided by rules it cannot talk down; a model may raise a tier, never lower one.

5. Watch B find out. (live demo cue)
   Terminal B starts the task; terminal A lands the rename; B's next command. Then the same task with the harness off.

6. Specific, or it is silence.
   The note verbatim, from a real run: the symbol and its replacement, the commit, the file and line, what to do.

6b. What changed inside the agent's loop. (the harness slide, in the brief's words)
   Session start: memory from the ledger. After each command: specialized tool, fetch main, sync check, inject the note, log what ran. At stop: interruption recovery, refuse to finish stale and continue with the fix. At the PR: artifact validation, same check plus tier plus CI. Underneath: permission control, hooks trusted by hash, errors log and allow. Same five points in Claude Code.

7. Main is the meeting point. (diagram)
   Inherited from Codex: the agent, shell, sandbox, worktrees, hook contract. Built: sync check, router and gate, guardian, ledger and breaker. Nothing to host.

8. Review goes where the risk is.
   302 real agent PRs: 193 no reviewer, 86 one (83 had hit a concurrent change), 23 two (edited an assertion or broke an API). Approvals 302 -> 132. (bar)

9. When main breaks anyway: culprit, partner, undo.
   "Main broke at 2aad8917. Cause: PR #2 (clashed with #1). Undo PR #3 opened." Six steps. On 176-193-commit histories: 3 of 3 in about 11 s; beside a flaky test 6 of 6; zero wrong blames in 48 runs. Then the folder needs two reviewers.

10. Before and after, 80 agent runs per arm (Haiku x10, Sonnet x3, Codex x3).
    80 runs per arm: broken main 64 -> 0; API clashes caught 0 of 48 -> 48 of 48; meaning changes undone 0 of 16 -> 16 of 16; false alarms 0; cost about 15 s per task.
    What it costs (about 15 s per task, 0.1 s of hook time per command), what the evals changed (API-break tier, per-test flakiness, additive and annotation proofs, the note's first step, the stop gate as the reliable layer), what remains before production.
