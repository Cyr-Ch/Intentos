import json
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

from mergeguard import hooks, howmade
from mergeguard.demo import prepare
from mergeguard.git import metadata_dir


def test_hook_dedup_fetch_cache_stop_and_latency(world, monkeypatch):
    state = prepare(world, "S1")
    b = state["engineer_b"]
    payload = {"cwd": b, "session_id": "test", "tool_name": "Bash", "tool_input": {"command": "pytest -q"}, "tool_response": {"exit_code": 1}}
    first = hooks.handle("post-tool-use", payload)
    assert "users.fetch_user" in first["hookSpecificOutput"]["additionalContext"]
    def unexpected_fetch(_):
        pytest.fail("Fetch should be cached for 60 seconds")
    monkeypatch.setattr(hooks, "fetch", unexpected_fetch)
    start = time.perf_counter()
    assert hooks.handle("post-tool-use", payload) == {}
    assert time.perf_counter() - start < 1
    monkeypatch.setattr(hooks, "fetch", lambda _: None)
    assert hooks.handle("stop", payload)["decision"] == "block"
    assert hooks.handle("stop", {**payload, "stop_hook_active": True}) == {}
    assert len([e for e in howmade.read(b) if e["event"] == "sync_note"]) == 1


def test_disable_and_malformed_payload_fail_open(world, monkeypatch):
    monkeypatch.setenv("MERGEGUARD_DISABLE", "1")
    assert hooks.handle("stop", {"cwd": "/missing"}) == {}
    env = dict(os.environ)
    env.pop("MERGEGUARD_DISABLE")
    result = subprocess.run([sys.executable, "-m", "mergeguard.hooks", "stop"], input="not json", text=True, capture_output=True,
                            cwd=world / "engineer_b", env=env)
    assert result.returncode == 0 and json.loads(result.stdout) == {}
    assert "allowed action after error" in result.stderr


def test_fetch_failure_logs_and_allows(world):
    from mergeguard.git import git
    b = world / "engineer_b"
    git(b, "remote", "set-url", "origin", str(world / "does-not-exist.git"))
    payload = {"cwd": str(b), "hook_event_name": "Stop"}
    result = subprocess.run([sys.executable, "-m", "mergeguard.hooks", "stop"], input=json.dumps(payload), text=True, capture_output=True, cwd=b)
    assert result.returncode == 0 and json.loads(result.stdout) == {}
    assert (metadata_dir(b) / "errors.log").exists()


def test_observed_payload_without_exit_status_stays_unknown():
    command, code = hooks.command_result({"tool_input": {"command": "pytest -q"}, "tool_response": "2 passed in 0.01s"})
    assert command == "pytest -q" and code is None
    assert hooks.command_result({"tool_input": {"cmd": "false"}, "tool_response": "Process exited with code 1"})[1] == 1


def test_howmade_summary_and_body_can_only_raise():
    summary = howmade.summarize([{"event": "command", "cmd": "python -m pytest", "exit_code": 1},
                                {"event": "command", "cmd": "pytest -q", "exit_code": 0},
                                {"event": "sync_note", "message": "get_user → fetch_user"}], files=3)
    assert summary["first_pass"] == 2
    text = howmade.markdown(summary)
    assert howmade.parse(text)["sync_notes"] == 1
    assert howmade.parse("test runs: 0\ntest runs: 5")["test_runs"] == 5
