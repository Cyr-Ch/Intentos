# Codex hooks: observed compatibility

Probe written before the harness: [`scripts/probe_hook.py`](../scripts/probe_hook.py). Runtime: `codex-cli 0.154.0`. Commands inspected: `codex --version`, `codex --help`, `codex exec --help`, and `codex features list`.

The installed feature list reports `hooks` as stable/enabled. The brief's expected `codex_hooks` name is obsolete for this installation. The adapter follows the [official hook documentation](https://learn.chatgpt.com/docs/hooks): `PostToolUse`/`Bash`, `hookSpecificOutput.additionalContext`, and the `Stop` block/reason response.

## Observed payloads

[`probe/payloads.json`](probe/payloads.json) contains redacted **actual runtime** PostToolUse and Stop inputs from a minimal `printf` session. The successful PostToolUse response was raw output text, with no exit code. The adapter accepts both that form and structured responses containing an exit code. It never invents a successful status. Use `mergeguard run -- python -m pytest -q` for exact command receipts.

The probe was confirmed with explicit inline hook configuration supplied to `codex exec`. Earlier attempts using only project discovery produced no probe records in the ephemeral invocation. One later attempt with normal user config hit an unsupported user-selected model before a tool ran. These are compatibility findings, not claimed hook passes. The project files are generated according to the documented schema; users must trust both the project and the current hook definitions.

## Configuration generated in each demo clone

```toml
[features]
hooks = true
```

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Bash",
      "hooks": [{"type": "command", "command": "/absolute/venv/bin/python -m mergeguard.hooks post-tool-use", "timeout": 20}]
    }],
    "Stop": [{
      "hooks": [{"type": "command", "command": "/absolute/venv/bin/python -m mergeguard.hooks stop", "timeout": 20}]
    }]
  }
}
```

Only a newly delivered issue adds context. Deduplication uses session + symbol/change + commit, so another session or a later incident can receive its own note. A shared ledger `sync_note` and a local how-made entry record the exact advice. Fetch attempts are throttled to 60 seconds after commands; Stop always attempts a fetch. A failed fetch logs an error and permits the agent action, while a PR check returns an error instead of accepting stale data.

The Stop adapter honors `stop_hook_active`. Error paths emit `{}` with exit 0 and write stderr plus `.git/mergeguard/errors.log` when possible. Unknown or malformed payloads never crash the session. Tests cover the actual observed response form, deduplication, caching, sub-second cached execution, repeated Stop handling, disabled hooks, invalid JSON, and fetch failures.

## Manual payload smoke test

Inside a prepared clone:

```bash
printf '{"hook_event_name":"Stop","cwd":"."}' | python -m mergeguard.hooks stop
```

The scripted demo and evaluation invoke the actual adapter subprocess, but they do not claim to measure autonomous Codex behavior. The raw Codex transcript remains local and ignored by Git; only redacted contract evidence is shipped.

## Trusting project hooks without touching the user config

Codex refuses to run a hook definition until it has been reviewed and trusted. Trust is stored as a hash in the user config under `hooks.state."<hooks.json path>:<event>:<group>:<handler>"`. Reading `codex-rs/hooks/src/engine/discovery.rs` (`hook_hash`) and `codex-rs/config/src/fingerprint.rs` (`version_for_toml`) shows the identity: the event label plus the matcher group with one normalized handler (`type`, `command`, the effective `timeout`, `async`, and any status message or non-default context limit), serialized with sorted keys and hashed with SHA-256. `mergeguard.demo.codex_hook_hash` reproduces it; it was verified against two entries that the interactive `/hooks` review had already written for this machine.

`hook_states_from_stack` reads hook state from the **user** and **session-flags** layers only, and the session-flags layer is the `-c` override. So `python -m mergeguard.demo trust --world W` prints

```
hooks.state = { "<W>/engineer_b/.codex/hooks.json:post_tool_use:0:0" = { trusted_hash = "sha256:…", enabled = true }, … }
```

which `codex -c '…'` or `codex exec -c '…'` accepts (the dotted-path form rejects keys that contain dots, the inline-table form parses under `--strict-config`). This pins trust to the exact definitions in that world for that invocation. The blanket `--dangerously-bypass-hook-trust` flag is not used.

## Claude Code compatibility (verified 2026-10-27, Claude Code 2.1.310)

Claude Code consumes the same hook shape from `.claude/settings.json`, so `setup_demo.sh` writes the identical definition there. Verified in print mode (`claude -p`): project-settings hooks fire once per matching tool call; passing the same file again with `--settings` does not fire them twice; the PostToolUse payload carries `tool_name: "Bash"`, `tool_input.command`, `cwd`, and `session_id`, with no exit status in `tool_response`; the Stop payload carries `stop_hook_active`; `hookSpecificOutput.additionalContext` reaches the model. The Stop `{"decision":"block","reason":…}` continuation is Claude Code's documented contract and was not exercised in the smoke run because the branch was already clean at stop; the live evaluation records how often it fires. A full S1 run on `haiku` received the rename note after its first `pytest`, switched to `fetch_user`, and finished with a clean sync check.

## SessionStart memory

`python -m mergeguard.hooks session-start` returns `additionalContext` built only from the shared ledger: for each folder with a `culprit` or `clash` event inside the breaker window, the number of incidents, the current review floor, the latest PR, its partner if it was a clash, and the failing test IDs. It says nothing when the ledger is quiet.
