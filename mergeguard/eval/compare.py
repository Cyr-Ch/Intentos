#!/usr/bin/env python3
"""Paired, deterministic scenario evaluation. This does not claim model efficacy."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import time

from mergeguard import guardian, howmade, prs
from mergeguard.demo import SCENARIOS, approve_and_merge, change_b, commit, merge_without_guard, prepare, setup
from mergeguard.git import atomic_json, git, worktree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render  # noqa: E402


def source_digest():
    package = Path(__file__).resolve().parents[1] / "mergeguard"
    digest = hashlib.sha256()
    for file in sorted(package.glob("*.py")):
        digest.update(file.name.encode())
        digest.update(file.read_bytes())
    return digest.hexdigest()


def case(directory: Path, scenario: str, guarded: bool) -> dict:
    started = time.perf_counter()
    tool_digest = source_digest()
    setup(directory)
    state = prepare(directory, scenario)
    b = Path(state["engineer_b"])
    alone = guardian.run_tests(b)
    payload = {"cwd": str(b), "session_id": "evaluation", "tool_name": "Bash", "hook_event_name": "PostToolUse",
               "tool_input": {"command": "pytest -q"}, "tool_response": {"exit_code": alone["exit_code"]}}
    env = {**os.environ, "MERGEGUARD_DISABLE": "0" if guarded else "1"}
    hook_started = time.perf_counter()
    hook = subprocess.run([sys.executable, "-m", "mergeguard.hooks", "post-tool-use"], input=json.dumps(payload),
                          text=True, capture_output=True, cwd=b, env=env, check=True)
    hook_ms = (time.perf_counter() - hook_started) * 1000
    output = json.loads(hook.stdout)
    notes = howmade.summarize(howmade.read(b))["sync_notes"]
    repaired = guarded and notes > 0
    if repaired:
        git(b, "merge", "--no-edit", "origin/main")
        change_b(b, scenario, repaired=True)
        commit(b, "Scripted repair in response to specific sync note")
    branch_after = guardian.run_tests(b)
    pr = prs.open_pr(b, f"{scenario.lower()}/task-b", f"{scenario} task B ({'guarded' if guarded else 'baseline'})")
    if guarded:
        merged = approve_and_merge(b, pr)["merge_commit"]
    else:
        merged = merge_without_guard(b, pr["number"])
    with worktree(b, merged) as checkout:
        merged_tests = guardian.run_tests(checkout)
    recovered = False
    incident = None
    if guarded and merged_tests["outcome"] == "fail":
        incident = guardian.investigate(b, good=state["good"], bad=merged)
        if incident.get("undo_pr"):
            undo = approve_and_merge(b, prs.get(b, incident["undo_pr"]))
            with worktree(b, undo["merge_commit"]) as checkout:
                recovered = guardian.run_tests(checkout)["outcome"] == "pass"
    result = {"scenario": scenario, "arm": "guarded" if guarded else "baseline", "world": str(directory), "tool_sha256": tool_digest,
              "notes": notes, "hook_ms": round(hook_ms, 2), "hook_output": output, "hook_stderr": hook.stderr,
              "branch_before": alone, "branch_after": branch_after, "scripted_repair": repaired,
              "merged_tests": merged_tests, "main_broken": merged_tests["outcome"] != "pass", "recovered": recovered,
              "final_healthy": merged_tests["outcome"] == "pass" or recovered, "guardian": incident,
              "pr": pr["number"], "merge_commit": merged, "seconds": round(time.perf_counter() - started, 2)}
    expected_notes = SCENARIOS[scenario]["expected_notes"] if guarded else 0
    result["expected_checks_passed"] = (
        source_digest() == tool_digest and alone["outcome"] == "pass" and branch_after["outcome"] == "pass" and notes == expected_notes and
        result["main_broken"] == (scenario != "S5" if not guarded else scenario == "S4") and
        (result["final_healthy"] if guarded else True) and
        (incident is None or incident["status"] == "clash" and incident["partner_pr"] == state["a_pr"]))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--scenario", choices=SCENARIOS, action="append")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--world-root", type=Path, default=Path(__file__).resolve().parents[2] / "mergeguard-eval-worlds")
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats must be positive")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    raw_path = args.output / "runs" / timestamp
    raw_path.mkdir(parents=True, exist_ok=True)
    results = []
    for repeat in range(1, args.repeats + 1):
        for scenario in args.scenario or SCENARIOS:
            for guarded in (False, True):
                arm = "guarded" if guarded else "baseline"
                label = f"{scenario}-{arm}-{repeat}"
                print(f"Running {label}...", flush=True)
                result = case(args.world_root / timestamp / label, scenario, guarded)
                atomic_json(raw_path / (label + ".json"), result)
                results.append(result)
                print(f"  notes={result['notes']} main_broken={result['main_broken']} recovered={result['recovered']} expected={result['expected_checks_passed']}", flush=True)
    atomic_json(raw_path / "summary.json", {"timestamp": timestamp, "kind": "scripted", "results": results})
    render.write(args.output)
    print(f"Results: {args.output / 'results.md'}")
    return 0 if all(r["expected_checks_passed"] for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
