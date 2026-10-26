# Security and deployment judgment

**This prototype is not production-safe for untrusted repositories.** It runs candidate code (pytest) on the host
and relies on Git worktrees plus the Codex sandbox for isolation. Use it on trusted fixtures or your own repos.

## What is enforced today

- **Base branch never changes.** Implementation happens in `git worktree add --detach <base-sha>` under
  `.intentos/worktrees/<run-id>`; the verifier checks the worktree HEAD still equals the base SHA.
- **Protected ground truth.** Policies (`policies/`), hidden tests (`benchmarks/hidden_tests/`), verifier code and
  run artifacts (`.intentos/`) live outside the worktree. Hidden tests are copied into a *snapshot* of the worktree
  only at verification time. The contract compiler rejects any attempt to make protected globs writable; the scope
  check blocks edits to protected or out-of-allowlist paths after the fact.
- **Trusted commands only.** Verification commands are `command_id → argv` entries in the policy file; model output
  can only reference IDs. Builtins (architecture rules, scope, counterexamples) are code, not shell.
- **No repository text in shell.** Prompts are data passed to the SDK; argv placeholders are limited to interpreter,
  snapshot dir, hidden-tests dir and JUnit path.
- **Path hygiene.** Globs must be relative, traversal-free; realpath containment helpers exist for worktree checks.
- **Secrets.** Indexer skips `.env`-like basenames and only reads tracked files (gitignored files are never
  indexed); events, prompts and reports pass through a redaction filter (API keys, bearer tokens, JWTs, URL creds).
- **Budgets.** Per-turn Codex timeout (`INTENTOS_CODEX_TIMEOUT_MS`), whole-run wall budget
  (`INTENTOS_RUN_TIMEOUT_MS`), repairs capped at min(contract.max_repairs, 2), planner retries capped at 1.
- **Tamper evidence.** `contract_hash` is persisted with the run; `verify`/`resume` recompute it from the stored
  contract and the run-dir copy before trusting either.
- **Model claims are inert.** The implementer's final message is stored for inspection only; status derives
  exclusively from executed checks (tested: a fake "all tests pass" message does not change the outcome).
- **Proposed memory cannot bind.** Reviewer feedback and model proposals carry `model_inference` authority and are
  excluded from blocking enforcement until a human approves them.
- **Architectural-surprise signals are advisory.** The `architecture_surprise` builtin only reads sources (snapshot
  and base revision via `git cat-file`); it never executes candidate code and its findings are review-only, so they
  can route a run to `HUMAN_REVIEW` but never pass or fail it on their own.

- **Tamper detection in the verifier.** JUnit reports for hidden tests must match the statically discovered
  hidden test inventory; application/test code may not reference `sys.argv`, `os._exit` or verifier artifact names
  (`forbidden_names` rule, aliases resolved); bound blocking invariants fail closed when their hidden test is
  missing; implementer commands that reference protected artifacts are flagged for human review; a later
  `intentos verify` can revoke REVIEW_READY but never upgrade a state.

## Container-isolated verification (`INTENTOS_VERIFIER=docker`)

With `INTENTOS_VERIFIER=docker` every trusted command that *executes* candidate code (project suite, hidden task and
invariant tests, counterexample probes) runs in the `intentos-verifier:0.1` image (`docker/verifier/Dockerfile`,
built with `npm run verifier:image`): the verification snapshot is bind-mounted read-only at `/work/snapshot`, the
attempt directory is mounted read-write at `/work/results` for JUnit output only, `--network none`, `--read-only`
root filesystem with a 256 MB tmpfs `/tmp`, `--cpus` / `--memory` / `--pids-limit 256`, `--cap-drop ALL`,
`--security-opt no-new-privileges`, and the policy `timeout_s` followed by `docker kill`. The host argv from the
policy is translated to container paths (`{python}` → `python`, snapshot, hidden tests, JUnit) and the verifier refuses
to run any command that still references a host path. Static builtins (scope check, architecture rules) keep running
on the host because they do not execute candidate code. If the daemon or the image is unavailable the verifier
**fails closed**: every blocking executing command gets a `VERIFIER-UNAVAILABLE` blocking finding, nothing runs on the
host, and the run ends `FAILED`. `environment.json` and `verification.json` record `verifier: {mode, image,
image_digest}`. Default mode stays `host`.

What the container does **not** isolate: the host kernel is shared (only Docker's default seccomp/AppArmor profile
applies); Docker Desktop on macOS runs containers in a Linux VM whose kernel lists unused tunnel devices in
`/sys/class/net` (they carry no connectivity — the test suite checks link state and an outbound connect instead); and
the results mount means candidate code can still write a forged JUnit file, so the hidden-test inventory cross-check
and the `forbidden_names` rule remain the defence there.

## Known gaps (do not deploy without addressing)

- No isolation by default: in `host` mode `pytest` executes the candidate's code and any `conftest.py` with host
  privileges. A determined adversarial implementer could still forge results from inside the process (e.g. by
  enumerating hidden test names); the checks above raise the bar, they do not close it. `INTENTOS_VERIFIER=docker`
  (above) removes host execution but not the forged-report vector.
- The Codex read-only sandbox allows reading the whole filesystem, so hidden tests and policies are *readable* by the
  live implementer (only detected, not prevented).
- In `host` mode network is not blocked during verification (only statically forbidden via architecture rules);
  `docker` mode runs commands with `--network none`.
- The Codex sandbox (`workspace-write`, network disabled) is a control, not a guarantee; an escape would land in the
  host user's permissions.
- Symlink escapes inside a worktree are not exhaustively checked when copying the snapshot.
- Repository `pyproject.toml`/`conftest.py` can influence pytest; `-c`-less invocation keeps `pythonpath` explicit but
  does not neutralize plugins declared by the repo.

## Threat model (summary)

| Threat | Mitigation now | Production need |
|---|---|---|
| Prompt injection via repo text/docs | evidence is quoted as data; authority comes from trusted policy, not text | model-side hardening, content provenance labels |
| Malicious tests/scripts in repo | fixture-only usage; protected hidden tests; optional container verifier (`INTENTOS_VERIFIER=docker`: read-only snapshot, no network, limits) | ephemeral container per run with gVisor/VM-grade isolation, no secrets in runner |
| Model edits verifier/policy/tests to pass | protected paths, scope check, hash, hidden tests outside worktree | immutable storage, signed policies |
| Stale organizational policy | `superseded`/`conflicted` statuses, conflict detector, human approval for decisions | policy ownership + review cadence |
| Data exfiltration | network off in Codex threads, redaction | egress controls, audit retention |
| Validator tampering | verifier runs in orchestrator, not in the agent thread | separate privilege domain / service |
