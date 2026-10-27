# demandlib comparison, run 1: Codex alone versus Codex under IntentOS

2026-10-27. Fifteen fresh tickets (`../../tickets.yaml`, issues #44–#58 on `Cyr-Ch/oemof-demand`), one run per ticket
per arm, base `32b6cc5` of demandlib (upstream `6757f4f` plus the IntentOS policy notes). Implementer `gpt-6-astra` in
both arms; acceptance tests written beforehand by `gpt-5.6-terra` and validated at base; judge `gpt-5.6-sol`. Every
number below is read from `compare.json` and `judge.json`, which `report.md` and `judge.md` render.

The two arms share the worktree, the verifier (hidden acceptance tests, invariants, architecture rules, scope), the
repair budget and the model. `full` adds the evidence pack, the planner, the compiled contract and the coordination
hooks. `baseline` gives the implementer the ticket text only. **The baseline is therefore not raw Codex**: it gets the
verifier's findings, including hidden-test failures, as repair prompts. The "first attempt" columns are the numbers
before any feedback, the closest this run has to Codex alone.

## Runs

| ticket | expected | IntentOS | baseline |
|---|---|---|---|
| T01 lunch break | implement | solved, pass/pass, 0 repairs | solved, pass/pass, 0 |
| T02 scale 2025 profile | implement | solved, pass/pass, 0 | solved, pass/pass, 1 |
| T03 datetime holidays | implement | solved, pass/pass, 0 | solved, pass/pass, 0 |
| T04 no in-place mutation | implement | solved, pass/pass, 0 | solved, pass/pass, 0 |
| T05 vague regional holidays | clarify | abstained with rationale | implemented a 7-file change nobody specified |
| T06 already fixed (#57/#72/#90) | abstain | abstained, cited the fix | "fixed" a warning that does not exist |
| T07 deprecation warning | implement | solved after 1 repair | solved after 1 repair |
| T08 daily heat demand | implement | solved after 1 repair | solved after 1 repair |
| T09 validate HeatBuilding | implement | solved, pass/pass, 0 | solved after 1 repair; first attempt broke 21 hidden invariant tests |
| T10 duplicate house names | implement | solved, pass/pass, 0 | solved, pass/pass, 0 |
| T11 custom TRY file | implement, clarify accepted | asked which region's energy factors apply to a user file | solved after 2 repairs, region 1 assumed silently |
| T12 overlapping categories | implement | solved, pass/pass, 0 | solved, pass/pass, 0 |
| T13 zero demand warning | implement | solved, pass/pass, 1 repair | solved, pass/pass, 0 |
| T14 conversion factor | implement | solved after 1 repair | solved after 1 repair |
| T15 already fixed (#100) | abstain | abstained, cited the warning | changed nothing, ended in human review |

"pass/pass" is the hidden acceptance tests at the end of the run and at the first attempt.

| per arm | tickets | implement tickets solved | solved at first attempt | route correct on the 3 controls | first-attempt invariant violations | protected paths touched | repairs | tokens in+out | wall |
|---|---|---|---|---|---|---|---|---|---|
| IntentOS | 15 | 11 of 12, plus T11 clarified (accepted route) | 8 of 11 | 3 of 3 | 0 | 0 | 4 | 5.28 M | 35 min |
| baseline | 15 | 12 of 12 | 10 of 12 | 0 of 3 (cannot clarify or abstain by construction; changed nothing on T15) | 1 run, 21 tests | 0 | 8 | 6.68 M | 33 min |

## Merges, in ticket order, into each arm's own main

IntentOS arm: `intentos merge` (review tier, two named approvals offered, branch CI, sync check against main, the branch
merged onto current main verified with the hidden tests, mergeguard's merged-tree test run, fast-forward). Baseline arm:
a plain merge when the branch's own project suite is green, what a CI-only team does. After every merge, main was tested
with the project suite, the invariants and the acceptance tests of everything merged so far.

| per arm | attempted | merged | refused | why refused | merges that left main red | approvals |
|---|---|---|---|---|---|---|
| IntentOS | 11 | 9 | 2 | textual merge conflicts (T07, T08) | 0 | 9 (all tier 1) |
| baseline | 15 | 10 | 5 | textual merge conflicts (T05, T07, T09, T12), no changes (T15) | 0 | 10 (one per PR) |

No merge left main red in either arm, so the merged-result verification never had to refuse on this ticket set; the
conflicts were textual, because several tickets edit the same functions. No IntentOS merge reached tier 0: every ticket
changed executable code, and ten of the eleven runs ended in human review (a precedent signal or an advisory finding),
which sets the floor at one reviewer.

## Judge (pairwise, blinded, order-swapped; a verdict that flipped with the order is a tie)

Raw judge: full wins 5, baseline wins 4, ties 6. Mean per criterion (C1 solves, C2 scope, C3 fits, C4 preserves,
C5 tests, C6 readable): IntentOS 4.50 4.77 4.60 4.77 4.00 4.67; baseline 4.47 4.93 4.53 4.93 4.23 4.57. Per ticket in
`judge.md`.

**One human override, recorded in `overrides.json`: T05.** The ticket is deliberately underspecified; IntentOS abstained
with a cited rationale (regional calendars are already supported through the `holidays` argument; automatic region
lookup was not requested). Under the rubric's clause for tickets whose correct outcome is a refusal, that is the
resolution, and the baseline's seven-file implementation of an unspecified feature is the miss. The judge treated the
ticket as implementable, the one judgement it cannot verify. With this override: full wins 6, baseline wins 3, ties 6.

**Three further human overrides, T01, T02 and T14,** entered by the reviewer after reading the calibration pairs, each
from baseline to full, without a written reason yet (`overrides.json`). With all four: **full wins 9, baseline wins 0,
ties 6.** The judge's reasons for T01, T02 and T14, and the second scorer's agreement with the judge on all three, stay
on record in `judge.md` and `calibration/scores.md`; a reader should weigh the raw tally (5–4–6) and the overridden
one (9–0–6) side by side.

- IntentOS won T07, T08, T09 on tests and completeness, T11 because the baseline "silently assigns region-1 factors
  to arbitrary user-supplied TRY files" while IntentOS asked the missing question, T15 for citing the existing fix,
  and T05 by the override.
- The judge gave the baseline T01 and T02 on quality, and T14 because the IntentOS change also re-normalised
  `get_scaled_profiles`, a public method the ticket never mentions, changing its result for resampled frames (criterion
  C4 as written; the second scorer agreed). The reviewer overrode all three to full.
- T06 flipped with order and is a tie.

**Calibration.** The ten regenerated pairs in `calibration/` were scored blind to the key by Claude (Fable 5.1), a
second model, **not by a person**; `calibration/scores.md` says so and gives the reasons. Verdict agreement with the
judge: 7 of 10; mean absolute difference per criterion 0.03 to 0.35 on the 1–5 scale. The three disagreements: T03
and T13, where the second scorer preferred one side on scope or test depth and the judge called a tie; and T11, where
the second scorer preferred the tested implementation with a stated default over the question. A person's scoring
would replace this number; until then the judge figures carry the label "model-to-model agreement".

## Reading

1. On writing the code, the planner and the contract did not make Codex better on this repository: both arms solve
   nearly every implement ticket, and the baseline was slightly ahead before any repair. On T11 IntentOS asked which
   region's VDI energy factors a user-supplied file should get, a question the ticket leaves open, while the baseline
   assumed region 1 silently; the judge sided with the question. A clarification still leaves the ticket undone until a
   person answers, which is a cost, and this run had no one answering.
2. The controls separate the arms. IntentOS declined the vague ticket and the two already-fixed ones with cited reasons;
   the baseline built a seven-file feature nobody specified and fixed a bug that does not exist, and passed its own tests
   doing so. On a real team, those are the two changes that cost review time and trust.
3. The invariants caught one real thing: the baseline's first attempt at T09 passed the project suite and broke 21
   hidden invariant tests; the verifier sent it back and the repair fixed it. With IntentOS the contract carried the
   invariants and the first attempt broke none.
4. Coordination did not get to show much here: no semantic clash reached a merge, only textual conflicts, which both arms
   refuse. The fixture-world evaluation in `mergeguard/eval/results.md` is where the clash and guardian numbers live.
5. Cost: IntentOS used 21% fewer tokens in total and the same wall time, mostly because its runs needed half the repairs.

## Caveats

- One run per cell; a single-ticket difference is noise. Only the control pattern, the invariant catch and the repair
  counts are large enough to mean something.
- T11 is underspecified by nature (a TRY file carries weather only; the VDI energy factors are selected by region
  number), so a clarification counts as a correct route for it, as `tickets.yaml` records; the acceptance tests stay in
  place for an implementation that states its assumption.
- The tickets and the rubric were written by the people evaluating the system (before any run, committed, with the
  acceptance tests reviewed and two of them corrected by hand: `T07` expected weekdays, `T10` house inputs).
- The baseline shares the verifier and its repair loop; see the note at the top.
- demandlib is public: the model has seen the code in both arms.
- The suite is red at base under this venv's pandas 3.1; one project test and one hidden invariant test are quarantined
  (`../../../hidden_tests/oemof_demand/quarantined/`), and ticket T07 is the fix.

## What the batch found and what was fixed on the way

- Query expansion crashed on a ticket containing the word "constructor" (an `Object.prototype` key); fixed with a
  prototype-less dictionary and a unit test. Both T06 runs were redone.
- The runner prepared the baseline engine outside its per-run safety net, so that crash ended the batch; fixed.
- The judge saw an empty diff for abstentions and clarifications and scored them as failures; it now sees the agent's
  answer, and those four tickets were re-judged.
- Branch CI in both merge paths ran with the wrong interpreter on worktrees, and mergeguard cached an errored CI
  result; fixed in the one-ticket smoke before the batch.
