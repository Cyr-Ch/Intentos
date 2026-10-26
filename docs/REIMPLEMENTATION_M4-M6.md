# Re-implementation brief: incremental index, resume re-entry, architectural surprise, container verifier

**Audience:** a coding agent working inside this repository with no prior context.
**Baseline:** `main` after PR #1 is merged (if PR #1 is not merged yet, start from branch `retrieval-httpx`; it is `main` plus
`benchmarks/evaluate.ts`, the Task B hidden test, and docs). Verify your starting point with:

```bash
nvm use 22 || nvm install 22        # Node >= 22.6 required (native TS stripping, node:sqlite)
npm install && npm run setup:python && npm run fixture:build
npm run typecheck && npm test && npm run test:python
# expected: typecheck clean; vitest 9 files / 58 passed; pytest 7 passed
```

These four features were once built in a cloud session whose branch was lost before it could be pushed. This brief is
written so the same functionality can be rebuilt deterministically. Where the lost implementation made a design
choice worth keeping, it is marked **(keep)**. Read `INTENTOS_BUILD_SPEC.md` §6.4, §7.5, §9.1–9.2, §10.1 and §14.1, and
`docs/architecture.md`, before starting.

## Ground rules

1. One feature per commit (four commits), on a branch `feature/m4-m6-<date>` from the baseline. Each commit leaves
   `npm run typecheck`, `npm test` and `npm run test:python` green. Update `IMPLEMENTATION_STATUS.md` in the same commit
   with actual status (what works, what is partial, exact commands run, test counts).
2. Never weaken or delete existing tests. Never change what `policies/*.yaml` or `benchmarks/hidden_tests/` *enforce*
   without saying why in the commit message; adding optional policy blocks is fine.
3. Model output is never trusted; verification results come only from executed checks. Findings you add must carry
   `authority: "deterministic"` and the right `severity` (review signals are `"review"`, never `"blocking"`).
4. TypeScript runs directly under Node's type stripping: **no parameter properties, no enums, no namespaces** in `src/`.
   Keep `npx tsc --noEmit -p tsconfig.json` clean (`strict`, `noUncheckedIndexedAccess`).
5. Use only trusted configuration for anything the verifier executes; never interpolate repository text into shell.
6. Do not commit `.intentos/`, secrets, or generated images. Use live Codex only if `CODEX_API_KEY` (or a `codex login`
   session) and `INTENTOS_CODEX_MODEL` are available, and never claim live results you did not observe.

## Repository orientation (what you will touch)

| Area | File | Hook points |
|---|---|---|
| Index pipeline | `src/knowledge/indexer.ts` | `indexRepository(store, repoPath, opts)` (line ~174) runs `runPythonIndexer` (line ~85), builds `nodes/edges/evidence` arrays, binds policy via `resolveSources` (line ~373), then `store.replaceRevision(...)` (line ~541) and `upsertRepository`. Returns `IndexSummary`. |
| Python extractor | `python/index_repo.py` | `index_repo(repo, max_file_bytes)` lists tracked files via `git ls-files`, parses `.py`/`.md`, returns `IndexResult` (symbols, imports, calls, docs, tests, skipped, limitations). |
| Store | `src/knowledge/storage.ts` | `replaceRevision`, `nodes/edges/evidence(repoId, revision)`, `indexedRevisions(repoId)`, `getRepository`. Rows are keyed by `(id, repo_id, revision)`; nodes use `INSERT OR IGNORE`. |
| Repo loader | `src/knowledge/repo.ts` | `loadIndexedRepo` fails when HEAD ≠ indexed sha. |
| CLI | `src/cli.ts` (`index`, `explain`, `fixture`, `setup`), `src/cli_run.ts` (`plan`, `run`, `approve`, `resume`, `verify`, `report`, `runs`) |
| Pipeline | `src/orchestrator/runner.ts` | `executeRun` state machine driver; resume branches at `rs.state === "IMPLEMENTING"` / `"REPAIRING"` (line ~251); `recordImplementation` stores `codex_thread_id` **only after** a turn completes (line ~334). |
| Recovery | `src/orchestrator/recovery.ts` | `checkRunIntegrity` returns `{rs, report:{ok, state, checks[]}}`. |
| Codex adapter | `src/codex/adapter.ts` | `CodingEngine` interface; `LiveCodexEngine.implement(req)` uses `codex.resumeThread(req.threadId)` when given (line ~165); streams `thread.started` events (payload has `thread_id`). `OfflineEngine` in `src/codex/offline.ts` treats a second `implement` call or a `threadId` as a repair. |
| Prompts | `src/contracts/prompts.ts` | `buildImplementationPrompt`, `buildRepairPrompt`. |
| Verifier | `src/verification/runner.ts` | `verifyWorktree(input: VerifyInput)` (line ~88): snapshot copy, hidden tests copied to `<snapshot>/.intentos_hidden/{task,invariants}`, builtins (`scope_check`, `architecture_rules`, `counterexamples`), trusted commands through `execCommand(commandId, cmd, argv, cwd, logDir)` (line ~304, `spawnSync` with env `{PATH, HOME, PYTHONDONTWRITEBYTECODE, PYTHONHASHSEED, LANG}` and `timeout_s`). Placeholders replaced at line ~196: `{python}`, `{snapshot}`, `{hidden_tests_dir}`, `{junit}`. |
| Policy checks | `src/verification/policy.ts` | `runArchitectureRules` (calls `python/architecture_rules.py` via stdin JSON), `runScopeCheck`. |
| Result types | `src/verification/results.ts` | `Finding`, `CommandRecord`, `VerificationResult`, `summarizeStatus`. |
| Policy schema | `src/knowledge/policy.ts` | Zod `PolicySchema`; `CommandSchema.builtin` enum; `fallbackPolicy(repoPath)`. |
| Report | `src/reports/generate.ts` | `ReportJson`, `renderMarkdown`. |
| Config | `src/config.ts` | `resolvePaths()`, `resolvePython()`, `codexSettings()`, `PROJECT_ROOT`. |
| Git utils | `src/util/git.ts` | `git(cwd, args, {allowFail})`, `headSha`, `isDirty`, `changedFiles(dir, baseSha)`, `diffAgainstBase`, `workingTreeFiles`. |
| Test helpers | `tests/helpers/fixture.ts` | `setupFixtureEnv()` builds the fixture repo + index in an isolated `INTENTOS_HOME`; `PATCHES` (good/bad/protectedDoc/legacyAdapter/weakenTests/forgeJunit); `TASK_A`; `gitHead`, `gitStatus`. |

Run patterns you can copy from `tests/integration/pipeline.test.ts`: `createRun(store, indexed, task, opts)` then
`executeRun(store, rs, opts)`; `rs.readJson<VerificationResult>("verification")`; `rs.row.worktree_path`.

---

## Feature 1 — Diff-based incremental re-indexing (spec §6.4)

### Current behaviour
`intentos index <repo>` always runs the Python extractor over every tracked `.py`/`.md` file and rebuilds the whole
graph for `HEAD`; older revisions stay in the store untouched. Policy bindings (`resolveSources`) are re-resolved on
every index, but a bound document section whose text changed is only marked `conflicted` if the policy pinned a
`content_sha256`.

### Target behaviour
- When the repository was indexed before at revision `prev` and the working tree is clean, `index` extracts only files
  whose blob changed between `prev` and `HEAD`, reuses the extraction of unchanged files **explicitly** (after checking
  blob ids), rebuilds the graph for `HEAD`, and reports `mode: "incremental"` with the changed/carried file counts.
- `--full` forces the old path. No previous revision, dirty working tree, missing cache, or any mismatch ⇒ full
  re-index with a note in `limitations`.
- Any policy-bound section whose content hash differs from what was bound at `prev` becomes `status: "conflicted"`
  (even without a pin) and is listed in `unresolved_sources` with reason `source changed since <prev>` **(keep)**. A
  conflicted invariant/rule cannot be blocking (compiler already enforces this), so the planner is routed to clarify
  until a human re-approves (by pinning the new `content_sha256` in the policy or editing the source back).

### Design (chosen for provable equivalence)
Do **not** copy graph rows between revisions. Instead cache the *raw extraction* per revision and merge raw results,
then run the unchanged graph builder. Equivalence with a full re-index then holds by construction.

1. **Raw cache.** After every successful index, write the `RawIndex` JSON to
   `<INTENTOS_HOME>/index-cache/<repoId>/<revision>.json` (add `indexCache` to `IntentosPaths` in `src/config.ts` and
   create it in `ensureHome`). Also store a map `blobs: { [path]: <git blob sha> }` taken from
   `git ls-tree -r -z <revision>` (format: `<mode> <type> <sha>\t<path>`), restricted to indexed extensions.
2. **Change detection.** In `indexRepository`, when `!opts.full` and a cache file exists for `prev = store.getRepository(repoId)?.head_sha`
   and `prev` is in `store.indexedRevisions(repoId)` and `!isDirty(repoPath)`:
   - list blobs at `HEAD`; `changed = paths whose sha differs or are new`, `deleted = paths in prev not in HEAD`,
     `carried = paths with identical sha`. Renames appear as delete+add; that is fine.
   - Guard: if more than 60 % of indexed files changed, do a full re-index (cheaper and avoids a huge merge).
3. **Partial extraction.** Extend `python/index_repo.py` with `--only-files <json file>`: parse only the listed paths,
   but still compute `modules`/`internal_modules` from *all* tracked `.py` files (needed for import resolution and for
   `resolved_internal`). Output must keep the same shape and set `"partial": true` plus `"only_files": [...]`.
   Add `runPythonIndexer(repoPath, paths, { onlyFiles?: string[] })` in `indexer.ts`.
4. **Merge.** `mergeRawIndex(prevRaw, partialRaw, { carried, changed, deleted })`:
   - `files` = tracked files at HEAD (from the partial run, which lists all tracked files).
   - `modules` = from the partial run (full list).
   - `symbols`, `imports`, `calls`, `tests`, `docs`: take entries from `prevRaw` whose `path` ∈ `carried`, plus all
     entries from `partialRaw` (which only contain `changed` paths). Drop anything whose path ∈ `deleted`.
   - `skipped`: union by path (minus deleted); `limitations`: partial run's plus `"incremental: N files carried from <prev>"`.
   - `repo` = partial run's (`head_sha` must equal `revision`, same guard as today).
5. **Graph build** — unchanged code path from the merged raw index. Evidence ids are content-addressed with the
   revision string, so carried files get fresh `EV-…` ids for `HEAD`; that is intended (ids are per revision).
6. **Bound-source change detection.** In `resolveSources`, you have the resolved section's `content_hash`. Load the
   previous revision's constraint node attributes (`store.node(repoId, prev, inv.id)` → `ConstraintAttributes.sources[]`)
   and, if the same `{path, heading}` resolved at `prev` with a different hash, mark this source `status: "conflicted"`,
   push `{ owner, path, heading, reason: "section content changed since <prev7>; re-approve or pin content_sha256" }`
   to `unresolved_sources`, and leave the evidence row's authority as the policy authority but status `conflicted`.
   Persist the section hash in `ConstraintAttributes.sources[].content_hash` (add the field) so the next incremental
   run compares against it. Apply the same logic to full re-index when a previous revision exists (cheap, and it is
   exactly spec §6.4: never transfer an assertion as current without checking its source).
7. **Summary & CLI.** Extend `IndexSummary` with `mode`, `previous_revision`, `changed_files`, `deleted_files`,
   `carried_files`, `cache_file`. `index` prints `mode: incremental (12 changed, 3 deleted, 110 carried from 9f7ac08)`.
   Add `--full` to the `index` command and `--json` already works.
8. **Edge cases.** Deleted `.md` with bound headings ⇒ `unresolved_sources` "document not found" (already handled).
   A file that moved from untracked to tracked appears as added. Binary/large files remain in `skipped`.

### Tests (`tests/integration/incremental_index.test.ts`, new)
Use `setupFixtureEnv()`; commit changes inside `env.repo` with `git -c user.email=t@t -c user.name=t commit`.
1. **Incremental equals full.** Change `app/services/pricing.py` (append a comment) and commit. Run `indexRepository`
   (incremental) into `env.store`; run a *full* index of the same HEAD into a second `KnowledgeStore` (temp file).
   Assert `summary.mode === "incremental"`, `changed_files` deep-equals `["app/services/pricing.py"]`, and the sets of
   `(id, kind, qualified_name, attributes_json)` for nodes, `(from,relation,to,confidence)` for edges and
   `(id, source_type, path, line_start, line_end, authority, status, content_hash)` for evidence are identical between
   the two stores.
2. **Changed bound section ⇒ conflicted.** Edit the "Locked contracts" section body of `docs/business-policy.md`, commit,
   incremental index: `INV-001` node has `status: "conflicted"`, `unresolved_sources` contains it; `buildEvidencePack`
   shows `binding: false`; `compileContract` with a contract that lists INV-001 as blocking returns `reject` with
   `unconfirmed_blocking` (reuse `buildOfflineContract`).
3. **`--full` and fallbacks.** `opts.full` ⇒ `mode: "full"`. Dirty tree ⇒ `mode: "full"` with a limitation note. Deleting
   `app/legacy/export_adapter.py` and committing removes its nodes and their edges.
4. **Python side** (`python/tests/test_index_repo.py`): `--only-files` returns only those paths' symbols but resolves
   imports to internal modules that were not parsed.

### Acceptance
- `intentos index` on an unchanged repo after a no-op commit reports `carried == all` and runs in well under the full time.
- Test 1 passes (strict equality), test 2 proves stale bindings cannot block silently.
- `docs/architecture.md` "Incremental indexing" paragraph rewritten to describe the cache/merge design; status file updated.

---

## Feature 2 — `resume` re-enters the Codex implementer thread (spec §9.1 "Resume Codex sessions only after checking the persisted workflow state and worktree integrity")

### Current behaviour
`intentos resume <run-id>` runs `checkRunIntegrity`; for `IMPLEMENTING`/`REPAIRING` it transitions straight to
`VERIFYING` and verifies whatever is in the worktree (`runner.ts` ~251–257). `codex_thread_id` is only persisted when a
turn *completes*, so an interrupted first implementation has no thread id to resume.

### Target behaviour
- The thread id is persisted as soon as the SDK emits `thread.started` **(keep)**.
- On resume from `IMPLEMENTING` or `REPAIRING` in live mode with a known thread id and an existing worktree at the base
  sha, the orchestrator re-enters that thread with a short continuation prompt, records the turn like any other
  implementation turn, then verifies. Re-entry happens at most twice per run (counted from `resume.reentered` events);
  after that it verifies directly. Offline mode or no thread id ⇒ current behaviour (verify as is), with an event
  explaining why.

### Implementation
1. `src/codex/adapter.ts`: add `onThreadStarted?: (threadId: string) => void` to `ImplementRequest` (and `PlanRequest`
   for symmetry). In `LiveCodexEngine.implement`/`plan`, when an event with `type === "thread.started"` arrives, call it
   with `ev.thread_id`. (The SDK types: `ThreadStartedEvent { type: "thread.started"; thread_id: string }`.)
2. `src/orchestrator/runner.ts`:
   - In the `APPROVED → IMPLEMENTING` block and in the repair block, pass
     `onThreadStarted: (id) => { rs.update({ codex_thread_id: id }); rs.event("implementer.thread_started", { id }); }`.
   - Replace the two resume branches with a helper `await reenterIfPossible(rs, engine, contract, pack, task, "implement" | "repair")`:
     ```ts
     const reentries = store.events(rs.runId).filter(e => e.event_type === "resume.reentered").length;
     const canReenter = !engine.simulated && !!rs.row.codex_thread_id && reentries < 2
                        && rs.row.worktree_path && fs.existsSync(rs.row.worktree_path)
                        && headSha(rs.row.worktree_path) === rs.row.base_sha;
     if (canReenter) {
       budget.check("resume re-entry");
       const prompt = buildContinuePrompt(contract, phase, lastFindings /* from latest verification.json or [] */);
       rs.writeText(`continue_prompt.${reentries + 1}.txt`, prompt);
       rs.event("resume.reentered", { phase, thread_id: rs.row.codex_thread_id, attempt: reentries + 1 });
       const result = await engine.implement({ cwd: worktree, prompt, threadId: rs.row.codex_thread_id,
         onEvent: e => rs.appendEventLine({ phase: `resume-${phase}-${reentries + 1}`, ...e }) });
       recordImplementation(rs, result, phase, previousAttempts(rs));
     } else rs.event("resume", { note: "verifying current worktree without re-entering a thread", reason });
     rs.transition("VERIFYING", { attempt: previousAttempts(rs) + 1, resumed: true });
     ```
     (`REPAIRING → VERIFYING` and `IMPLEMENTING → VERIFYING` are already legal transitions; do not add states.)
3. `src/contracts/prompts.ts`: `buildContinuePrompt(contract, phase, findings)` — "Your previous turn was interrupted
   before it finished. The worktree already contains your partial changes; inspect `git status`/`git diff` first. Continue
   implementing the contract (goal, requirements, allowed/protected paths restated), do not start over, do not commit,
   run `python -m pytest -q` before finishing, and end with a summary." For `repair`, append the last blocking findings
   in the same format as `buildRepairPrompt`.
4. `src/orchestrator/recovery.ts`: add an informational check `codex_thread_known` (ok when a thread id exists or mode is
   offline; never fails integrity). `intentos resume` prints it with the other checks.
5. `src/codex/offline.ts`: unchanged (it already treats `threadId` as a repair call; offline runs never have a thread id).
6. Docs: `docs/architecture.md` resume paragraph; `README.md` command table (`resume`); status file.

### Tests (extend `tests/integration/pipeline.test.ts` or new `tests/integration/resume.test.ts`)
Inject a `CodingEngine` with `simulated: false` (so the live path is taken without Codex):
1. **Thread id persisted early.** The engine's `implement` calls `req.onThreadStarted?.("thread-test-1")`, writes a file
   into `req.cwd`, then throws. Assert `rs.row.codex_thread_id === "thread-test-1"` even though the run ended `FAILED`.
2. **Re-entry on resume.** Rewind the same run to `IMPLEMENTING` (`env.store.updateRun(rs.runId, { state: "IMPLEMENTING", result_json: null })`,
   as the existing resume test does), resume with an engine whose `implement` records `req.threadId` and `req.prompt`
   and applies `PATCHES.good`. Assert the second call received `threadId === "thread-test-1"`, the prompt contains
   "interrupted", an event `resume.reentered` exists, and the run ends `REVIEW_READY`.
3. **Bounded re-entry.** With an engine that always throws after `onThreadStarted`, resume three times; assert at most two
   `resume.reentered` events and that the third resume verifies directly.
4. **No thread id / offline** ⇒ no `implement` call on resume (count calls), existing behaviour preserved.
5. **Integrity gate.** If the worktree HEAD moved off the base sha, `checkRunIntegrity` is not ok and `resume` refuses
   (already tested; keep it green).

### Acceptance
- Live path exercised with the injected engine; a real `resumeThread` call is only claimed if run with credentials.
- `intentos resume` output shows the re-entry event and the integrity checks.

---

## Feature 3 — Architectural-surprise review signals (spec §7.5)

### Target behaviour
A deterministic, **review-only** (never blocking) triage signal computed from the diff at verification time, with three
detectors:
1. **New cross-module dependency.** A changed file imports an internal module (resolved against the repository's
   module list) that it did not import at the base revision.
2. **Duplicate helper.** A function/method added in the diff whose *name* matches an existing function elsewhere in
   the base revision, or whose *normalised body* equals an existing function's body (ignore docstrings, comments,
   whitespace; rename parameters positionally; require ≥ 3 statements to avoid trivial getters).
3. **API-layer domain construction.** In files matching `architecture_surprise.api_paths` (default `app/api/**`), a
   call whose callee is a class defined under `architecture_surprise.domain_paths` (default `app/domain/**`) — e.g.
   `Money(...)`, `Contract(...)` — excluding Enum member access.

Findings: `category: "architecture"`, `severity: "review"`, `authority: "deterministic"`, `rule_id` one of
`SURPRISE-NEW-DEPENDENCY`, `SURPRISE-DUPLICATE-HELPER`, `SURPRISE-API-DOMAIN-CONSTRUCTION`, `location: "<path>:<line>"`,
`expected`/`observed` filled with the base vs candidate fact, `message` one sentence a reviewer can act on. A run with
only these findings ends in `HUMAN_REVIEW` (that is the existing semantics of review findings); the report lists them
under a new "Architectural surprise (review signals)" heading. They are **risk triage, not proof of bad design** — say
so in the message text.

### Implementation
1. **Policy (optional block, defaults when absent).** In `src/knowledge/policy.ts` add
   `architecture_surprise: z.object({ api_paths: z.array(z.string()).default(["app/api/**"]), domain_paths: z.array(z.string()).default(["app/domain/**"]), ignore_names: z.array(z.string()).default([]) }).default({})`
   and add `architecture_surprise` to `CommandSchema.builtin`. In `policies/startup_billing.yaml` add
   `commands.architecture_surprise: { description, track: architecture, builtin: architecture_surprise, enforcement: advisory, required: true }`
   and an explicit `architecture_surprise:` block mirroring the defaults **(keep)**. In `fallbackPolicy`, add the same
   command so real repositories get the signal.
2. **Base-revision file access.** Add to `src/util/git.ts`:
   `readFilesAtRevision(dir, rev, paths): Map<string, string>` using one `git cat-file --batch` process (stdin
   `"<rev>:<path>\n"` per file; parse `<sha> blob <size>` headers; skip `missing`). Also `trackedPythonFiles(dir, rev)` via
   `git ls-tree -r --name-only <rev>` filtered to `.py`.
3. **Python analyser** `python/architecture_surprise.py` (stdlib only), stdin JSON:
   ```json
   { "base": {"path": "source", ...}, "candidate": {"path": "source", ...},
     "changed_paths": [...], "internal_modules": [...],
     "config": {"api_paths": [...], "domain_paths": [...], "ignore_names": [...]} }
   ```
   stdout JSON `{ "findings": [{ "kind", "path", "line", "message", "expected", "observed" }], "errors": [...] }`.
   - Build base symbol tables once: `{function name → [(path, line, normalised_body)]}`, `{class name → path}` for
     domain classes (classes defined in files matching `domain_paths`).
   - Imports: reuse the module-level import extraction approach from `python/index_repo.py` (copy the small helper;
     do not import that module, keep the script standalone and `-I` safe). Compare per changed file: candidate internal
     imports − base internal imports.
   - Normalised body: `ast.unparse` of the function body after removing a leading docstring `Expr(Constant(str))`,
     with `arg` names replaced by `_a0, _a1, …` via an `ast.NodeTransformer`, whitespace collapsed.
   - For deleted/renamed files, skip (no candidate). Files that fail to parse ⇒ `errors`, never findings.
4. **TS wrapper** `src/verification/surprise.ts`: `runArchitecturalSurprise({ snapshot, repoPath, baseSha, changed, policy, internalModules })`:
   candidate sources from the snapshot for changed `.py` files; base sources for the same paths plus all tracked base
   `.py` files (cap at 2,000 files; above that, only files sharing the changed files' top-level package, and add a
   limitation note); `internal_modules` from the tracked base files (module name = path without `.py`, `__init__`
   stripped). Spawn `resolvePython() -I python/architecture_surprise.py` with the JSON on stdin (same pattern as
   `runArchitectureRules` in `src/verification/policy.ts`). Map results to `Finding[]`.
5. **Verifier integration** (`src/verification/runner.ts`): handle `cmd.builtin === "architecture_surprise"` next to the
   other builtins: run, push findings, push a `CommandRecord` with `enforcement: "advisory"` and status
   `passed` (signals never fail the command; use `summary: "<n> signal(s)"`). It needs `repoPath`: add
   `repoPath: string` to `VerifyInput` (the fixture repo path; the runner has `indexed.repoPath`, `verify` CLI has
   `repo.path`). The compiler injects required commands, so the builtin runs on every contract once the policy lists it.
6. **Report** (`src/reports/generate.ts`): add `architectural_surprise: Array<{ id, rule_id, location, message }>` to
   `ReportJson` (filter findings by `rule_id.startsWith("SURPRISE-")`) and a markdown section after "Verified behavior".
7. Tracks: these count toward `tracks.architecture.review_findings` automatically (category architecture).

### Tests
- `python/tests/test_architecture_surprise.py`: synthetic base/candidate pairs for each detector; a renamed-parameter
  duplicate is detected; a 2-statement body is not; Enum access `PlanTier.ENTERPRISE` in the API layer is not flagged;
  parse error yields `errors` not findings.
- `tests/integration/pipeline.test.ts`: (a) the known-good Task A patch (`PATCHES.good`) raises **no** surprise signal
  and still reaches `REVIEW_READY`; (b) a patch fixture that adds `from app.services.exports import InvoiceExportService`
  to `app/services/pricing.py` plus a copy of `Money.percent_off` as a module-level helper, and a `Money(...)` construction
  in `app/api/checkout.py`, yields exactly the three rule ids as review findings and ends `HUMAN_REVIEW` (create the
  patch with `git diff` from a scratch clone, store it under `benchmarks/offline_patches/fixtures/surprise.patch`, and
  add it to `PATCHES`). Note: this patch must not trip blocking rules (ARCH-001 forbids `app.domain.money` in the API
  layer — so for detector 3 construct a domain object that is *not* forbidden, e.g. `Customer(...)` from
  `app.domain.contracts`, and make sure the import stays allowed).

### Acceptance
- Report shows the three signals with locations; offline benchmark outcomes for the recorded patches are unchanged.
- `docs/architecture.md` gets a "Architectural surprise" paragraph; `docs/security.md` notes signals are advisory.

---

## Feature 4 — Container-isolated verification runner (spec §10.1, §14)

### Target behaviour
`INTENTOS_VERIFIER=docker` runs every *executing* trusted command (the pytest commands, including hidden tests and
counterexample probes) inside a container: snapshot mounted read-only, a writable results directory for JUnit output,
no network, CPU/memory/pid limits, a hard timeout with `docker kill`. Static builtins (scope, architecture rules,
surprise) keep running on the host because they do not execute candidate code. If Docker or the image is unavailable in
docker mode, verification **fails closed** (blocking `VERIFIER-UNAVAILABLE` finding per blocking command) and never
silently falls back to the host **(keep)**. Default mode stays `host`.

### Implementation
1. **Image** `docker/verifier/Dockerfile`:
   ```Dockerfile
   ARG PYTHON_IMAGE=python:3.12-slim-bookworm      # override with a mirror when Docker Hub rate-limits
   FROM ${PYTHON_IMAGE}
   RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
   RUN pip install --no-cache-dir pytest==9.1.1     # keep in sync with .intentos/venv (python -m pytest --version)
   ENV PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=0 LANG=C.UTF-8
   RUN useradd -m -u 1000 verifier
   USER verifier
   WORKDIR /work/snapshot
   ```
   Node is not needed inside (nothing TypeScript runs there). `package.json`: `"verifier:image": "docker build -t intentos-verifier:0.1 docker/verifier"`.
2. **Sandbox module** `src/verification/sandbox.ts`:
   - `verifierMode(): "host" | "docker"` from `INTENTOS_VERIFIER` (anything else ⇒ error).
   - `dockerSettings(): { binary, image, cpus, memory, pidsLimit }` from `INTENTOS_DOCKER_BIN` (default `docker`),
     `INTENTOS_VERIFIER_IMAGE` (default `intentos-verifier:0.1`), `INTENTOS_VERIFIER_CPUS` (1), `INTENTOS_VERIFIER_MEMORY` (`1g`).
   - `dockerPreflight(settings): { ok, reason, imageDigest? }` — `docker info` then `docker image inspect <image>`
     (`--format {{.Id}}`), both with `spawnSync` and 20 s timeouts.
   - `containerName(runId, commandId, attempt)` — `intentos-<runId>-<commandId>-<attempt>` sanitised to `[a-zA-Z0-9_.-]`.
   - `planCommand(argv, ctx: { snapshot, resultsDir, hiddenDir, junit, name, settings }): string[]` — translates the
     *host* argv into a `docker run` argv:
     ```
     docker run --rm --name <name> --network none --read-only --tmpfs /tmp:rw,size=256m
       --cpus <cpus> --memory <memory> --pids-limit 256 --security-opt no-new-privileges --cap-drop ALL
       -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONHASHSEED=0 -e LANG=C.UTF-8
       -v <snapshot>:/work/snapshot:ro -v <resultsDir>:/work/results:rw -w /work/snapshot <image> <translated argv>
     ```
     Translation: the host interpreter path (`resolvePython()`) ⇒ `python`; `<snapshot>` ⇒ `/work/snapshot`;
     `<hiddenDir>` ⇒ `/work/snapshot/.intentos_hidden`; the host JUnit path ⇒ `/work/results/<basename>`. Assert no
     remaining absolute host path in the translated argv (throw otherwise — this is a security property).
   - `killContainer(name)` — `docker kill <name>` best-effort.
3. **Runner integration** (`src/verification/runner.ts`):
   - Compute `mode = verifierMode()` once in `verifyWorktree`. In docker mode run `dockerPreflight`; on failure, for every
     verification entry whose command has `argv` and `enforcement: "blocking"`, push a blocking finding
     `VERIFIER-UNAVAILABLE` (category `process`, authority `deterministic`, message with the preflight reason) and a
     `CommandRecord` with `status: "error"`; skip execution; continue with static builtins. The consistency guard already
     makes any non-passing blocking command a blocking finding.
   - Make `execCommand` take an extra `{ mode, container?: { name, settings, resultsDir } }`; in docker mode spawn the
     planned argv instead, and on `ETIMEDOUT` call `killContainer(name)` before returning `status: "timeout"`.
   - JUnit files land in `<attemptDir>` because `resultsDir = attemptDir` is mounted at `/work/results`; the existing
     parser reads them unchanged. The hidden-test inventory cross-check and the counterexample generation stay as is.
   - Record `verifier: { mode, image, image_digest }` in `VerificationResult.limitations` (text) and in
     `environment.json` (`runner.ts` `environmentInfo`) **(keep)**.
4. **Snapshot permissions.** The read-only mount means pytest cannot write `.pytest_cache` (already disabled with
   `-p no:cacheprovider`) or `__pycache__` (disabled by env). Verify with a probe during development.
5. **Docs**: `docs/security.md` (what the container does and does not isolate: no syscall filtering beyond Docker's
   default seccomp, host kernel shared), `README.md` env vars (`INTENTOS_VERIFIER`, `INTENTOS_VERIFIER_IMAGE`,
   `INTENTOS_DOCKER_BIN`), `docs/cloud-handoff.md` note that `npm run verifier:image` needs registry access (use
   `--build-arg PYTHON_IMAGE=mirror.gcr.io/library/python:3.12-slim-bookworm` when Docker Hub returns 429).

### Tests
- `tests/unit/sandbox.test.ts`: `planCommand` produces the flags above, translates all placeholders, contains no host
  path, uses `--network none` and `:ro`; `containerName` sanitisation; `verifierMode` rejects unknown values.
- `tests/integration/container_verifier.test.ts`:
  1. **Fail closed (always runs).** `INTENTOS_VERIFIER=docker INTENTOS_DOCKER_BIN=/nonexistent/docker` ⇒ the good patch
     run ends `FAILED` with `VERIFIER-UNAVAILABLE` findings and no pytest executed on the host (assert no
     `pytest_project.log` with "passed" in it).
  2. **End-to-end (skip unless `docker info` succeeds and the image exists).** Good patch ⇒ `REVIEW_READY` with
     `pytest_hidden_task` passed inside the container; bad patch ⇒ `FAILED` with the same rule ids as on the host.
  3. **No network inside the container (skip without Docker).** Run a one-off probe command through `planCommand`:
     `python -c "import os; print(sorted(os.listdir('/sys/class/net')))"` must print only `lo`.
  Use `it.skipIf(!dockerAvailable)` so the suite is green on machines without Docker; print the skip reason.
- Run the offline benchmark matrix with `INTENTOS_VERIFIER=docker` once and record that outcomes are identical to host
  mode in the status file (the lost implementation observed identical results).

### Acceptance
- Host mode untouched (all existing tests green with `INTENTOS_VERIFIER` unset).
- With Docker: image builds, e2e tests pass, timeouts kill the container, results identical to host mode.

---

## Order of work, verification and hand-over

1. Feature 4 is independent of 1–3 and most valuable for safety; Feature 3 depends only on git utilities; Feature 1 is the
   largest; Feature 2 is small. Suggested order: **4 → 3 → 2 → 1** (or 1 first if indexing is the priority).
2. After each feature: `npm run typecheck && npm test && npm run test:python`, `bash scripts/demo.sh` in an isolated
   `INTENTOS_HOME`, and `node --disable-warning=ExperimentalWarning benchmarks/evaluate.ts --offline` — the five offline
   rows must keep their outcomes (A good REVIEW_READY, A bad FAILED, B/C nopatch FAILED, D ABSTAINED).
3. Update `IMPLEMENTATION_STATUS.md` (milestone table rows M4/M3, test counts, limitations), `docs/architecture.md`,
   `docs/security.md`, `README.md`; add the new patches/fixtures under `benchmarks/offline_patches/fixtures/`.
4. Open a PR titled "Incremental index, resume re-entry, architectural surprise, container verifier" whose description
   states per feature what is functional vs partial, with the test names, and whether a real Docker daemon or a live
   Codex thread was used. Do not claim container or live results that were not executed.

## Known pitfalls (from the first attempt)
- `node:sqlite` rows come back as `Record<string, SQLOutputValue>`; cast via `unknown`.
- `git ls-files` lists tracked files but the Python extractor reads the *working copy*; incremental mode must require a
  clean tree or read blobs via `git show` to stay consistent with "index reflects HEAD".
- `spawnSync` blocks the event loop: vitest cannot time out a hung child; always pass `timeout` and keep per-command
  timeouts in policy small for tests.
- Laptop sleep suspends child processes; do not interpret multi-hour wall times as hangs without checking `pmset -g log`.
- The scope check flags `tests/**` deletions and removed assertions as review findings; your fixture patches for tests
  should only add tests.
- Docker Hub may return 429 for anonymous pulls; the Dockerfile takes `PYTHON_IMAGE` so a mirror can be used.
