# 45-minute technical interview demo

Use a terminal with the tool's `.venv` activated. Generate fresh worlds before presenting. Keep the HTML report and evaluation results ready for offline fallback.

| Minutes | Show | Point to make |
| --- | --- | --- |
| 0–5 | Persona and rename example | Parallel agents can each pass while their merged result fails. |
| 5–12 | `prevent` demo | A concrete symbol-level note beats a vague coordination warning. |
| 12–19 | Router and PR evidence | Spend human attention according to diff proof and risk. |
| 19–29 | `recover` demo | Be explicit about semantic limits; recover using reproducible evidence. |
| 29–34 | `learn` report | Two distinct incidents raise a folder's review floor. |
| 34–39 | Paired evaluation | Scripted mechanics are measurable; model efficacy is a separate question. |
| 39–45 | Trade-offs and questions | Trust boundary, fail-open hooks, CI backstop, and next steps. |

## Act 1: prevent the stale rename

```bash
./demo/run_demo.sh act1 ../interview-prevent
```

Read the note out loud: old function → new function, exact file/line, commit, repair, rerun tests. The first simulated PR is blocked even after a human approval; the repaired branch merges only after a fresh approval. Both branch tests and merged-main tests pass. Inspect the how-made note in the report.

For the live version, run `./demo/run_demo.sh live ../interview-live --agent claude` (or `codex`) before the interview and follow the printed steps: start the agent on laptop B, merge A from a second terminal, watch the note arrive. Keep the deterministic act ready as a fallback. Live numbers are in `eval/results.md` section 1.

## Act 2: route review

```bash
./demo/run_demo.sh act2 ../interview-review
```

Show `tests/test_router.py` and the report evidence. A Python comment edit gets tier 0 only because AST equality proves the executable structure is unchanged. A docstring-only edit is labelled separately. An ordinary code change gets one human. Payments, policy, workflows, hook files, removed assertions, and any proven public API break (rename, move, removed symbol, required parameter) get two.

Show that author-written text cannot lower the diff result, a new head invalidates approvals, a bot is excluded, and main's policy is reread at merge. Explain that the offline approver names stand in for a real authenticated platform.

## Act 3: admit the blind spot and recover

```bash
./demo/run_demo.sh act3 ../interview-recover
```

The amounts move from dollars to cents with the same callable name/signature. Sync is clean and main breaks. Show `guardian.json`: failing test IDs; three bad/good repetitions; first-parent bisect log; passing culprit branch; identified partner PR; whole-suite validation on the undo. The script explicitly simulates human approval of the undo.

Do not say the guardian fixed the application. It safely removed the offending change and preserved an incident record; a permanent fix remains a human task.

## Act 4: learn from two real incidents

```bash
./demo/run_demo.sh act4 ../interview-learn
```

The second unit-contract clash raises `invoices/` and `tests/` to tier 2. Culprit + revert count once. Explain that elapsed cooldown only makes a human-reviewed reset eligible; it does not silently relax policy.

## Evaluation and discussion

Open `eval/results.md` and one raw S4 guarded JSON file. Baseline hooks are disabled and merges use raw Git. Guarded runs use the real gate and scripted note-driven repairs. S4 still breaks before recovery; S5 emits no notes. Avoid presenting deterministic repeatability as a statistical estimate of production accuracy.

Suggested discussion: add authenticated GitHub reviews/statuses and branch protection, retain CI evidence immutably, improve Python resolution, test non-monotonic partner histories, and run randomized live-agent trials. A boxed-in model could only raise risk, never grant a lower tier.
