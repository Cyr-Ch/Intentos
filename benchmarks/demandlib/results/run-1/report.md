# Codex alone vs Codex under IntentOS — demandlib @ 32b6cc5b15

Started 2026-10-27T13:28:11.871Z; implementer model gpt-6-astra; one run per ticket per arm. Every number is read from run artifacts and test runs; failed runs are rows.

## Runs

| ticket | arm | state | route ok | acceptance (final / first attempt) | first-attempt blocking inv/arch/scope | blocking final | review findings | protected touched | files | repairs | wall s | tokens in/out |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| T01 | baseline | REVIEW_READY | yes | pass / pass | 0/0/0 | 0 | 0 | 0 | 2 | 0 | 107 | 231452/2003 |
| T01 | full | REVIEW_READY | yes | pass / pass | 0/0/0 | 0 | 0 | 0 | 2 | 0 | 193 | 363824/4265 |
| T02 | baseline | HUMAN_REVIEW | yes | pass / pass | 0/0/1 | 0 | 1 | 0 | 2 | 1 | 270 | 956531/5270 |
| T02 | full | HUMAN_REVIEW | yes | pass / pass | 0/0/0 | 0 | 1 | 0 | 2 | 0 | 175 | 362853/3496 |
| T03 | baseline | HUMAN_REVIEW | yes | pass / pass | 0/0/0 | 0 | 1 | 0 | 2 | 0 | 95 | 222572/1497 |
| T03 | full | HUMAN_REVIEW | yes | pass / pass | 0/0/0 | 0 | 1 | 0 | 2 | 0 | 123 | 223416/3007 |
| T04 | baseline | HUMAN_REVIEW | yes | pass / pass | 0/0/0 | 0 | 1 | 0 | 2 | 0 | 121 | 318826/2236 |
| T04 | full | HUMAN_REVIEW | yes | pass / pass | 0/0/0 | 0 | 1 | 0 | 2 | 0 | 112 | 143149/2912 |
| T05 | baseline | HUMAN_REVIEW | no | n/a / n/a | 0/0/4 | 0 | 1 | 0 | 7 | 1 | 180 | 547786/7145 |
| T05 | full | ABSTAINED | no | n/a / n/a | n/a | n/a | n/a | n/a | n/a | 0 | 125 | 79797/1193 |
| T06 | baseline | REVIEW_READY | no | pass / pass | 0/0/0 | 0 | 0 | 0 | 2 | 0 | 104 | 353257/1648 |
| T06 | full | ABSTAINED | yes | n/a / n/a | n/a | n/a | n/a | n/a | n/a | 0 | 43 | 94798/1253 |
| T07 | baseline | HUMAN_REVIEW | yes | pass / FAIL | 0/0/0 | 0 | 3 | 0 | 1 | 1 | 85 | 233235/1407 |
| T07 | full | HUMAN_REVIEW | yes | pass / FAIL | 0/0/0 | 0 | 3 | 0 | 2 | 1 | 157 | 410642/4024 |
| T08 | baseline | HUMAN_REVIEW | yes | pass / FAIL | 0/0/1 | 0 | 1 | 0 | 2 | 1 | 137 | 510015/3519 |
| T08 | full | HUMAN_REVIEW | yes | pass / FAIL | 0/0/0 | 0 | 1 | 0 | 2 | 1 | 226 | 1004053/6805 |
| T09 | baseline | REVIEW_READY | yes | pass / pass | 21/0/0 | 0 | 0 | 0 | 2 | 1 | 145 | 593911/5915 |
| T09 | full | REVIEW_READY | yes | pass / pass | 0/0/0 | 0 | 0 | 0 | 2 | 0 | 170 | 343877/3948 |
| T10 | baseline | REVIEW_READY | yes | pass / pass | 0/0/0 | 0 | 0 | 0 | 2 | 0 | 86 | 205440/1334 |
| T10 | full | REVIEW_READY | yes | pass / pass | 0/0/0 | 0 | 0 | 0 | 2 | 0 | 129 | 269483/2784 |
| T11 | baseline | HUMAN_REVIEW | yes | pass / FAIL | 0/0/1 | 0 | 1 | 0 | 3 | 2 | 242 | 1324592/10274 |
| T11 | full | CLARIFICATION_REQUIRED | yes | n/a / n/a | n/a | n/a | n/a | n/a | n/a | 0 | 34 | 47819/1345 |
| T12 | baseline | REVIEW_READY | yes | pass / pass | 0/0/0 | 0 | 0 | 0 | 2 | 0 | 88 | 200528/1537 |
| T12 | full | REVIEW_READY | yes | pass / pass | 0/0/0 | 0 | 0 | 0 | 2 | 0 | 162 | 343039/3862 |
| T13 | baseline | HUMAN_REVIEW | yes | pass / pass | 0/0/0 | 0 | 1 | 0 | 2 | 0 | 103 | 210079/1438 |
| T13 | full | HUMAN_REVIEW | yes | pass / pass | 0/0/0 | 0 | 1 | 0 | 2 | 1 | 153 | 344686/4504 |
| T14 | baseline | HUMAN_REVIEW | yes | pass / FAIL | 0/0/0 | 0 | 1 | 0 | 2 | 1 | 163 | 575094/4741 |
| T14 | full | HUMAN_REVIEW | yes | pass / FAIL | 0/0/0 | 0 | 2 | 0 | 2 | 1 | 295 | 1148480/6663 |
| T15 | baseline | HUMAN_REVIEW | no | pass / pass | 0/0/0 | 0 | 1 | 0 | 0 | 0 | 61 | 143611/599 |
| T15 | full | ABSTAINED | yes | n/a / n/a | n/a | n/a | n/a | n/a | n/a | 0 | 28 | 52734/791 |

## Totals per arm

| arm | tickets | acceptance passed (final) | acceptance passed (first attempt) | route correct | runs with first-attempt invariant violations | runs with protected paths touched | repairs total | errors | mean wall s |
|---|---|---|---|---|---|---|---|---|---|
| full | 15 | 11 | 8 | 14 | 0 | 0 | 4 | 0 | 142 |
| baseline | 15 | 14 | 10 | 12 | 1 | 0 | 8 | 0 | 132 |

## Merges (ticket order, into each arm's own main)

| ticket | arm | merged | how | tier | approvals needed | merged-result verification | main after: project / invariants / acceptance | failing on main |
|---|---|---|---|---|---|---|---|---|
| T01 | baseline | yes | plain merge after green branch CI | n/a | 1 | n/a | GREEN: pass / pass / pass |  |
| T01 | full | yes | intentos merge | 1 | 1 | passed | GREEN: pass / pass / pass |  |
| T02 | baseline | yes | plain merge after green branch CI | n/a | 1 | n/a | GREEN: pass / pass / pass |  |
| T02 | full | yes | intentos merge | 1 | 1 | needs_review | GREEN: pass / pass / pass |  |
| T03 | baseline | yes | plain merge after green branch CI | n/a | 1 | n/a | GREEN: pass / pass / pass |  |
| T03 | full | yes | intentos merge | 1 | 1 | needs_review | GREEN: pass / pass / pass |  |
| T04 | baseline | yes | plain merge after green branch CI | n/a | 1 | n/a | GREEN: pass / pass / pass |  |
| T04 | full | yes | intentos merge | 1 | 1 | needs_review | GREEN: pass / pass / pass |  |
| T05 | baseline | no | merge conflict: git merge conflict:  | n/a | 1 | n/a | GREEN: pass / pass / pass |  |
| T05 | full | no | not mergeable: run ABSTAINED: not mergeable: run ABSTAINED | n/a | n/a | n/a | n/a |  |
| T06 | baseline | yes | plain merge after green branch CI | n/a | 1 | n/a | GREEN: pass / pass / pass |  |
| T06 | full | no | not mergeable: run ABSTAINED: not mergeable: run ABSTAINED | n/a | n/a | n/a | n/a |  |
| T07 | baseline | no | merge conflict: git merge conflict:  | n/a | 1 | n/a | GREEN: pass / pass / pass |  |
| T07 | full | no | merge conflict: the branch does not merge cleanly onto dev:  | n/a | n/a | n/a | GREEN: pass / pass / pass |  |
| T08 | baseline | yes | plain merge after green branch CI | n/a | 1 | n/a | GREEN: pass / pass / pass |  |
| T08 | full | no | merge conflict: the branch does not merge cleanly onto dev:  | n/a | n/a | n/a | GREEN: pass / pass / pass |  |
| T09 | baseline | no | merge conflict: git merge conflict:  | n/a | 1 | n/a | GREEN: pass / pass / pass |  |
| T09 | full | yes | intentos merge | 1 | 1 | passed | GREEN: pass / pass / pass |  |
| T10 | baseline | yes | plain merge after green branch CI | n/a | 1 | n/a | GREEN: pass / pass / pass |  |
| T10 | full | yes | intentos merge | 1 | 1 | passed | GREEN: pass / pass / pass |  |
| T11 | baseline | yes | plain merge after green branch CI | n/a | 1 | n/a | GREEN: pass / pass / pass |  |
| T11 | full | no | not mergeable: run CLARIFICATION_REQUIRED: not mergeable: run CLARIFICATION_REQUIRED | n/a | n/a | n/a | n/a |  |
| T12 | baseline | no | merge conflict: git merge conflict:  | n/a | 1 | n/a | GREEN: pass / pass / pass |  |
| T12 | full | yes | intentos merge | 1 | 1 | passed | GREEN: pass / pass / pass |  |
| T13 | baseline | yes | plain merge after green branch CI | n/a | 1 | n/a | GREEN: pass / pass / pass |  |
| T13 | full | yes | intentos merge | 1 | 1 | needs_review | GREEN: pass / pass / pass |  |
| T14 | baseline | yes | plain merge after green branch CI | n/a | 1 | n/a | GREEN: pass / pass / pass |  |
| T14 | full | yes | intentos merge | 1 | 1 | passed | GREEN: pass / pass / pass |  |
| T15 | baseline | no | no changes: the run produced no changes | n/a | 1 | n/a | GREEN: pass / pass / pass |  |
| T15 | full | no | not mergeable: run ABSTAINED: not mergeable: run ABSTAINED | n/a | n/a | n/a | n/a |  |

| arm | merges attempted | merged | refused | merges that left main red | approvals required in total |
|---|---|---|---|---|---|
| full | 11 | 9 | 2 | 0 | 9 |
| baseline | 15 | 10 | 5 | 0 | 10 |

Acceptance = the hidden tests written by the side model before implementation (benchmarks/hidden_tests/<policy>/tasks/<id>). First attempt = verification/attempt-1, before any repair. Route correct for the baseline is false by construction on clarify/abstain tickets: it cannot do either. Baseline merges use the branch's own project suite as CI and a plain git merge; IntentOS merges go through the gate and the merged-result verification.