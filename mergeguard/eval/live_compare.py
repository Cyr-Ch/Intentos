#!/usr/bin/env python3
"""Live agent evaluation: a real coding agent performs task B while scripted change A merges mid-task.

Arms: baseline (MERGEGUARD_DISABLE=1, raw Git merge) and harness (hooks on, PR gate, guardian, undo).
Agents: claude (Claude Code, `claude -p`) or codex (`codex exec`). Both consume the same hook contract.
Every run gets a fresh bare origin and two clones; raw agent output is kept per run. Numbers are never edited.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "eval"))

from mergeguard import guardian, howmade, prs, sync_check  # noqa: E402
from mergeguard.demo import (SCENARIOS, approve_and_merge, codex_trust_override, commit, merge_change_a,  # noqa: E402
                             merge_without_guard, prepare, setup)
from mergeguard.git import atomic_json, git, sha, worktree  # noqa: E402
import render  # noqa: E402

PROMPTS = {
    "account": ("Add an account summary that shows the user's id. Implement account_summary(uid) in account.py, reusing the "
                "existing user lookup in users.py, so that account_summary(7) returns \"User 7\". Add a pytest test for it under "
                "tests/. Run python -m pytest -q before finishing."),
    "invoice": ("Add an invoice total for a list of dollar amounts, returning cents. Implement invoice_total(amounts) in "
                "invoices/total.py (make invoices a package), reusing payments.charge.charge for each amount, so that "
                "invoice_total([5, 10]) returns 1500. Add a pytest test for it under tests/. Run python -m pytest -q before finishing."),
}
TASK = {"S1": "account", "S2": "account", "S3": "account", "S4": "invoice", "S5": "account"}
# Arms are environment settings for the hooks; everything after the agent run is identical except that baseline merges with raw Git.
ARMS = {"baseline": {"MERGEGUARD_DISABLE": "1"}, "harness": {},
        "vague": {"MERGEGUARD_NOTE_STYLE": "vague"}, "stop-only": {"MERGEGUARD_DISABLE_NOTES": "1"}, "notes-only": {"MERGEGUARD_DISABLE_STOP": "1"}}
ARM_SETS = {"both": ["baseline", "harness"], "all": list(ARMS), "ablations": ["baseline", "harness", "vague", "stop-only", "notes-only"]}
MERGE_A_FALLBACK_SECONDS = 20.0


def agent_command(agent: str, model: str, clone: Path, prompt: str, out_dir: Path) -> list[str]:
    if agent == "claude":
        # Hooks come from the clone's own .claude/settings.json, exactly as in an interactive session.
        return ["claude", "-p", prompt, "--model", model, "--allowedTools", "Bash,Read,Edit,Write,MultiEdit,Glob,Grep",
                "--permission-mode", "acceptEdits", "--output-format", "stream-json", "--verbose", "--max-turns", "60",
                "--no-session-persistence"]
    if agent == "codex":
        return ["codex", "exec", "--json", "-C", str(clone), "-m", model, "-c", "model_reasoning_effort=medium",
                "-s", "workspace-write", "-c", "approval_policy=never", "-c", codex_trust_override(clone),
                "-o", str(out_dir / "agent-last-message.txt"), prompt]
    raise ValueError(f"Unknown agent {agent}")


def agent_env(arm: str, fetch_interval: float) -> dict:
    env = {key: value for key, value in os.environ.items() if key != "CLAUDECODE" and not key.startswith("CLAUDE_CODE_") and not key.startswith("MERGEGUARD_")}
    env.update(MERGEGUARD_DISABLE="0", MERGEGUARD_FETCH_INTERVAL=str(fetch_interval),
               PATH=os.pathsep.join([str(Path(sys.executable).parent), env.get("PATH", "")]))
    env.update(ARMS[arm])
    return env


def event(line: str) -> dict:
    try:
        parsed = json.loads(line)
        return parsed if isinstance(parsed, dict) else {}
    except ValueError:
        return {}


def is_action(agent: str, line: str) -> bool:
    """The agent's first tool use marks 'mid-task': change A merges after this."""
    data = event(line)
    if agent == "claude":
        content = data.get("message", {}).get("content", []) if data.get("type") == "assistant" else []
        return any(isinstance(c, dict) and c.get("type") == "tool_use" for c in content)
    return data.get("type") == "item.started"


def parse_claude(lines: list[str]) -> dict:
    summary = {"tool_calls": 0, "commands": 0, "turns": None, "tokens": {}, "cost_usd": None, "error": None, "texts": []}
    for line in lines:
        data = event(line)
        kind = data.get("type")
        if kind == "assistant":
            for item in data.get("message", {}).get("content", []):
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "tool_use":
                    summary["tool_calls"] += 1
                    summary["commands"] += item.get("name") == "Bash"
                elif item.get("type") == "text":
                    summary["texts"].append(item.get("text", ""))
        elif kind == "result":
            usage = data.get("usage", {})
            summary["tokens"] = {"input": usage.get("input_tokens", 0) + usage.get("cache_creation_input_tokens", 0) + usage.get("cache_read_input_tokens", 0),
                                 "cached": usage.get("cache_read_input_tokens", 0), "output": usage.get("output_tokens", 0)}
            summary["turns"] = data.get("num_turns")
            summary["cost_usd"] = data.get("total_cost_usd")
            if data.get("is_error") or data.get("subtype") != "success":
                summary["error"] = f"{data.get('subtype')}: {str(data.get('result', ''))[:300]}"
    return summary


def parse_codex(lines: list[str]) -> dict:
    summary = {"tool_calls": 0, "commands": 0, "turns": 0, "tokens": {"input": 0, "cached": 0, "output": 0, "reasoning": 0},
               "cost_usd": None, "error": None, "texts": []}
    for line in lines:
        data = event(line)
        kind = data.get("type")
        item = data.get("item", {}) if isinstance(data.get("item"), dict) else {}
        if kind == "item.started":
            summary["tool_calls"] += 1
            summary["commands"] += item.get("type") == "command_execution"
        elif kind == "item.completed" and item.get("type") == "agent_message":
            summary["texts"].append(item.get("text", ""))
        elif kind == "turn.completed":
            usage = data.get("usage", {})
            summary["turns"] += 1
            summary["tokens"]["input"] += usage.get("input_tokens", 0)
            summary["tokens"]["cached"] += usage.get("cached_input_tokens", 0)
            summary["tokens"]["output"] += usage.get("output_tokens", 0)
            summary["tokens"]["reasoning"] += usage.get("reasoning_output_tokens", 0)
        elif kind == "turn.failed":
            message = data.get("error", {}).get("message") if isinstance(data.get("error"), dict) else data.get("message")
            summary["error"] = summary["error"] or str(message)[:300]
        elif kind == "error":
            # Codex emits transient errors (stream reconnects) and keeps going; only a missing turn.completed makes them fatal.
            summary.setdefault("warnings", []).append(str(data.get("message"))[:200])
    if summary["turns"] == 0 and summary.get("warnings") and not summary["error"]:
        summary["error"] = summary["warnings"][-1]
    return summary


def parse(agent: str, lines: list[str]) -> dict:
    return parse_claude(lines) if agent == "claude" else parse_codex(lines)


def run_agent(agent: str, model: str, clone: Path, prompt: str, out_dir: Path, env: dict, timeout: float, on_first_action) -> tuple[dict, list[str]]:
    command = agent_command(agent, model, clone, prompt, out_dir)
    (out_dir / "agent-command.json").write_text(json.dumps(command, indent=2))
    lines: list[str] = []
    first_action = threading.Event()
    started = time.perf_counter()
    with (out_dir / "agent-events.jsonl").open("w") as sink, (out_dir / "agent-stderr.txt").open("w") as errors:
        process = subprocess.Popen(command, cwd=clone, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=errors, text=True, start_new_session=True)

        def pump():
            for line in process.stdout:
                sink.write(line)
                sink.flush()
                lines.append(line)
                if not first_action.is_set() and is_action(agent, line):
                    first_action.set()

        reader = threading.Thread(target=pump, daemon=True)
        reader.start()
        triggered = first_action.wait(MERGE_A_FALLBACK_SECONDS)
        on_first_action(triggered, round(time.perf_counter() - started, 2), len(lines))
        timed_out = False
        try:
            exit_code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGTERM)
            try:
                exit_code = process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                exit_code = process.wait()
        reader.join(timeout=10)
    summary = parse(agent, lines)
    summary.update(exit_code=exit_code, timed_out=timed_out, seconds=round(time.perf_counter() - started, 2))
    if timed_out:
        summary["error"] = summary["error"] or f"agent timed out after {timeout:.0f}s"
    return summary, lines


def case(args, label: str, scenario: str, arm: str, world: Path, out_dir: Path) -> dict:
    started = time.perf_counter()
    out_dir.mkdir(parents=True, exist_ok=True)
    guarded = arm != "baseline"
    setup(world)
    state = prepare(world, scenario, naive_b=False, merge_a=False)
    b = Path(state["engineer_b"])
    branch = f"{scenario.lower()}/task-b"
    a_merge: dict = {}

    def merge_a_mid_task(triggered: bool, after: float, events_seen: int):
        nonlocal state
        state = merge_change_a(world, state)
        a_merge.update(after_seconds=after, triggered_by_agent_action=triggered, agent_events_before=events_seen)

    agent, _ = run_agent(args.agent, args.model, b, PROMPTS[TASK[scenario]], out_dir, agent_env(arm, args.fetch_interval),
                         args.timeout, merge_a_mid_task)
    # The engineer commits whatever the agent left before opening the PR.
    agent_committed = not git(b, "status", "--porcelain")
    if not agent_committed:
        commit(b, "Task B: agent work committed by the evaluation runner")
    base = git(b, "merge-base", "HEAD", "origin/main")
    patch = git(b, "diff", base, "HEAD")
    (out_dir / "branch.patch").write_text(patch)
    evidence = howmade.read(b, branch)
    howmade_path = Path(git(b, "rev-parse", "--absolute-git-dir")) / "mergeguard" / "howmade.jsonl"
    if howmade_path.exists():
        shutil.copy(howmade_path, out_dir / "howmade.jsonl")
    notes = [e for e in evidence if e["event"] == "sync_note"]
    stop_blocks = [e for e in evidence if e["event"] == "stop_block"]
    commands = [e for e in evidence if e["event"] == "command"]
    branch_tests = guardian.run_tests(b)
    final_sync = sync_check.check(b, fetch=True)
    pr = prs.open_pr(b, branch, f"{scenario} task B ({arm}, {args.agent} {args.model})")
    blocked = None
    merged = None
    if guarded:
        try:
            merged = approve_and_merge(b, pr)["merge_commit"]
        except ValueError as exc:
            blocked = str(exc)
    else:
        merged = merge_without_guard(b, pr["number"])
    merged_tests = None
    main_broken = False
    incident = None
    recovered = False
    if merged and merged != state["good"]:
        with worktree(b, merged) as checkout:
            merged_tests = guardian.run_tests(checkout)
        main_broken = merged_tests["outcome"] != "pass"
        if guarded and main_broken:
            incident = guardian.investigate(b, good=state["good"], bad=merged)
            if incident.get("undo_pr"):
                undo = approve_and_merge(b, prs.get(b, incident["undo_pr"]))
                with worktree(b, undo["merge_commit"]) as checkout:
                    recovered = guardian.run_tests(checkout)["outcome"] == "pass"
    agent_failed = bool(agent["error"]) or agent["exit_code"] != 0 or not patch.strip()
    return {
        "label": label, "scenario": scenario, "arm": arm, "agent_name": args.agent, "model": args.model, "world": str(world),
        "agent": {k: v for k, v in agent.items() if k != "texts"}, "agent_final_text": (agent["texts"] or [""])[-1][:1000],
        "agent_failed": agent_failed, "agent_committed": agent_committed, "a_merge": a_merge, "a_pr": state["a_pr"],
        "notes": len(notes), "note_messages": [n["message"] for n in notes], "false_notes": len(notes) if scenario == "S5" else 0,
        "stop_blocks": len(stop_blocks), "command_events": len(commands),
        "commands_without_exit_code": sum(c.get("exit_code") is None for c in commands),
        "branch_tests": branch_tests["outcome"], "final_sync_clean": final_sync["clean"],
        "pr": pr["number"], "tier": pr["decision"]["tier"], "blocked_by_pr_check": blocked,
        "merge_commit": merged, "merged_tests": merged_tests["outcome"] if merged_tests else None,
        "integrated_clean": bool(merged) and merged != state["good"] and not main_broken,
        "main_broken": main_broken, "recovered": recovered, "final_healthy": not main_broken or recovered,
        "guardian": {k: incident[k] for k in ("status", "culprit", "partner_pr", "undo_pr", "message") if incident and k in incident} if incident else None,
        "seconds": round(time.perf_counter() - started, 2),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--agent", choices=["claude", "codex"], default="claude")
    parser.add_argument("--model", default=None, help="claude: haiku|sonnet|opus; codex: e.g. gpt-6-astra")
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--scenario", choices=SCENARIOS, action="append")
    parser.add_argument("--arm", action="append", choices=list(ARMS) + list(ARM_SETS), help="repeatable; default both")
    parser.add_argument("--parallel", type=int, default=2)
    parser.add_argument("--timeout", type=float, default=900.0, help="Seconds before an agent run is killed")
    parser.add_argument("--fetch-interval", type=float, default=5.0,
                        help="MERGEGUARD_FETCH_INTERVAL for the agent's hooks; the demo task is far shorter than the 60s default")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--world-root", type=Path, default=Path(__file__).resolve().parents[2] / "mergeguard-eval-worlds")
    args = parser.parse_args()
    args.model = args.model or {"claude": "haiku", "codex": "gpt-6-astra"}[args.agent]
    if args.repeats < 1 or args.parallel < 1:
        parser.error("--repeats and --parallel must be positive")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    raw_path = args.output / "runs" / f"{timestamp}-live-{args.agent}-{args.model}"
    raw_path.mkdir(parents=True, exist_ok=True)
    arms = []
    for choice in args.arm or ["both"]:
        for arm in ARM_SETS.get(choice, [choice]):
            if arm not in arms:
                arms.append(arm)
    jobs = [(f"{scenario}-{arm}-{repeat}", scenario, arm)
            for repeat in range(1, args.repeats + 1) for scenario in (args.scenario or list(SCENARIOS)) for arm in arms]
    results = []
    lock = threading.Lock()

    def run(job):
        label, scenario, arm = job
        print(f"Running {label} ({args.agent} {args.model})...", flush=True)
        try:
            result = case(args, label, scenario, arm, args.world_root / raw_path.name / label, raw_path / label)
        except Exception as exc:  # A crashed run is still a recorded run.
            result = {"label": label, "scenario": scenario, "arm": arm, "agent_name": args.agent,
                      "model": args.model, "runner_error": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc(),
                      "agent": {"tool_calls": None, "commands": None, "tokens": {}, "seconds": None, "exit_code": None, "error": str(exc)},
                      "agent_failed": True, "notes": 0, "false_notes": 0, "stop_blocks": 0, "command_events": 0,
                      "commands_without_exit_code": 0, "blocked_by_pr_check": None, "integrated_clean": False,
                      "main_broken": False, "recovered": False, "final_healthy": True, "seconds": None}
        atomic_json(raw_path / label / "result.json", result)
        with lock:
            results.append(result)
        print(f"  {label}: notes={result['notes']} stop_blocks={result['stop_blocks']} blocked={bool(result.get('blocked_by_pr_check'))} "
              f"main_broken={result['main_broken']} recovered={result['recovered']} agent_failed={result['agent_failed']}", flush=True)

    with ThreadPoolExecutor(max_workers=args.parallel) as pool:
        list(pool.map(run, jobs))
    results.sort(key=lambda r: [j[0] for j in jobs].index(r["label"]))
    summary = {"timestamp": timestamp, "kind": "live", "agent": args.agent, "model": args.model, "repeats": args.repeats,
               "fetch_interval": args.fetch_interval, "parallel": args.parallel, "arms": arms, "results": results,
               "method": ("Each run: fresh bare origin and two clones; change A is opened as a PR on laptop A; the agent starts on "
                          "laptop B; A is approved by simulated humans and merged after the agent's first tool call "
                          f"(fallback {MERGE_A_FALLBACK_SECONDS:.0f}s); the agent's uncommitted work is committed by the runner; "
                          "the branch is tested alone, opened as a PR, and integrated: every arm but baseline through the real gate and "
                          "guardian, baseline through raw Git. Arms: baseline (hooks off); harness; vague (the same hooks deliver a "
                          "non-specific warning); stop-only (no notes during the task, only the Stop gate); notes-only (notes, no Stop gate). "
                          "Hooks fetch at most every "
                          f"{args.fetch_interval:g}s in this evaluation (default 60s) because the task takes about a minute.")}
    atomic_json(raw_path / "summary.json", summary)
    render.write(args.output)
    print(f"Results: {args.output / 'results.md'}")
    return 0 if not any(r["agent_failed"] for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
