# Continuing IntentOS development in the cloud

This checkout can be developed by an isolated cloud agent session (Claude Code routines / cloud sessions) so
that no laptop has to stay on. The cloud session starts from a Git clone and has no access to local files,
local credentials or the local `.intentos/` runtime data.

## Prerequisites

1. **The repository must be reachable from the cloud** — push this checkout to a GitHub repository and use
   that URL as the session source. Runtime data (`.intentos/`) is gitignored and is rebuilt by the commands below.
2. **Toolchain in the cloud image:** Node.js ≥ 22.6 (`nvm install 22`), Python ≥ 3.11 with `venv`, Git ≥ 2.30.
   `bin/intentos.js` refuses older Node versions with an explicit message.
3. **Optional — live Codex runs:** set `CODEX_API_KEY` (an OpenAI platform key; billed to the platform account,
   not the ChatGPT workspace) and `INTENTOS_CODEX_MODEL` as environment variables/secrets of the cloud
   environment. Without them the agent can still do everything offline (tests, benchmarks with recorded
   patches, all engineering work on M4–M6); it must not claim live results.

## Bootstrap commands (run first in every cloud session)

```bash
npm install
npm run setup:python
npm run fixture:build
npm run typecheck && npm test && npm run test:python
```

Expected: typecheck clean, vitest 8 files / 49 tests passing, pytest 6 passing. If any of these fail in the cloud
image, fix the environment before touching code.

## Self-contained prompt for the cloud agent

> You are continuing development of IntentOS (see `INTENTOS_BUILD_SPEC.md` for the specification and
> `IMPLEMENTATION_STATUS.md` for what is done, what is limited and the next steps). Start by running the bootstrap
> commands in `docs/cloud-handoff.md` and confirming the test suite passes. Then work through the "Next steps"
> list in `IMPLEMENTATION_STATUS.md` in order, one item per commit on a branch named `cloud/<date>-<topic>`:
> (1) diff-based incremental re-index with assertion re-validation; (2) `resume` re-entering the Codex implementer
> thread with a continue prompt; (3) architectural-surprise findings (new cross-module imports, duplicate helpers)
> as review findings; (4) container-isolated verification runner (Dockerfile + runner option). For every change:
> add or extend tests, keep `npm test` and `npm run test:python` green, update `IMPLEMENTATION_STATUS.md` with
> actual status, and never claim live Codex results unless `CODEX_API_KEY` is present and a run actually
> completed. Do not modify `benchmarks/hidden_tests/` or `policies/` semantics without stating why. Open a pull
> request at the end summarizing what is functional versus stubbed.

## What a cloud session cannot do

- It cannot see or reuse the runs recorded on the laptop under `.intentos/runs/` unless those are committed or
  copied elsewhere (they are gitignored by design; the evidence tables in `IMPLEMENTATION_STATUS.md` and
  `docs/evaluation.md` summarise them).
- It cannot use the laptop's ChatGPT-session Codex login; only an API key works headlessly.
