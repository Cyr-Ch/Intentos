# IntentOS work log (2026-10-25 → 2026-10-26)

Everything built so far, where it lives, and how it was verified. Commit ids refer to https://github.com/Cyr-Ch/Intentos.

## 1. Local build session (laptop, 2026-10-25) — on `main`

| Commit | What | Verification |
|---|---|---|
| 8bd373b | M1–M5 vertical slice: SQLite world model, Python AST/git indexer, trusted policy binding, lexical+graph retrieval, Zod contract + deterministic compiler, Codex SDK adapter (read-only planner / workspace-write implementer) + labelled offline engine, worktree isolation, 3-track verifier (hidden tests, AST architecture rules, scope/frozen paths, counterexample probes), bounded repair, reports, decisions memory, benchmark runner, fixture repo with 7-commit history | vitest 49, pytest 6, typecheck; live Codex runs A (REVIEW_READY), B (REVIEW_READY after 1 repair), C (clarify), D (abstain), 1 baseline |
| bcfdddf | Live-run records, SDK reconnect tolerance, accepted routes for benchmarks | same |
| 79eaa0c | Node ≥ 22.6 guard, required task text, `docs/cloud-handoff.md` | CLI exit-code checks |
| 9212e0c | Verifier hardening after an independent audit: hidden-test inventory cross-check against forged JUnit, `forbidden_names` rule (ARCH-006, alias-aware), fail-closed invariants, `NO-ACCEPTANCE-TESTS` review finding, revocable REVIEW_READY via `verify`, protected-artifact access detection | vitest 58, pytest 7 |
| ff8b9ef | Snapshot import by the repository owner of the zip of 1957964 (identical tree to the first commit of PR #1) | — |

## 2. PR #1 `retrieval-httpx` (laptop, 2026-10-26) — open, mergeable

| Commit | What | Verification |
|---|---|---|
| 1957964 | External-repo validation on encode/httpx: unique node ids (accessors, repeated headings), IDF-weighted retrieval with constructor-signature scoring and decision boost, offline planner derives allowed paths, compiler rejects catch-all globs | vitest 58, pytest 7; httpx indexed in 0.9 s |
| d921f8d | docs: httpx validation, sleep caveat for live benchmarks | — |
| 2d32dc1 | Behaviour-driven Task B hidden test; planner-free vanilla baseline with identical verifier | both existing Task B worktrees pass the new test |
| be5e95c | Clean live matrix, full vs vanilla baseline, tasks A–D (`docs/evaluation.md`) | 8 live runs, 1 per cell |

## 3. Cloud session (Anthropic cloud, routine `trig_01LgNzesiWwuyTQ8k61NCnDP`, session `session_01Ro1JiJEVfAwddGZM9YeUjs`, 2026-10-26 09:30–09:55 UTC, model claude-opus-5-5)

Branch `cloud/2026-10-26-m4-m6`: 5 commits on top of 9212e0c. **Not on GitHub**: every push was refused because the
claude.ai GitHub connector is signed in as `leonvol`, which has no write access to `Cyr-Ch/Intentos`. The session
delivered the branch to the owner as `intentos-cloud-2026-10-26-m4-m6.bundle`, `…-patches.tgz` and
`PR_DESCRIPTION.md` (file cards in that session). Reported by the session (not independently re-verified here):

1. **Incremental re-indexing** (spec §6.4): `intentos index` diffs against the previously indexed revision, re-extracts
   only changed/added files, carries unchanged nodes over after verifying file identity, re-validates policy-bound
   sections (a changed bound section becomes `conflicted`), `--full` forces a full re-index; equivalence test vs full re-index.
2. **`resume` re-entry**: interrupted IMPLEMENTING/REPAIRING runs re-enter the recorded Codex thread with a
   "continue the implementation" prompt before verifying; thread id now saved at thread start. Tested with a stand-in
   engine only (no live Codex call was made in the cloud).
3. **Architectural-surprise findings** (spec §7.5): new cross-module imports, duplicate helpers (name or normalised
   body), API-layer construction of domain objects — review-only, never blocking; optional `architecture_surprise`
   block in the policy; `python/architecture_surprise.py` + tests.
4. **Container-isolated verifier**: `docker/verifier/Dockerfile` (Node 22, Python 3.12, git, pytest 9.1.1),
   `INTENTOS_VERIFIER=docker` mode with read-only snapshot mount, no network, fail-closed when Docker is unavailable;
   end-to-end container tests ran against a real daemon in the cloud; offline benchmark outcomes identical in both modes.

Reported totals after item 4: typecheck clean, vitest 12 files / 73 passed (71 without Docker), pytest 14 passed.
`CODEX_API_KEY` was present in the environment but deliberately unused.

### To land the cloud branch
```bash
git clone https://github.com/Cyr-Ch/Intentos && cd Intentos
git fetch /path/to/intentos-cloud-2026-10-26-m4-m6.bundle cloud/2026-10-26-m4-m6:cloud/2026-10-26-m4-m6
git push -u origin cloud/2026-10-26-m4-m6      # then open the PR with PR_DESCRIPTION.md
```
Expect small conflicts with `main`/PR #1 in `src/knowledge/indexer.ts`, `src/verification/runner.ts`,
`IMPLEMENTATION_STATUS.md`, `docs/security.md`, `docs/evaluation.md`; resolve by keeping both sides' additions.

## 4. Routine cleanup
The one-time routine fired once (09:30 UTC) and is now disabled. The cloud session can be archived at
https://claude.ai/code/session_01Ro1JiJEVfAwddGZM9YeUjs once the bundle is safely in the repository.
