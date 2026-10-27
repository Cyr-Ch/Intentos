# mergeguard evaluation

Generated 2026-10-27T03:45:37Z by `eval/render.py` from raw run logs under `eval/runs/`. Numbers come only from those logs; failed runs are counted, not dropped.

## 1. Live agents: task B with and without the harness

Arms: **baseline** sets `MERGEGUARD_DISABLE=1` and merges with raw Git; **harness** runs the hooks, the PR gate, and the guardian. Reviewers `priya` and `sam` are simulated humans. 'Integrated clean' means the branch merged into main and the full suite passed there without recovery. Tokens are as reported by the agent CLI (input includes cache reads).

#### Across models

| Agent · model | Runs per arm | Main left broken, without → with | Clashes caught (S1–S3) | Notes delivered | Stop-gate blocks | Extra tool calls per run | Harness spend |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| claude · `haiku` | 50 | 40 → 0 | 30 of 30 | 30 | 16 | +3.4 | $0.44 |
| codex · `gpt-6-astra` | 15 | 12 → 0 | 9 of 9 | 9 | 0 | +2.9 | n/a |
| claude · `sonnet` | 15 | 12 → 0 | 9 of 9 | 9 | 5 | +1.9 | $1.58 |

### claude · `haiku` · 20261027T014147.904560Z · arms: baseline, harness

**Method:** Each run: fresh bare origin and two clones; change A is opened as a PR on laptop A; the agent starts on laptop B; A is approved by simulated humans and merged after the agent's first tool call (fallback 20s); the agent's uncommitted work is committed by the runner; the branch is tested alone, opened as a PR, and integrated: every arm but baseline through the real gate and guardian, baseline through raw Git. Arms: baseline (hooks off); harness; vague (the same hooks deliver a non-specific warning); stop-only (no notes during the task, only the Stop gate); notes-only (notes, no Stop gate). Hooks fetch at most every 5s in this evaluation (default 60s) because the task takes about a minute. Raw evidence per run (agent event stream, stderr, how-made log, branch patch, result JSON): `runs/20261027T014147.904560Z-live-claude-haiku/`.

| Outcome | Without (baseline) | With (harness) |
| --- | ---: | ---: |
| Runs | 50 | 50 |
| Main ended broken | 40 | 0 |
| API clashes caught before merge (S1–S3) | 0 of 30 | 30 of 30 (14 by note during the task, 16 by stop gate) |
| Meaning changes undone by the guardian (S4) | 0 of 10 | 10 of 10 |
| False alarms on the control (S5) | 0 | 0 |
| Agent runs that failed or produced nothing | 0 | 0 |
| Extra cost per run versus baseline | – | +3.4 tool calls, +14.2 s wall, +1877.4 output tokens |
| Stop-gate blocks | 0 | 16 |

<details><summary>Per-scenario detail</summary>

| Scenario | Arm | Runs | Notes | False notes | Stop blocks | PR-check blocks | Integrated clean | Main broke | Recovered | Healthy at end | Tool calls | Tokens in / out | Wall s | Agent failures |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S1 · rename | baseline | 10 | 0 | 0 | 0 | 0 | 0 | 10 | 0 | 0 | 4.5 | 130332.7 / 1267.9 | 14.6 | 0 |
| S1 · rename | harness | 10 | 10 | 0 | 5 | 2 | 8 | 0 | 0 | 10 | 11.2 | 348194.6 / 4520.7 | 38.9 | 0 |
| S2 · required parameter | baseline | 10 | 0 | 0 | 0 | 0 | 0 | 10 | 0 | 0 | 4.8 | 142957.6 / 1329.2 | 15.5 | 0 |
| S2 · required parameter | harness | 10 | 10 | 0 | 9 | 6 | 4 | 0 | 0 | 10 | 10.3 | 352139.8 / 5044.3 | 41.2 | 0 |
| S3 · module move | baseline | 10 | 0 | 0 | 0 | 0 | 0 | 10 | 0 | 0 | 4.8 | 139034.2 / 1346.2 | 14.6 | 0 |
| S3 · module move | harness | 10 | 10 | 0 | 2 | 4 | 6 | 0 | 0 | 10 | 9.3 | 292977.5 / 3757.3 | 33.3 | 0 |
| S4 · dollars → cents (semantic blind spot) | baseline | 10 | 0 | 0 | 0 | 0 | 0 | 10 | 0 | 0 | 5.2 | 109340.7 / 1461.5 | 14.5 | 0 |
| S4 · dollars → cents (semantic blind spot) | harness | 10 | 0 | 0 | 0 | 0 | 0 | 10 | 10 | 10 | 5.4 | 114472.4 / 1496.2 | 16.3 | 0 |
| S5 · unrelated change (control) | baseline | 10 | 0 | 0 | 0 | 0 | 10 | 0 | 0 | 10 | 4.5 | 133160.5 / 1278.5 | 14.3 | 0 |
| S5 · unrelated change (control) | harness | 10 | 0 | 0 | 0 | 0 | 10 | 0 | 0 | 10 | 4.8 | 117421.4 / 1252.0 | 14.6 | 0 |

</details>

- Baseline: 40/50 merges broke main; 10/50 integrated cleanly.
- Harness: 10/50 merges broke main before recovery; 50/50 finished healthy; 28/50 integrated cleanly; 12 blocked at the PR check; 16 stop-hook blocks; 30 notes delivered, 0 false; the branch's own tests passed before integration in 45/50 harness runs and 50/50 baseline runs.
- Harness cost per run (mean, harness minus baseline): tool calls +3.4, output tokens +1877.4, wall seconds +14.2.
- End-to-end seconds per run, agent plus integration (and guardian plus undo when main broke): baseline 19.8 s (but 40 runs ended with main still broken); harness 36.8 s.
- Agent spend per arm as reported by the CLI: baseline $0.31; harness $0.44.

### claude · `sonnet` · 20261027T015736.446457Z · arms: baseline, harness

**Method:** Each run: fresh bare origin and two clones; change A is opened as a PR on laptop A; the agent starts on laptop B; A is approved by simulated humans and merged after the agent's first tool call (fallback 20s); the agent's uncommitted work is committed by the runner; the branch is tested alone, opened as a PR, and integrated: every arm but baseline through the real gate and guardian, baseline through raw Git. Arms: baseline (hooks off); harness; vague (the same hooks deliver a non-specific warning); stop-only (no notes during the task, only the Stop gate); notes-only (notes, no Stop gate). Hooks fetch at most every 5s in this evaluation (default 60s) because the task takes about a minute. Raw evidence per run (agent event stream, stderr, how-made log, branch patch, result JSON): `runs/20261027T015736.446457Z-live-claude-sonnet/`.

| Outcome | Without (baseline) | With (harness) |
| --- | ---: | ---: |
| Runs | 15 | 15 |
| Main ended broken | 12 | 0 |
| API clashes caught before merge (S1–S3) | 0 of 9 | 9 of 9 (4 by note during the task, 5 by stop gate) |
| Meaning changes undone by the guardian (S4) | 0 of 3 | 3 of 3 |
| False alarms on the control (S5) | 0 | 0 |
| Agent runs that failed or produced nothing | 0 | 0 |
| Extra cost per run versus baseline | – | +1.9 tool calls, +9.9 s wall, +417.1 output tokens |
| Stop-gate blocks | 0 | 5 |

<details><summary>Per-scenario detail</summary>

| Scenario | Arm | Runs | Notes | False notes | Stop blocks | PR-check blocks | Integrated clean | Main broke | Recovered | Healthy at end | Tool calls | Tokens in / out | Wall s | Agent failures |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S1 · rename | baseline | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 3.0 | 121825.3 / 631.0 | 16.4 | 0 |
| S1 · rename | harness | 3 | 3 | 0 | 2 | 0 | 3 | 0 | 0 | 3 | 5.3 | 217645.0 / 1114.3 | 25.4 | 0 |
| S2 · required parameter | baseline | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 4.0 | 113104.3 / 611.3 | 16.4 | 0 |
| S2 · required parameter | harness | 3 | 3 | 0 | 2 | 0 | 3 | 0 | 0 | 3 | 5.7 | 222324.0 / 1306.3 | 28.0 | 0 |
| S3 · module move | baseline | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 2.7 | 110814.3 / 534.3 | 15.3 | 0 |
| S3 · module move | harness | 3 | 3 | 0 | 1 | 0 | 3 | 0 | 0 | 3 | 8.0 | 254459.0 / 1442.7 | 32.4 | 0 |
| S4 · dollars → cents (semantic blind spot) | baseline | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 2.0 | 88750.3 / 521.7 | 12.1 | 0 |
| S4 · dollars → cents (semantic blind spot) | harness | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 3 | 3 | 2.0 | 91617.3 / 492.3 | 16.8 | 0 |
| S5 · unrelated change (control) | baseline | 3 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 3 | 2.3 | 102481.0 / 479.7 | 15.9 | 0 |
| S5 · unrelated change (control) | harness | 3 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 3 | 2.7 | 110088.0 / 508.0 | 22.8 | 0 |

</details>

- Baseline: 12/15 merges broke main; 3/15 integrated cleanly.
- Harness: 3/15 merges broke main before recovery; 15/15 finished healthy; 12/15 integrated cleanly; 0 blocked at the PR check; 5 stop-hook blocks; 9 notes delivered, 0 false; the branch's own tests passed before integration in 15/15 harness runs and 15/15 baseline runs.
- Harness cost per run (mean, harness minus baseline): tool calls +1.9, output tokens +417.1, wall seconds +9.9.
- End-to-end seconds per run, agent plus integration (and guardian plus undo when main broke): baseline 20.3 s (but 12 runs ended with main still broken); harness 33.3 s.
- Agent spend per arm as reported by the CLI: baseline $1.34; harness $1.58.

### codex · `gpt-6-astra` · 20261027T012919.337462Z · arms: baseline, harness

**Method:** Each run: fresh bare origin and two clones; change A is opened as a PR on laptop A; the agent starts on laptop B; A is approved by simulated humans and merged after the agent's first tool call (fallback 20s); the agent's uncommitted work is committed by the runner; the branch is tested alone, opened as a PR, and integrated: every arm but baseline through the real gate and guardian, baseline through raw Git. Arms: baseline (hooks off); harness; vague (the same hooks deliver a non-specific warning); stop-only (no notes during the task, only the Stop gate); notes-only (notes, no Stop gate). Hooks fetch at most every 5s in this evaluation (default 60s) because the task takes about a minute. Raw evidence per run (agent event stream, stderr, how-made log, branch patch, result JSON): `runs/20261027T012919.337462Z-live-codex-gpt-6-astra/`.

| Outcome | Without (baseline) | With (harness) |
| --- | ---: | ---: |
| Runs | 15 | 15 |
| Main ended broken | 12 | 0 |
| API clashes caught before merge (S1–S3) | 0 of 9 | 9 of 9 (9 by note during the task) |
| Meaning changes undone by the guardian (S4) | 0 of 3 | 3 of 3 |
| False alarms on the control (S5) | 0 | 0 |
| Agent runs that failed or produced nothing | 0 | 0 |
| Extra cost per run versus baseline | – | +2.9 tool calls, +16.2 s wall, +387.5 output tokens |
| Stop-gate blocks | 0 | 0 |

<details><summary>Per-scenario detail</summary>

| Scenario | Arm | Runs | Notes | False notes | Stop blocks | PR-check blocks | Integrated clean | Main broke | Recovered | Healthy at end | Tool calls | Tokens in / out | Wall s | Agent failures |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S1 · rename | baseline | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 4.0 | 66782.7 / 455.0 | 29.6 | 0 |
| S1 · rename | harness | 3 | 3 | 0 | 0 | 0 | 3 | 0 | 0 | 3 | 10.0 | 166931.7 / 1044.7 | 52.7 | 0 |
| S2 · required parameter | baseline | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 4.3 | 66899.0 / 473.0 | 26.5 | 0 |
| S2 · required parameter | harness | 3 | 3 | 0 | 0 | 0 | 3 | 0 | 0 | 3 | 8.0 | 141630.7 / 1280.0 | 57.8 | 0 |
| S3 · module move | baseline | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 4.0 | 67058.7 / 462.0 | 24.8 | 0 |
| S3 · module move | harness | 3 | 3 | 0 | 0 | 0 | 3 | 0 | 0 | 3 | 8.7 | 140602.3 / 949.0 | 48.6 | 0 |
| S4 · dollars → cents (semantic blind spot) | baseline | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 4.0 | 67952.0 / 537.0 | 26.3 | 0 |
| S4 · dollars → cents (semantic blind spot) | harness | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 3 | 3 | 4.0 | 67515.0 / 592.3 | 29.3 | 0 |
| S5 · unrelated change (control) | baseline | 3 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 3 | 4.0 | 67829.0 / 465.0 | 25.9 | 0 |
| S5 · unrelated change (control) | harness | 3 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 3 | 4.0 | 67300.3 / 463.3 | 25.7 | 0 |

</details>

- Baseline: 12/15 merges broke main; 3/15 integrated cleanly.
- Harness: 3/15 merges broke main before recovery; 15/15 finished healthy; 12/15 integrated cleanly; 0 blocked at the PR check; 0 stop-hook blocks; 9 notes delivered, 0 false; the branch's own tests passed before integration in 15/15 harness runs and 15/15 baseline runs.
- Harness cost per run (mean, harness minus baseline): tool calls +2.9, output tokens +387.5, wall seconds +16.2.
- End-to-end seconds per run, agent plus integration (and guardian plus undo when main broke): baseline 32.5 s (but 12 runs ended with main still broken); harness 52.6 s.
- Agent spend per arm as reported by the CLI: baseline n/a (CLI reports no cost); harness n/a (CLI reports no cost).

### claude · `haiku` · 20261027T012148.132778Z · arms: baseline, harness, vague, stop-only, notes-only

**Method:** Each run: fresh bare origin and two clones; change A is opened as a PR on laptop A; the agent starts on laptop B; A is approved by simulated humans and merged after the agent's first tool call (fallback 20s); the agent's uncommitted work is committed by the runner; the branch is tested alone, opened as a PR, and integrated: every arm but baseline through the real gate and guardian, baseline through raw Git. Arms: baseline (hooks off); harness; vague (the same hooks deliver a non-specific warning); stop-only (no notes during the task, only the Stop gate); notes-only (notes, no Stop gate). Hooks fetch at most every 5s in this evaluation (default 60s) because the task takes about a minute. Raw evidence per run (agent event stream, stderr, how-made log, branch patch, result JSON): `runs/20261027T012148.132778Z-live-claude-haiku/`.

| Outcome | Without (baseline) | With (harness) | Vague notes | Stop gate only | Notes only |
| --- | ---: | ---: | ---: | ---: | ---: |
| Runs | 15 | 15 | 15 | 15 | 15 |
| Main ended broken | 12 | 0 | 0 | 0 | 0 |
| API clashes caught before merge (S1–S3) | 0 of 9 | 9 of 9 (4 by note during the task, 5 by stop gate) | 9 of 9 (3 by note during the task, 6 by stop gate) | 9 of 9 (9 by stop gate) | 9 of 9 (7 by note during the task, 2 by PR check) |
| Meaning changes undone by the guardian (S4) | 0 of 3 | 3 of 3 | 3 of 3 | 3 of 3 | 3 of 3 |
| False alarms on the control (S5) | 0 | 0 | 0 | 0 | 0 |
| Agent runs that failed or produced nothing | 0 | 0 | 0 | 0 | 0 |
| Extra cost per run versus baseline | – | +3.5 tool calls, +14.4 s wall, +1839.7 output tokens | +3.3 tool calls, +12.9 s wall, +1614.3 output tokens | +4.0 tool calls, +14.6 s wall, +1819.0 output tokens | +2.6 tool calls, +11.6 s wall, +1455.5 output tokens |
| Stop-gate blocks | 0 | 5 | 6 | 9 | 0 |

<details><summary>Per-scenario detail</summary>

| Scenario | Arm | Runs | Notes | False notes | Stop blocks | PR-check blocks | Integrated clean | Main broke | Recovered | Healthy at end | Tool calls | Tokens in / out | Wall s | Agent failures |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S1 · rename | baseline | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 4.0 | 140236.7 / 1291.0 | 16.7 | 0 |
| S1 · rename | harness | 3 | 3 | 0 | 1 | 0 | 3 | 0 | 0 | 3 | 13.0 | 406029.0 / 5220.3 | 45.5 | 0 |
| S1 · rename | vague | 3 | 3 | 0 | 1 | 0 | 3 | 0 | 0 | 3 | 10.3 | 311531.7 / 4141.7 | 38.5 | 0 |
| S1 · rename | stop-only | 3 | 0 | 0 | 3 | 1 | 2 | 0 | 0 | 3 | 11.0 | 307036.7 / 3986.3 | 35.9 | 0 |
| S1 · rename | notes-only | 3 | 1 | 0 | 0 | 2 | 1 | 0 | 0 | 3 | 6.3 | 186427.0 / 2231.7 | 26.0 | 0 |
| S2 · required parameter | baseline | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 4.3 | 126513.0 / 1228.7 | 13.6 | 0 |
| S2 · required parameter | harness | 3 | 3 | 0 | 3 | 2 | 1 | 0 | 0 | 3 | 9.7 | 287485.7 / 4697.3 | 43.9 | 0 |
| S2 · required parameter | vague | 3 | 3 | 0 | 3 | 0 | 3 | 0 | 0 | 3 | 10.3 | 347213.0 / 4188.3 | 39.0 | 0 |
| S2 · required parameter | stop-only | 3 | 0 | 0 | 3 | 0 | 3 | 0 | 0 | 3 | 11.3 | 349890.0 / 5126.0 | 46.3 | 0 |
| S2 · required parameter | notes-only | 3 | 3 | 0 | 0 | 2 | 1 | 0 | 0 | 3 | 9.7 | 276499.7 / 4481.7 | 36.8 | 0 |
| S3 · module move | baseline | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 5.0 | 151096.3 / 1413.0 | 17.5 | 0 |
| S3 · module move | harness | 3 | 3 | 0 | 1 | 1 | 2 | 0 | 0 | 3 | 9.7 | 284178.0 / 3480.3 | 31.2 | 0 |
| S3 · module move | vague | 3 | 3 | 0 | 2 | 0 | 3 | 0 | 0 | 3 | 10.3 | 319043.7 / 3918.0 | 34.7 | 0 |
| S3 · module move | stop-only | 3 | 0 | 0 | 3 | 1 | 2 | 0 | 0 | 3 | 10.7 | 347906.0 / 3931.3 | 36.9 | 0 |
| S3 · module move | notes-only | 3 | 3 | 0 | 0 | 1 | 2 | 0 | 0 | 3 | 10.3 | 287435.7 / 4449.3 | 38.4 | 0 |
| S4 · dollars → cents (semantic blind spot) | baseline | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 5.7 | 127278.0 / 1576.3 | 14.6 | 0 |
| S4 · dollars → cents (semantic blind spot) | harness | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 3 | 3 | 6.0 | 126970.0 / 1604.3 | 16.5 | 0 |
| S4 · dollars → cents (semantic blind spot) | vague | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 3 | 3 | 5.3 | 105448.3 / 1460.7 | 14.9 | 0 |
| S4 · dollars → cents (semantic blind spot) | stop-only | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 3 | 3 | 5.7 | 118775.7 / 1544.3 | 17.6 | 0 |
| S4 · dollars → cents (semantic blind spot) | notes-only | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 3 | 3 | 6.0 | 129952.0 / 1743.0 | 19.7 | 0 |
| S5 · unrelated change (control) | baseline | 3 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 3 | 5.0 | 140367.7 / 1379.0 | 17.4 | 0 |
| S5 · unrelated change (control) | harness | 3 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 3 | 3.3 | 92810.0 / 1084.0 | 14.9 | 0 |
| S5 · unrelated change (control) | vague | 3 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 3 | 4.3 | 127556.0 / 1250.7 | 16.9 | 0 |
| S5 · unrelated change (control) | stop-only | 3 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 3 | 5.3 | 139020.0 / 1395.0 | 16.1 | 0 |
| S5 · unrelated change (control) | notes-only | 3 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 3 | 4.7 | 150237.7 / 1259.7 | 17.1 | 0 |

</details>

- Baseline: 12/15 merges broke main; 3/15 integrated cleanly.
- Harness: 3/15 merges broke main before recovery; 15/15 finished healthy; 9/15 integrated cleanly; 3 blocked at the PR check; 5 stop-hook blocks; 9 notes delivered, 0 false; the branch's own tests passed before integration in 14/15 harness runs and 15/15 baseline runs.
- Harness cost per run (mean, harness minus baseline): tool calls +3.5, output tokens +1839.7, wall seconds +14.4.
- End-to-end seconds per run, agent plus integration (and guardian plus undo when main broke): baseline 22.8 s (but 12 runs ended with main still broken); harness 40.8 s; vague 39.5 s; stop-only 41.0 s; notes-only 37.7 s.
- Agent spend per arm as reported by the CLI: baseline $0.09; harness $0.13; vague $0.13; stop-only $0.13; notes-only $0.12.

### claude · `haiku` · 20261027T032506.529330Z · arms: harness

**Method:** Each run: fresh bare origin and two clones; change A is opened as a PR on laptop A; the agent starts on laptop B; A is approved by simulated humans and merged after the agent's first tool call (fallback 20s); the agent's uncommitted work is committed by the runner; the branch is tested alone, opened as a PR, and integrated: every arm but baseline through the real gate and guardian, baseline through raw Git. Arms: baseline (hooks off); harness; vague (the same hooks deliver a non-specific warning); stop-only (no notes during the task, only the Stop gate); notes-only (notes, no Stop gate). Hooks fetch at most every 5s in this evaluation (default 60s) because the task takes about a minute. Raw evidence per run (agent event stream, stderr, how-made log, branch patch, result JSON): `runs/20261027T032506.529330Z-live-claude-haiku/`.

| Outcome | With (harness) |
| --- | ---: |
| Runs | 15 |
| Main ended broken | 0 |
| API clashes caught before merge (S1–S3) | 15 of 15 (12 by note during the task, 3 by stop gate) |
| Meaning changes undone by the guardian (S4) | 0 of 0 |
| False alarms on the control (S5) | 0 |
| Agent runs that failed or produced nothing | 0 |
| Extra cost per run versus baseline | – |
| Stop-gate blocks | 3 |

<details><summary>Per-scenario detail</summary>

| Scenario | Arm | Runs | Notes | False notes | Stop blocks | PR-check blocks | Integrated clean | Main broke | Recovered | Healthy at end | Tool calls | Tokens in / out | Wall s | Agent failures |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S1 · rename | harness | 5 | 5 | 0 | 0 | 0 | 5 | 0 | 0 | 5 | 11.0 | 267499.2 / 3017.2 | 32.1 | 0 |
| S2 · required parameter | harness | 5 | 5 | 0 | 0 | 4 | 1 | 0 | 0 | 5 | 7.4 | 229858.2 / 3116.6 | 33.0 | 0 |
| S3 · module move | harness | 5 | 4 | 0 | 3 | 0 | 5 | 0 | 0 | 5 | 8.6 | 250904.4 / 2749.8 | 27.8 | 0 |

</details>

- Harness: 0/15 merges broke main before recovery; 15/15 finished healthy; 11/15 integrated cleanly; 4 blocked at the PR check; 3 stop-hook blocks; 14 notes delivered, 0 false; the branch's own tests passed before integration in 11/15 harness runs and 0/0 baseline runs.
- End-to-end seconds per run, agent plus integration (and guardian plus undo when main broke): harness 39.5 s.
- Agent spend per arm as reported by the CLI: harness $0.13.

## 2. Scripted harness mechanics (deterministic repairs)

Generated 20261027T000034.552688Z; raw evidence: `runs/20261027T000034.552688Z/`.

**Method:** paired scripted changes in fresh local bare origins and two clones. Each branch passes alone. Baseline disables hooks and merges through raw Git. The guarded arm receives actual hook JSON, applies a deterministic repair when instructed, and uses the real PR gate and guardian. These runs measure harness mechanics, not agent behavior.

| Scenario | Arm | Runs | Sync notes | Main breaks before recovery | Recovered | Healthy at end |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| S1 · rename | baseline | 3 | 0 | 3 | 0 | 0 |
| S1 · rename | guarded | 3 | 3 | 0 | 0 | 3 |
| S2 · required parameter | baseline | 3 | 0 | 3 | 0 | 0 |
| S2 · required parameter | guarded | 3 | 3 | 0 | 0 | 3 |
| S3 · module move | baseline | 3 | 0 | 3 | 0 | 0 |
| S3 · module move | guarded | 3 | 3 | 0 | 0 | 3 |
| S4 · dollars → cents (semantic blind spot) | baseline | 3 | 0 | 3 | 0 | 0 |
| S4 · dollars → cents (semantic blind spot) | guarded | 3 | 0 | 3 | 3 | 3 |
| S5 · unrelated change (control) | baseline | 3 | 0 | 0 | 0 | 3 |
| S5 · unrelated change (control) | guarded | 3 | 0 | 0 | 0 | 3 |

- Baseline: 12/15 merges broke main.
- Guarded: 3/15 merges broke main before recovery; 15/15 finished healthy.
- S5 control notes: 0.
- All expected checks passed: True.

## 3. Router, guardian, and breaker

Generated 20261027T021238.282539Z; raw: `runs/20261027T021238.282539Z-policy/summary.json` (labels, paths, reasons).

### Router on 33 hand-labelled diffs

| Case | Paths | Author | Expected | Routed | Risky |
| --- | --- | --- | ---: | ---: | :---: |
| readme edit | README.md | engineer_a | 0 | 0 |  |
| new docs page | docs/guide.md | engineer_a | 0 | 0 |  |
| comment added | users.py | engineer_a | 0 | 0 |  |
| docstring only | users.py | engineer_a | 0 | 0 |  |
| blank-line formatting | account.py | engineer_b | 0 | 0 |  |
| comment by untrusted author | users.py | contractor | 1 | 1 |  |
| new helper function | account.py | engineer_b | 0 | 0 |  |
| behavior change in health() | account.py | engineer_b | 1 | 1 |  |
| additive code by untrusted author | account.py | contractor | 1 | 1 |  |
| additive code that received a sync note | account.py | engineer_b | 1 | 1 |  |
| new module-level constant added | account.py | engineer_b | 0 | 0 |  |
| type hints only | users.py | engineer_a | 0 | 0 |  |
| type hints plus a body change | users.py | engineer_a | 1 | 1 |  |
| new module | catalog.py | engineer_a | 0 | 0 |  |
| new test file only | tests/test_catalog.py | engineer_a | 0 | 0 |  |
| existing test gains an assertion | tests/test_users.py | engineer_a | 1 | 1 |  |
| S1 rename get_user -> fetch_user | tests/test_users.py, users.py | engineer_a | 2 | 2 | yes |
| S2 required parameter added | tests/test_users.py, users.py | engineer_a | 2 | 2 | yes |
| docs plus additive code | README.md, account.py | engineer_a | 0 | 0 |  |
| .gitignore edit | .gitignore | engineer_a | 1 | 1 |  |
| pyproject edit | pyproject.toml | engineer_a | 1 | 1 |  |
| S4 payments units change | payments/charge.py, tests/test_charge.py | engineer_a | 2 | 2 | yes |
| payments comment only | payments/charge.py | engineer_a | 2 | 2 |  |
| policy adds a trusted author | .mergeguard/policy.yaml | engineer_b | 2 | 2 | yes |
| new workflow | .github/workflows/deploy.yml | engineer_a | 2 | 2 | yes |
| codex hooks edit | .codex/hooks.json | engineer_a | 2 | 2 | yes |
| claude settings edit | .claude/settings.json | engineer_a | 2 | 2 | yes |
| test file deleted | tests/test_charge.py | engineer_a | 2 | 2 | yes |
| test assertion removed | tests/test_charge.py | engineer_a | 2 | 2 | yes |
| docs-only but a sync note was received | README.md | engineer_a | 1 | 1 |  |
| payments change with a clean how-made claim | payments/charge.py | engineer_a | 2 | 2 | yes |
| payments comment by untrusted author | payments/charge.py | contractor | 2 | 2 |  |
| S3 move users.py into a package | accounts/__init__.py, accounts/users.py, tests/test_users.py, users.py | engineer_a | 2 | 2 | yes |

- Exact tier matches: 33/33.
- Risky PRs placed below their label: 0/11 (must be 0).
- Any PR placed below its label: 0; above its label: 0.
- Humans needed: tier 0 for 11 PRs (33% need no human), tier 1 for 9, tier 2 for 13. Against a flat one-reviewer rule, 11 PRs need fewer humans and 13 need more.

### Guardian

- Scripted S4 runs (3): culprit named correctly 3/3 (the merge commit of PR #2), partner named correctly 3/3 (PR #1), undo PR opened 3/3, recovered 3/3; mean 23.2 s per run including setup.
- `pytest tests/test_guardian.py`: 4 passed in 21.07s (semantic clash with both PRs and validated undo; flaky test stops before blame; missing historical test file passes while a collection error does not; a direct bug is not called a clash).

### Breaker on a synthetic ledger timeline

- Day 1, one incident on `payments/`: floor None; day 4, second incident within the 7-day window: floor 2.
- Day 18, 14-day cooldown complete: `cooldown_complete` is True, floor still 2; day 60: floor still 2; `automatic_loosening` is False.
- Suggestions on day 22: ./: 21 clean merges and zero strikes in 30 days; consider a human-reviewed lower floor.; payments/: cooldown complete; a human may approve a breaker.resets policy timestamp on main..
- After a human-reviewed `breaker.resets` timestamp on main (day 19): floor on day 20 is None.
- `pytest tests/test_ledger_breaker.py`: 5 passed in 0.33s.

### Guardian on realistic histories

Generated 20261027T012137.324709Z; raw: `runs/20261027T012137.324709Z-guardian/`. Each run builds a fresh world, merges A's dollars-to-cents change, then 20-50 harmless reviewed PRs (docs and new modules) around the event under test, and asks the guardian to explain the failure between the initial commit and the head of main. The flaky test is real: it fails on every odd run and passes on every even run.

| Variant | Runs | Main commits | Outcomes | Culprit named | Partner named | Undo opened | Flaky excluded, nobody wrongly blamed | Wrong blame | Bisect steps | Seconds to report |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| clash | 5 | 26–42 | clash 5 | 5 | 5 | 5 | 0 | 0 | 4.0 | 7.8 |
| flaky | 5 | 26–42 | flaky 2, healthy 3 | 0 | 0 | 0 | 5 | 0 | 0.0 | 0.5 |
| clash+flaky | 5 | 27–43 | clash 5 | 5 | 5 | 5 | 2 | 0 | 3.8 | 6.7 |

For `flaky`, 'healthy' means the flaky test happened to pass at discovery, so there was nothing to investigate; for `clash+flaky`, the flaky column counts runs where the flaky test failed at discovery, was excluded, and the real culprit was still named. Nobody is blamed for a flaky test in any run.

### Review load on real agent-made PRs

Generated 20261027T033203.477135Z; raw: `runs/20261027T033203.477135Z-review/summary.json`. Every task-B PR from the live evaluations, re-routed with the current router under the demo policy (additive-only code may merge with no human). A PR 'merges with no human' only when it is tier 0 and its sync check is clean; CI must also be green.

| PRs | Need no human | Need one | Need two | Could merge with no human now | Tier 0 but stale (blocked at PR check) | Approvals, flat one-reviewer rule | Approvals, routed |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 302 | 193 | 86 | 23 | 118 | 75 | 302 | 132 |

- Of the 118 no-human merges, 57 broke main (the S4 meaning change, invisible to the gate); 33 were undone by the guardian.

| Scenario | Arm | PRs | Tier 0 | Tier 1 | Tier 2 | Why not tier 0 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| S1 · rename | baseline | 25 | 25 | 0 | 0 |  |
| S1 · rename | harness | 30 | 0 | 24 | 6 | Existing tests modified: tests/test_users.py; How-made: agent received a specific sync note |
| S1 · rename | notes-only | 3 | 2 | 1 | 0 | How-made: agent received a specific sync note |
| S1 · rename | stop-only | 3 | 1 | 1 | 1 | Existing tests modified: tests/test_users.py; How-made: 3 recorded test attempts |
| S1 · rename | vague | 3 | 0 | 3 | 0 | How-made: agent received a specific sync note |
| S2 · required parameter | baseline | 24 | 24 | 0 | 0 |  |
| S2 · required parameter | harness | 29 | 0 | 22 | 7 | Existing tests modified: tests/test_users.py; How-made: agent received a specific sync note |
| S2 · required parameter | notes-only | 3 | 0 | 2 | 1 | Existing tests modified: tests/test_users.py; How-made: agent received a specific sync note |
| S2 · required parameter | stop-only | 3 | 0 | 1 | 2 | Existing tests modified: tests/test_users.py; How-made: 3 recorded test attempts |
| S2 · required parameter | vague | 3 | 0 | 2 | 1 | Existing tests modified: tests/test_users.py; How-made: agent received a specific sync note |
| S3 · module move | baseline | 24 | 24 | 0 | 0 |  |
| S3 · module move | harness | 29 | 1 | 23 | 5 | Existing tests modified: tests/test_users.py; How-made: agent received a specific sync note; account.py changes executable code or has no comment-only proof |
| S3 · module move | notes-only | 3 | 0 | 3 | 0 | How-made: agent received a specific sync note |
| S3 · module move | stop-only | 3 | 2 | 1 | 0 | How-made: 4 recorded test attempts |
| S3 · module move | vague | 3 | 0 | 3 | 0 | How-made: agent received a specific sync note |
| S4 · dollars → cents (semantic blind spot) | baseline | 24 | 24 | 0 | 0 |  |
| S4 · dollars → cents (semantic blind spot) | harness | 24 | 24 | 0 | 0 |  |
| S4 · dollars → cents (semantic blind spot) | notes-only | 3 | 3 | 0 | 0 |  |
| S4 · dollars → cents (semantic blind spot) | stop-only | 3 | 3 | 0 | 0 |  |
| S4 · dollars → cents (semantic blind spot) | vague | 3 | 3 | 0 | 0 |  |
| S5 · unrelated change (control) | baseline | 24 | 24 | 0 | 0 |  |
| S5 · unrelated change (control) | harness | 24 | 24 | 0 | 0 |  |
| S5 · unrelated change (control) | notes-only | 3 | 3 | 0 | 0 |  |
| S5 · unrelated change (control) | stop-only | 3 | 3 | 0 | 0 |  |
| S5 · unrelated change (control) | vague | 3 | 3 | 0 | 0 |  |

### Sync check at scale: precision, recall, latency

Generated 20261027T034537.845817Z; raw: `runs/20261027T034537.845817Z-scale/summary.json`. Synthetic packages with known ground truth; 3 trials per (change kind, use kind) pair. Explicit uses are from-imports, module-attribute calls and aliased imports; the blind spots (getattr dispatch, a method on an object of unknown type) are reported separately and are documented limits, not bugs.

| Modules | Symbols | Trials | Precision | Recall (explicit uses) | False positives / clean trials | Blind spots caught | Check mean / p95 ms | Hook cached mean ms | Hook with fetch ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 80 | 144 | 1.0 | 1.0 | 0 / 54 | 0 / 36 | 162.7 / 178.9 | 111.2 | 148.0 |
| 50 | 400 | 144 | 1.0 | 1.0 | 0 / 54 | 0 / 36 | 167.0 / 188.0 | 112.2 | 153.6 |
| 200 | 1600 | 144 | 1.0 | 1.0 | 0 / 54 | 0 / 36 | 168.9 / 194.8 | 115.4 | 159.8 |

Recall by change kind at the largest size: add_required_param 9/9, move 9/9, remove 9/9, remove_param 9/9, rename 9/9, reorder_params 9/9.

### Guardian limits: probabilistic flaky tests, long histories, non-monotonic clash, ordinary defect

Generated 20261027T014813.106584Z; raw: `runs/20261027T014813.106584Z-guardian-limits/`. The flaky test fails with probability p on each run (reproducible per run number). The non-monotonic case puts cents, then dollars, then cents on main before the clash lands, so the partner search's monotonicity assumption does not hold.

| Variant | Runs | Main commits | Outcome counts | Culprit named | Wrong blame | Bisect steps | Seconds |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| flaky p=0.1 | 6 | 25–41 | healthy 6 | 0 | 0 | 0.0 | 0.5 |
| flaky p=0.3 | 6 | 25–41 | flaky 2, healthy 4 | 0 | 0 | 0.0 | 0.7 |
| flaky p=0.5 | 6 | 25–41 | flaky 4, healthy 2 | 0 | 0 | 0.0 | 0.6 |
| clash+flaky p=0.3 | 6 | 26–42 | clash 6 | 6 | 0 | 3.8 | 5.7 |
| long history clash | 3 | 176–193 | clash 3 | 3 | 0 | 6.0 | 11.4 |
| non-monotonic clash | 3 | 26–29 | clash 3 | 3 | 0 | n/a | 5.0 |
| ordinary defect, long history | 3 | 71–107 | culprit 3 | 3 | 0 | 5.3 | 7.9 |

- Non-monotonic clash: partner reported as the latest re-apply PR in 3 runs, as the first cents PR in 0, unresolved in 0. The search returns a transition point under its documented assumption; which transition it returns is not guaranteed.
- Ordinary defect: culprit named 3/3, no partner claimed in 3/3, undo opened 3/3.

### Review routing on a realistic task mix · claude `haiku` · 20261027T021725.444836Z · re-routed with the router at `c00992f`

Raw: `runs/20261027T021725.444836Z-taskmix-claude-haiku/`. Twenty typical small tasks done by a real agent in a fresh world with no concurrent change, committed by the runner, opened as PRs through the real router and CI. 'Desired' is the tier a careful reviewer would want; routing below it is an under-review (must be 0 for risky tasks), routing above it is where the rules are stricter than a human.

| PRs | No human | One | Two | Under-reviewed | Risky under-reviewed | Over-reviewed | Approvals flat → routed | Failed runs | No-change runs |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 38 | 20 | 4 | 14 | 0 | 0 | 2 | 38 → 32 | 0 | 2 |

| Task | Category | Desired | Routed | Why (first reason) |
| --- | --- | ---: | ---: | --- |
| readme-section | docs | 0 | 0, 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| changelog | docs | 0 | 0, 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| module-docstring | docstring | 0 | 0, 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| comment | comment | 0 | 0, 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| new-test-file | new test | 0 | 0, 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| additive-function | additive code | 0 | 0, 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| additive-account | additive code | 0 | 0, 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| type-hints | annotations only | 0 | 0, 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| constant | new constant | 0 | 0, 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| parametrized-test | new test | 0 | 0, 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| behavior-change | behavior change | 1 | 1, 1 | account.py changes executable code or has no comment-only proof |
| optional-param | optional parameter | 1 | 2, 2 (over) | Existing tests modified: tests/test_users.py |
| edit-existing-test | existing test edited | 1 | 1, 1 | Existing tests modified: tests/test_users.py |
| payments-docstring | protected path | 2 | 2, 2 | payments/charge.py is protected by an always-two rule |
| payments-refund | protected path | 2 | 2, 2 | payments/charge.py is protected by an always-two rule |
| payments-logging | protected path | 2 | 2, 2 | payments/charge.py is protected by an always-two rule |
| rename | API break | 2 | 2, 2 | Existing tests modified: tests/test_users.py |
| required-param | API break | 2 | 2, 2 | Existing tests modified: tests/test_users.py |
| delete-test | test deleted | 2 | 2, 2 | Existing tests modified: tests/test_charge.py |

### Review routing on a realistic task mix · claude `sonnet` · 20261027T021734.879043Z · re-routed with the router at `c00992f`

Raw: `runs/20261027T021734.879043Z-taskmix-claude-sonnet/`. Twenty typical small tasks done by a real agent in a fresh world with no concurrent change, committed by the runner, opened as PRs through the real router and CI. 'Desired' is the tier a careful reviewer would want; routing below it is an under-review (must be 0 for risky tasks), routing above it is where the rules are stricter than a human.

| PRs | No human | One | Two | Under-reviewed | Risky under-reviewed | Over-reviewed | Approvals flat → routed | Failed runs | No-change runs |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 19 | 10 | 2 | 7 | 0 | 0 | 1 | 19 → 16 | 0 | 1 |

| Task | Category | Desired | Routed | Why (first reason) |
| --- | --- | ---: | ---: | --- |
| readme-section | docs | 0 | 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| changelog | docs | 0 | 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| module-docstring | docstring | 0 | 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| comment | comment | 0 | 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| new-test-file | new test | 0 | 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| additive-function | additive code | 0 | 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| additive-account | additive code | 0 | 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| type-hints | annotations only | 0 | 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| constant | new constant | 0 | 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| parametrized-test | new test | 0 | 0 | Trusted author; every changed file is documentation, AST-equivalent, docstring-only, or additive-only |
| behavior-change | behavior change | 1 | 1 | account.py changes executable code or has no comment-only proof |
| optional-param | optional parameter | 1 | 2 (over) | Existing tests modified: tests/test_users.py |
| edit-existing-test | existing test edited | 1 | 1 | Existing tests modified: tests/test_users.py |
| payments-docstring | protected path | 2 | 2 | payments/charge.py is protected by an always-two rule |
| payments-refund | protected path | 2 | 2 | payments/charge.py is protected by an always-two rule |
| payments-logging | protected path | 2 | 2 | payments/charge.py is protected by an always-two rule |
| rename | API break | 2 | 2 | Existing tests modified: tests/test_users.py |
| required-param | API break | 2 | 2 | Existing tests modified: tests/test_users.py |
| delete-test | test deleted | 2 | 2 | Existing tests modified: tests/test_charge.py |

## What didn't work

- claude `haiku`: 0 false notes (S5); 12 runs where a note was delivered but the PR check still had to block; 16 runs where the stop hook had to block; 0 failed agent runs; 0 runner crashes; 264/264 command events arrived without an exit code; 0 runs merged A on the timeout fallback rather than after an observed agent action.
  - S2-harness-1 note ignored: Merge blocked: CI is not green on 6b680f35 (fail): tests/test_account.py::test_account_summary
  - S2-harness-2 note ignored: Merge blocked: While you were working, main changed: `users.get_user` changed signature: missing required argument: org_id in commit aa8e9518. Your code uses it at account.py:9. Update the call to mat
  - S1-harness-4 note ignored: Merge blocked: CI is not green on a9780ac0 (error): 1 error in 0.05s
  - S3-harness-4 note ignored: Merge blocked: CI is not green on fa16fe0f (error): 1 error in 0.05s
  - S2-harness-5 note ignored: Merge blocked: While you were working, main changed: `users.get_user` changed signature: missing required argument: org_id in commit ce4009da. Your code uses it at account.py:9. Update the call to mat
  - S3-harness-5 note ignored: Merge blocked: While you were working, main changed: `users.get_user` was moved to `accounts.users.get_user` in commit a0840f56. Your code uses it at account.py:9. Update the import and calls to use `
  - S2-harness-6 note ignored: Merge blocked: While you were working, main changed: `users.get_user` changed signature: missing required argument: org_id in commit f7862ee5. Your code uses it at account.py:9. Update the call to mat
  - S2-harness-7 note ignored: Merge blocked: While you were working, main changed: `users.get_user` changed signature: missing required argument: org_id in commit 5441bc22. Your code uses it at account.py:9. Update the call to mat
  - S3-harness-7 note ignored: Merge blocked: CI is not green on be3e6b6e (error): 1 error in 0.09s
  - S2-harness-8 note ignored: Merge blocked: While you were working, main changed: `users.get_user` changed signature: missing required argument: org_id in commit b0beb203. Your code uses it at account.py:9. Update the call to mat
  - S1-harness-9 note ignored: Merge blocked: While you were working, main changed: `users.get_user` was renamed to `users.fetch_user` in commit 27ca596c. Your code uses it at account.py:9. Update the import and calls to use `users
  - S3-harness-10 note ignored: Merge blocked: CI is not green on 1484a8bd (error): 1 error in 0.06s
- claude `sonnet`: 0 false notes (S5); 0 runs where a note was delivered but the PR check still had to block; 5 runs where the stop hook had to block; 0 failed agent runs; 0 runner crashes; 63/63 command events arrived without an exit code; 0 runs merged A on the timeout fallback rather than after an observed agent action.
- codex `gpt-6-astra`: 0 false notes (S5); 0 runs where a note was delivered but the PR check still had to block; 0 runs where the stop hook had to block; 0 failed agent runs; 0 runner crashes; 89/89 command events arrived without an exit code; 0 runs merged A on the timeout fallback rather than after an observed agent action.
- claude `haiku`: 0 false notes (S5); 3 runs where a note was delivered but the PR check still had to block; 20 runs where the stop hook had to block; 0 failed agent runs; 0 runner crashes; 318/318 command events arrived without an exit code; 0 runs merged A on the timeout fallback rather than after an observed agent action.
  - S2-harness-2 note ignored: Merge blocked: While you were working, main changed: `users.get_user` changed signature: missing required argument: org_id in commit 96069605. Your code uses it at account.py:9. Update the call to mat
  - S3-harness-2 note ignored: Merge blocked: CI is not green on 385d441c (error): 1 error in 0.05s
  - S2-harness-3 note ignored: Merge blocked: While you were working, main changed: `users.get_user` changed signature: missing required argument: org_id in commit e3102e16. Your code uses it at account.py:9. Update the call to mat
- claude `haiku`: 0 false notes (S5); 4 runs where a note was delivered but the PR check still had to block; 3 runs where the stop hook had to block; 0 failed agent runs; 0 runner crashes; 84/84 command events arrived without an exit code; 0 runs merged A on the timeout fallback rather than after an observed agent action.
  - S2-harness-1 note ignored: Merge blocked: CI is not green on 0de24d30 (fail): tests/test_account.py::test_account_summary
  - S2-harness-2 note ignored: Merge blocked: CI is not green on cc512976 (fail): tests/test_account.py::test_account_summary
  - S2-harness-4 note ignored: Merge blocked: CI is not green on 04f95f53 (fail): tests/test_account.py::test_account_summary
  - S2-harness-5 note ignored: Merge blocked: CI is not green on 97f7eb61 (fail): tests/test_account.py::test_account_summary
- Guardian on realistic histories (15 runs): 0 wrong blames; 0 runs where a flaky test hid a real clash; 0 inconclusive.
- Scripted S4 (meaning change): 3 of 3 guarded runs broke main before the guardian recovered it. The sync check cannot see unit changes behind an unchanged signature, by design.
- Neither Codex 0.154 nor Claude Code 2.1 includes an exit status in the PostToolUse payload for shell commands, so the how-made log records `exit_code: null` unless the agent uses the `mergeguard run` receipt wrapper.
- Codex requires each project hook definition to be trusted by hash. The evaluation passes that trust per invocation as a `-c hooks.state` override computed from the hook file, which never modifies the user's `~/.codex` config; the blanket `--dangerously-bypass-hook-trust` flag was not used.
- The ChatGPT Codex usage limit was exhausted mid-session on 2026-10-27, so the Codex arm was run after the reset and Claude Code ran the earlier live arms; any missing Codex table above means its runs did not complete.

## Limits

Repeated runs check reproducibility of a small, hand-selected scenario set; they are not a statistical estimate of production accuracy or false-positive rate. Live runs depend on model behavior and provider availability on the day they ran. The scripted S4 arm always breaks main before recovery because the semantic change is invisible to the sync check. Hook timings include process startup and the first local fetch.
