# Benchmarks

`tasks.json` defines the four demonstration tasks (A–D) on the `startup_billing` fixture, each with:
hidden acceptance tests (authored before any implementation, stored outside the implementer's writable
area), the hazards the task is meant to expose, the expected route (implement / clarify / abstain), and,
for Task A, two recorded patches: a compliant one and one that passes the narrow task test while bypassing
`DiscountPolicy` and importing `decimal` into the API layer.

```bash
# Offline: replay recorded patches through the full pipeline + real verifier (simulated orchestration)
node --disable-warning=ExperimentalWarning benchmarks/evaluate.ts --offline

# Live (requires Codex credentials AND an account that can start a session):
node --disable-warning=ExperimentalWarning benchmarks/evaluate.ts --mode full
node --disable-warning=ExperimentalWarning benchmarks/evaluate.ts --mode baseline   # Codex with task text only; same verifier
```

Outputs go to `.intentos/benchmarks/<timestamp>/results.{json,md}`. Every metric is derived from the
run's persisted `verification.json` / `metrics.json`; nothing is estimated. Baseline rows that beat the
full pipeline are reported as-is.

Fairness notes (spec §11.3/§13.1): both variants share the task text, base commit, allowed paths, verifier
and hidden tests; the baseline prompt is the bare task plus "run pytest", with no restrictions beyond the
sandbox. Hidden tests are never visible to either implementer.
