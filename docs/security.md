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

- **Tamper detection in the verifier.** JUnit reports for hidden tests must match the statically discovered
  hidden test inventory; application/test code may not reference `sys.argv`, `os._exit` or verifier artifact names
  (`forbidden_names` rule, aliases resolved); bound blocking invariants fail closed when their hidden test is
  missing; implementer commands that reference protected artifacts are flagged for human review; a later
  `intentos verify` can revoke REVIEW_READY but never upgrade a state.

## Known gaps (do not deploy without addressing)

- No container/VM isolation: `pytest` executes the candidate's code and any `conftest.py` with host privileges. A
  determined adversarial implementer could still forge results from inside the process (e.g. by enumerating hidden
  test names); the checks above raise the bar, they do not close it.
- The Codex read-only sandbox allows reading the whole filesystem, so hidden tests and policies are *readable* by the
  live implementer (only detected, not prevented).
- Network is not blocked during verification (only statically forbidden via architecture rules).
- The Codex sandbox (`workspace-write`, network disabled) is a control, not a guarantee; an escape would land in the
  host user's permissions.
- Symlink escapes inside a worktree are not exhaustively checked when copying the snapshot.
- Repository `pyproject.toml`/`conftest.py` can influence pytest; `-c`-less invocation keeps `pythonpath` explicit but
  does not neutralize plugins declared by the repo.

## Threat model (summary)

| Threat | Mitigation now | Production need |
|---|---|---|
| Prompt injection via repo text/docs | evidence is quoted as data; authority comes from trusted policy, not text | model-side hardening, content provenance labels |
| Malicious tests/scripts in repo | fixture-only usage; protected hidden tests | ephemeral container per run, no secrets in runner |
| Model edits verifier/policy/tests to pass | protected paths, scope check, hash, hidden tests outside worktree | immutable storage, signed policies |
| Stale organizational policy | `superseded`/`conflicted` statuses, conflict detector, human approval for decisions | policy ownership + review cadence |
| Data exfiltration | network off in Codex threads, redaction | egress controls, audit retention |
| Validator tampering | verifier runs in orchestrator, not in the agent thread | separate privilege domain / service |
