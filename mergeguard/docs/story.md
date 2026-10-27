# mergeguard: the story

**Audience.** A technical stakeholder deciding whether to deploy this for a small team. They know what Codex is; they have not seen this repo.

**Arc in one sentence.** Codex made parallel agents cheap, which made *coordination* the bottleneck; mergeguard makes main the meeting point so sessions learn about each other through main, humans review in proportion to proven risk, breaks are undone automatically, and the policy tightens where things actually break.

**Shape.** 30 minutes of talk, 15 of Q&A. The four parts the brief asks for map to four movements: the problem and the demo (what it does), the architecture (how), the decisions (why this way), the evidence and limits (how we know, and what we don't).

| Minutes | Movement | What is on screen |
| --- | --- | --- |
| 0–3 | Priya's problem | Slides 1–3 |
| 3–6 | What we built, in principle | Slides 4–5 |
| 6–14 | Live demo, act 1: a rename lands mid-task | Two terminals |
| 14–18 | Architecture and the representative run | Slides 6–7 |
| 18–23 | Acts 2–4 from pre-generated reports | Report HTML, guardian.json, breaker status |
| 23–27 | Evidence | Slides 8–9 |
| 27–30 | Limits and what remains before production | Slides 10–11 |
| 30–45 | Q&A | Backup slides |

---

## Movement 1: the problem (slides 1–3)

**Persona.** Priya is the founding engineer at a 12-person B2B SaaS. One main repo on GitHub, Python services, GitHub Actions, no platform team, no on-call rotation, no GitHub Enterprise, so no native merge queue for a private repo. Each engineer runs several Codex sessions in parallel from their own laptop, each in its own worktree. Merged changes per day have multiplied; headcount has not.

**Three problems, in her words.**
1. *Agents break each other.* Agent A renames `get_user` to `fetch_user`. Agent B, started from the same base, adds code that calls `get_user`. Both PRs are green. Git merges them without a conflict. Main is red. Each session is isolated by design and blind to the other.
2. *Review is the bottleneck.* Two humans cannot read every agent PR, and reading every PR equally is the wrong allocation anyway.
3. *When main breaks, nobody knows why.* Someone spends an hour finding the culprit while other sessions keep building on broken code.

**Why now, and the one research fact that shaped everything.** Worktrees and subagents made parallelism a one-liner. Studies of agent coordination found that vague warnings ("a teammate may be editing X") are no better than no coordination at all; only the specific change helps. So every message this system sends to an agent names the exact symbol, the exact replacement, the exact file and line, the commit, and what to do.

**Deployment requirements, stated up front.** Nothing to host. Runs inside the repo through Codex hooks, scripts, and optionally GitHub Actions. Python only. No enterprise features. It must never crash an agent session (hook errors log and allow). It must never trust a PR description to lower risk. It may tighten policy automatically but may loosen it only with a human.

## Movement 2: what we built (slides 4–5)

Four pieces, one principle each:

- **Sync gate (prevent).** While an agent works, and again before it may finish, check whether main changed anything the agent's code uses. Tell it exactly what changed. The PR check runs the same logic as the backstop.
- **Review router (decide).** Tier 0 (no human), 1, or 2, decided from the diff and from how the change was made. Deterministic rules decide everything they can; anything author-controlled can only raise a tier.
- **Guardian (detect).** When main breaks: rule out a flaky test, bisect to the culprit merge, check whether it is a clash between two changes, find the partner, open an undo PR, write the ledger.
- **Breaker (learn).** Count strikes per folder from the ledger; two in a week raise that folder's minimum review tier. Loosening is only ever suggested.

Principles to say out loud: main is the meeting point (pull model; sessions never talk to each other); deterministic first, a model boxed in to only raising tiers; tighten automatically, loosen with a human; never trust PR text for lowering risk; never crash a session.

## Movement 3: live demo, act 1 (two terminals, 6–14 min)

Choreography, rehearsed:

1. Before the interview: `./demo/run_demo.sh live ../interview --agent both`. It prints exactly what to type. Have the baseline world ready too.
2. Terminal B: start the agent in `engineer_b` (Codex if the quota allows; Claude Code reads the identical hooks from `.claude/settings.json`, say so plainly). Give it the task: *"Add an account summary that shows the user's id."*
3. Terminal A, while B is still exploring: `python -m mergeguard.demo merge-a --world ../interview`. Say: "Laptop A's rename just merged. B has no idea."
4. Watch B's next shell command. The hook fetches, runs the sync check, and B receives: *"While you were working, main changed: `users.get_user` was renamed to `users.fetch_user` in commit …. Your code uses it at account.py:7. Update the import and calls to use `users.fetch_user`, re-run the tests, then finish."* Read it aloud. Point at the four specifics.
5. B fixes the call, tests pass, finishes. `python -m mergeguard sync-check --fetch` prints `Sync clean.`
6. Thirty seconds on the baseline: the same task with `MERGEGUARD_DISABLE=1` merges green and main is red. Show the failing test on merged main.

If the live agent misbehaves: `./demo/run_demo.sh act1` is the scripted version with the same note, blocked PR, repair, and merge. Say which one you are showing.

## Movement 4: architecture and a representative run (slides 6–7)

**Inherited from Codex:** the model and its coding loop, file editing and shell, sandboxing, non-interactive runs, parallel sessions and worktrees, and the hook contract (PostToolUse, Stop, SessionStart; JSON in, JSON out).

**Built:** symbol-level change detection (`ast` index of functions, classes, methods; removed, renamed, moved, signature changed), use detection in the branch's changed files (explicit imports and calls, with positional and keyword arity), the sync check that intersects the two, the hooks, the how-made log, the router and approvals gate, the guardian, the append-only ledger, the breaker, the offline two-laptop world, and the evaluation harness. No model sits in the decision path.

**The representative run, from the how-made log of a real evaluation run (S1, harness arm):**

```
23:55:10  command   git status && cat users.py account.py …      (agent explores)
          [A's rename merges on main 7 s after B started]
23:55:14  command   python -m pytest -q                            (hook: fetch throttled, no note yet)
23:55:17  stop_block users.get_user:renamed                        (agent tried to finish; Stop hook fetched, blocked)
23:55:21  sync_note users.get_user:renamed                         (note delivered on the continuation)
23:55:31  command   python -m pytest -q                            (fixed; 3 passed)
```

Walk the code in this order if asked: `hooks.py` (40 lines that matter), `sync_check.py`, `changes.py`, `router.py`, `guardian.py`.

## Movement 5: acts 2–4 from reports (18–23 min)

- **Act 2, routing.** Open the review report: three PRs merged with no human (docs, comment-only, docstring-only, each with its proof), one waiting for one reviewer, payments and a removed assertion waiting for two. Show that author text cannot lower a tier, approvals bind to the head SHA, bots and the author never count. Mention the rule added tonight: a proven public API break needs two humans, because that is what breaks parallel sessions.
- **Act 3, the honest limit.** Dollars become cents, same name, same signature. The sync check cannot see it, by design. The guardian: three reruns at bad and good, first-parent bisect, alone check on the culprit's branch, partner search, validated undo. The report line: *"Main broke at …. Cause: PR #2 (clashed with #1). Undo PR #3 opened."* Say clearly: it removed the change and kept the evidence; the fix is a human's job.
- **Act 4, learning.** Two incidents in a week raise `invoices/` to two reviewers automatically; cooldown produces a suggestion only; a human-reviewed policy timestamp is the only way down. The next session that starts gets a SessionStart note naming the folder, the PRs, and the failing tests.

## Movement 6: evidence (slides 8–9)

All numbers are generated into `eval/results.md` from raw logs; none are typed by hand. Copy the current table at presentation time.

**Live agents, task B with and without the harness** (fresh world per run, A merged after the agent's first tool call, simulated reviewers):

| Outcome | Haiku, without | Haiku, with (15 runs) | Sonnet, without | Sonnet, with (5 runs) |
| --- | ---: | ---: | ---: | ---: |
| Main ended broken | 12 | 0 | 4 | 0 |
| API clashes caught before merge | 0 of 9 | 9 of 9 (6 by note, 3 by stop gate) | 0 of 3 | 3 of 3 |
| Meaning changes undone by the guardian | 0 of 3 | 3 of 3 | 0 of 1 | 1 of 1 |
| False alarms on the control | 0 | 0 | 0 | 0 |
| Extra cost per run | – | +3.7 tool calls, +15 s, +1.8k output tokens | – | +1.0 tool call, +8 s |

Codex row: use whatever `results.md` shows after the 02:02 quota reset. If it did not run, say so; the hook contract is identical and the Claude Code runs exercise the same adapter.

**Router:** 28 hand-labelled diffs, 28 exact, 0 risky PRs under-reviewed, 5 need no human. **Breaker:** synthetic timeline, trips on the second strike, holds through cooldown and day 60, clears only on a human reset. **Guardian:** 7 of 7 S4 runs named the right culprit and partner on short histories; the realistic-history evaluation (20–50 reviewed PRs around the event, a real injected flaky test, and a flaky test beside a real clash) is in section 3 of `results.md`.

## Movement 7: limits and what remains (slides 10–11)

**What didn't work, honestly.**
- The Codex usage limit ran out mid-build; the Codex arm ran last.
- Codex only runs project hooks after a per-hook trust review. Rather than a bypass flag, the trust hash was reproduced from the `codex-rs` source and passed per invocation; it never touches the user's config.
- Neither Codex nor Claude Code gives hooks a shell exit status, so test pass/fail evidence needs a receipt wrapper.
- Three agents fixed the call to the new API but did not pull main, so their branch tests failed while the merged result was correct.
- The fetch throttle can delay a note until the stop gate; the stop gate caught all of those.
- The labelled-diff check found a module move routing to one reviewer; API breaks are now a tier-2 rule.
- The first guardian design was all-or-nothing on flakiness; a flaky test beside a real break would have hidden the break. It now excludes flaky tests per test.

**Trade-offs to own.** Pull model over a server (nothing to host, up to 60 s of delay). Symbol-level detection (cheap, no tests needed, misses meaning changes; the guardian covers that). Laptop hooks plus the PR check (early and specific, plus guaranteed). Automatic undo, human fixes. Strict default: the prompter does not count as a reviewer. Ledger on a bot-only branch, not on main.

**Before production.** Authenticated GitHub approvals and branch protection instead of the offline registry; the ledger on an orphan branch; a guardian as a Codex agent with MCP tools that writes a regression test and validates it mechanically; model escalation that can only raise a tier; randomized live trials on a real codebase rather than five hand-built scenarios.

## Q&A preparation

- *Why not just rebase before merging?* Rebasing does not run B's code against A's rename; both still pass alone. The sync check reads what B's code uses and what main changed, which no merge driver does.
- *Why symbols and not tests?* Tests only catch what they cover and only after both changes exist; the note arrives while the agent still has context.
- *Why no model in the loop?* Determinism, auditability, and cost. A model could only ever raise a tier here, never lower one.
- *What about dynamic imports, reflection, methods on unknown types?* Not resolved; documented limits. The guardian is the net under the gate.
- *Isn't tier 0 dangerous?* Only with a proof: AST equality or docstring-only, trusted author, no protected path. Policy can disable it.
- *What did Codex itself contribute during development?* The first build session ran in Codex; hooks were probed against the real CLI before the adapter was written; the trust mechanism was taken from the Codex source.
- *How does this scale beyond 12 people?* The pull model has no central state; the ledger and policy live in the repo; a hosted gate replaces the offline registry.
