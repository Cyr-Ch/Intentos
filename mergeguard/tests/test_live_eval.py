import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "eval"))
import live_compare  # noqa: E402
import render  # noqa: E402

from mergeguard import hooks, sync_check
from mergeguard.demo import codex_hook_hash, codex_trust_override, hook_config, merge_change_a, prepare


def test_claude_stream_parsing_counts_tools_tokens_and_errors():
    lines = [json.dumps({"type": "system", "subtype": "init"}),
             json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {}}, {"type": "text", "text": "hi"}]}}),
             json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Write", "input": {}}]}}),
             json.dumps({"type": "result", "subtype": "success", "is_error": False, "num_turns": 3, "total_cost_usd": 0.01,
                         "usage": {"input_tokens": 10, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 1000, "output_tokens": 50}})]
    parsed = live_compare.parse_claude(lines)
    assert parsed["tool_calls"] == 2 and parsed["commands"] == 1 and parsed["turns"] == 3
    assert parsed["tokens"] == {"input": 1110, "cached": 1000, "output": 50} and parsed["error"] is None
    assert live_compare.is_action("claude", lines[1]) and not live_compare.is_action("claude", lines[0])
    failed = live_compare.parse_claude([json.dumps({"type": "result", "subtype": "error_during_execution", "is_error": True, "result": "limit"})])
    assert failed["error"].startswith("error_during_execution")


def test_codex_stream_parsing_sums_turn_usage():
    lines = [json.dumps({"type": "thread.started"}),
             json.dumps({"type": "item.started", "item": {"type": "command_execution", "command": "pytest"}}),
             json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "done"}}),
             json.dumps({"type": "turn.completed", "usage": {"input_tokens": 5, "cached_input_tokens": 2, "output_tokens": 3, "reasoning_output_tokens": 1}}),
             json.dumps({"type": "turn.completed", "usage": {"input_tokens": 5, "cached_input_tokens": 0, "output_tokens": 4, "reasoning_output_tokens": 0}})]
    parsed = live_compare.parse_codex(lines)
    assert parsed["commands"] == 1 and parsed["turns"] == 2 and parsed["tokens"] == {"input": 10, "cached": 2, "output": 7, "reasoning": 1}
    assert live_compare.is_action("codex", lines[1]) and not live_compare.is_action("codex", lines[0])
    assert live_compare.parse_codex([json.dumps({"type": "turn.failed", "error": {"message": "usage limit"}})])["error"] == "usage limit"
    recovered = live_compare.parse_codex([json.dumps({"type": "error", "message": "Reconnecting... 2/5"}), lines[3]])
    assert recovered["error"] is None and recovered["warnings"] == ["Reconnecting... 2/5"]
    assert live_compare.parse_codex([json.dumps({"type": "error", "message": "usage limit"})])["error"] == "usage limit"


def test_codex_trust_override_pins_each_hook_by_hash(world):
    b = world / "engineer_b"
    override = codex_trust_override(b)
    path = (b / ".codex" / "hooks.json").resolve()
    assert override.startswith("hooks.state = { ")
    for label in ("session_start", "post_tool_use", "stop"):
        assert f'"{path}:{label}:0:0" = {{ trusted_hash = "sha256:' in override
    group = {"matcher": "Bash", "hooks": [{"type": "command", "command": "echo hi", "timeout": 20}]}
    first = codex_hook_hash("post_tool_use", group, group["hooks"][0])
    assert first == codex_hook_hash("post_tool_use", {"matcher": "Bash", "hooks": []}, {"command": "echo hi", "timeout": 20, "async": False})
    assert first != codex_hook_hash("post_tool_use", {"matcher": None, "hooks": []}, group["hooks"][0])
    assert first != codex_hook_hash("stop", group, group["hooks"][0])
    # SessionEnd timeouts are clamped to three seconds before hashing, as Codex does.
    assert codex_hook_hash("session_end", {}, {"command": "x", "timeout": 10}) == codex_hook_hash("session_end", {}, {"command": "x", "timeout": 3})


def test_hook_config_serves_both_agents(world):
    config = hook_config("/opt/python")
    assert config["hooks"]["PostToolUse"][0]["matcher"] == "Bash"
    assert all(h["command"].startswith("/opt/python -I -m mergeguard.hooks") for groups in config["hooks"].values() for g in groups for h in g["hooks"])
    assert json.loads((world / "engineer_b" / ".claude" / "settings.json").read_text()) == json.loads((world / "engineer_b" / ".codex" / "hooks.json").read_text())


def test_change_a_can_merge_mid_task(world):
    state = prepare(world, "S1", merge_a=False)
    b = world / "engineer_b"
    assert not state["a_merged"] and "good" not in state
    assert sync_check.check(b, fetch=True)["clean"]
    state = merge_change_a(world)
    assert state["a_merged"] and state["good"]
    assert not sync_check.check(b, fetch=True)["clean"]
    assert merge_change_a(world)["good"] == state["good"]


def test_fetch_interval_env_and_stop_block_evidence(world, monkeypatch):
    from mergeguard import howmade
    state = prepare(world, "S1", merge_a=False)
    b = state["engineer_b"]
    payload = {"cwd": b, "session_id": "t", "tool_name": "Bash", "tool_input": {"command": "pytest -q"}, "tool_response": "ok"}
    assert hooks.handle("post-tool-use", payload) == {}
    merge_change_a(world)
    assert hooks.handle("post-tool-use", payload) == {}, "60s throttle: no fetch yet"
    monkeypatch.setenv("MERGEGUARD_FETCH_INTERVAL", "0")
    assert "fetch_user" in hooks.handle("post-tool-use", payload)["hookSpecificOutput"]["additionalContext"]
    assert hooks.handle("stop", payload)["decision"] == "block"
    assert [e["issues"] for e in howmade.read(b) if e["event"] == "stop_block"] == [["users.get_user:renamed"]]
    monkeypatch.setenv("MERGEGUARD_FETCH_INTERVAL", "not-a-number")
    assert hooks.fetch_interval() == 60.0


def test_session_start_memory_is_specific_and_ledger_derived(world, monkeypatch, tmp_path):
    from mergeguard import ledger
    b = world / "engineer_b"
    assert hooks.handle("session-start", {"cwd": str(b)}) == {}
    ledger.append(b, type="culprit", pr=7, commit="abc", paths=["payments/charge.py"], details={"incident": "abc", "tests": ["tests/test_invoice.py::test_total"]})
    ledger.append(b, type="clash", pr=7, commit="abc", paths=["payments/charge.py"], partner_pr=5)
    ledger.append(b, type="culprit", pr=8, commit="def", paths=["payments/refund.py"], details={"incident": "def", "tests": []})
    note = hooks.handle("session-start", {"cwd": str(b), "hook_event_name": "SessionStart"})["hookSpecificOutput"]["additionalContext"]
    assert "payments/ broke 2 time(s)" in note and "PR #8" in note and "tier 2" in note
    assert "origin/main" in note
    monkeypatch.setenv("MERGEGUARD_DISABLE", "1")
    assert hooks.handle("session-start", {"cwd": str(b)}) == {}


def test_render_handles_scripted_and_live_summaries(tmp_path):
    runs = tmp_path / "runs"
    scripted = runs / "20260101T000000Z"
    scripted.mkdir(parents=True)
    rows = [{"scenario": s, "arm": arm, "notes": int(arm == "guarded" and s in "S1S2S3"), "main_broken": arm == "baseline" and s != "S5",
             "recovered": False, "final_healthy": arm == "guarded" or s == "S5", "expected_checks_passed": True}
            for s in ("S1", "S2", "S3", "S4", "S5") for arm in ("baseline", "guarded")]
    (scripted / "summary.json").write_text(json.dumps({"timestamp": "20260101T000000Z", "results": rows}))
    live = runs / "20260102T000000Z-live-claude-haiku"
    live.mkdir()
    def row(label, scenario, arm, **extra):
        base = {"label": label, "scenario": scenario, "arm": arm, "agent": {"tool_calls": 4, "tokens": {"input": 100, "output": 10}, "seconds": 30.0, "exit_code": 0, "error": None},
                "agent_failed": False, "notes": 0, "false_notes": 0, "stop_blocks": 0, "command_events": 2, "commands_without_exit_code": 2,
                "blocked_by_pr_check": None, "integrated_clean": True, "main_broken": False, "recovered": False, "final_healthy": True,
                "a_merge": {"triggered_by_agent_action": True}}
        return {**base, **extra}
    results = [row("S1-baseline-1", "S1", "baseline", main_broken=True, integrated_clean=False, final_healthy=False),
               row("S1-harness-1", "S1", "harness", notes=1, agent={"tool_calls": 6, "tokens": {"input": 150, "output": 20}, "seconds": 45.0, "exit_code": 0, "error": None}),
               row("S5-harness-1", "S5", "harness", notes=1, false_notes=1),
               row("S2-harness-1", "S2", "harness", agent_failed=True, agent={"tool_calls": None, "tokens": {}, "seconds": None, "exit_code": 1, "error": "usage limit"})]
    (live / "summary.json").write_text(json.dumps({"timestamp": "20260102T000000Z", "kind": "live", "agent": "claude", "model": "haiku", "results": results, "method": "m"}))
    text = render.write(tmp_path).read_text()
    assert "| S1 · rename | harness | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 1 | 6.0 | 150.0 / 20.0 | 45.0 | 0 |" in text
    assert "1 false notes (S5)" in text and "S2-harness-1: usage limit" in text
    assert "Baseline: 4/5 merges broke main" in text
    assert "tool calls +1.0" in text


def test_ablation_switches_are_evaluation_only(world, monkeypatch):
    state = prepare(world, "S1", merge_a=False)
    b = state["engineer_b"]
    payload = {"cwd": b, "session_id": "ablation", "tool_name": "Bash", "tool_input": {"command": "pytest -q"}, "tool_response": "ok"}
    monkeypatch.setenv("MERGEGUARD_FETCH_INTERVAL", "0")
    merge_change_a(world)
    monkeypatch.setenv("MERGEGUARD_NOTE_STYLE", "vague")
    vague = hooks.handle("post-tool-use", payload)["hookSpecificOutput"]["additionalContext"]
    assert "teammate" in vague and "fetch_user" not in vague
    assert "fetch_user" not in hooks.handle("stop", payload)["reason"]
    monkeypatch.delenv("MERGEGUARD_NOTE_STYLE")
    monkeypatch.setenv("MERGEGUARD_DISABLE_STOP", "1")
    assert hooks.handle("stop", payload) == {}
    monkeypatch.delenv("MERGEGUARD_DISABLE_STOP")
    monkeypatch.setenv("MERGEGUARD_DISABLE_NOTES", "1")
    assert hooks.handle("post-tool-use", {**payload, "session_id": "fresh"}) == {}
    assert hooks.handle("stop", payload)["decision"] == "block"
    assert live_compare.agent_env("vague", 5)["MERGEGUARD_NOTE_STYLE"] == "vague"
    assert live_compare.agent_env("harness", 5).get("MERGEGUARD_DISABLE_NOTES") is None
