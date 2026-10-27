#!/usr/bin/env python3
"""Guardian evaluation on realistic histories: 20-50 harmless merged PRs around a semantic clash, a real injected
flaky test, and a flaky test next to a real clash. Records culprit and partner accuracy, flaky labelling, bisect
steps, and time to report. Every number comes from running the real guardian on real Git history.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import random
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "eval"))

from mergeguard import guardian, prs  # noqa: E402
from mergeguard.demo import BASE_FILES, approve_and_merge, commit, merge_without_guard, prepare, setup, write  # noqa: E402
from mergeguard.git import atomic_json, fetch, git, sha  # noqa: E402
import render  # noqa: E402

FLAKY_TEST = '''import pathlib
import tempfile


def test_latency_budget():
    """Simulated timing-dependent test: fails on every odd run, passes on every even run."""
    counter = pathlib.Path(tempfile.gettempdir()) / "mergeguard-flaky-{token}"
    run = int(counter.read_text()) + 1 if counter.exists() else 1
    counter.write_text(str(run))
    assert run % 2 == 0, "simulated timing-dependent failure"
'''


def harmless_pr(a: Path, index: int, rng: random.Random, *, guarded: bool = True) -> dict:
    """A reviewed, unrelated change by laptop A: documentation (tier 0) or a new module (tier 1).
    Once main is already broken, CI is red for everyone; those scenery PRs land with raw Git, as a team that keeps merging would."""
    fetch(a)
    branch = f"harmless/{index}"
    git(a, "checkout", "--quiet", "-b", branch, "origin/main")
    if rng.random() < 0.5:
        write(a, f"docs/note-{index}.md", f"# Note {index}\n\nRelease note {index}.\n")
    else:
        write(a, f"feature_{index}.py", f"def feature_{index}():\n    return {index}\n")
    commit(a, f"Harmless change {index}")
    pr = prs.open_pr(a, branch, f"Harmless change {index}")
    return approve_and_merge(a, pr) if guarded else {"merge_commit": merge_without_guard(a, pr["number"])}


def build_history(world: Path, rng: random.Random, *, clash: bool, flaky: bool) -> dict:
    setup(world)
    state = prepare(world, "S4")  # A's dollars->cents change is merged; B's naive invoice total is committed on its branch
    a, b = Path(state["engineer_a"]), Path(state["engineer_b"])
    before, after = rng.randint(10, 25), rng.randint(10, 25)
    index = 0
    for _ in range(before):
        index += 1
        harmless_pr(a, index, rng)
    flaky_token = None
    if flaky:
        flaky_token = uuid.uuid4().hex
        fetch(a)
        git(a, "checkout", "--quiet", "-b", "observability/latency-test", "origin/main")
        write(a, "tests/test_latency.py", FLAKY_TEST.replace("{token}", flaky_token))
        commit(a, "Add latency budget test")
        # A flaky test passes CI on a lucky run; land it with raw Git so the history contains it either way.
        merge_without_guard(a, prs.open_pr(a, "observability/latency-test", "Add latency budget test")["number"])
    clash_merge = None
    if clash:
        clash_merge = approve_and_merge(b, prs.open_pr(b, "s4/task-b", "Invoice total"))["merge_commit"]
    for _ in range(after):
        index += 1
        # After a clash main is red; after a flaky test CI is red half the time. Either way a real team keeps merging.
        harmless_pr(a, index, rng, guarded=not (clash or flaky))
    fetch(b)
    return {"world": str(world), "b": str(b), "initial": state["initial"], "a_pr": state["a_pr"], "a_merge": state["good"],
            "clash_merge": clash_merge, "flaky_token": flaky_token, "harmless_before": before, "harmless_after": after,
            "main_commits": len(git(b, "rev-list", "--first-parent", "origin/main").splitlines()), "bad": sha(b, "origin/main")}


def run_case(world: Path, seed: int, *, clash: bool, flaky: bool) -> dict:
    rng = random.Random(seed)
    history = build_history(world, rng, clash=clash, flaky=flaky)
    b = Path(history["b"])
    started = time.perf_counter()
    result = guardian.investigate(b, good=history["initial"], bad=history["bad"])
    seconds = round(time.perf_counter() - started, 1)
    steps = sum(1 for line in result.get("bisect_log", "").splitlines() if line.startswith("Bisecting:"))
    culprit_ok = clash and result.get("culprit") == history["clash_merge"]
    partner_ok = clash and result.get("partner_pr") == history["a_pr"]
    blamed = result.get("status") in {"clash", "culprit"}
    return {"seed": seed, "variant": ("clash+flaky" if clash and flaky else "clash" if clash else "flaky"), "world": history["world"],
            "main_commits": history["main_commits"], "harmless_before": history["harmless_before"], "harmless_after": history["harmless_after"],
            "status": result.get("status"), "message": result.get("message"), "tests": result.get("tests") or result.get("discovery", {}).get("failed"),
            "flaky_tests": result.get("flaky_tests"), "culprit_ok": culprit_ok, "partner_ok": partner_ok,
            "undo_opened": bool(result.get("undo_pr")), "blamed": blamed, "bisect_steps": steps, "seconds": seconds,
            "expected": ("blame clash PR, name partner, open undo" if clash else "label flaky, blame nobody")}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--world-root", type=Path, default=Path(__file__).resolve().parents[2] / "mergeguard-eval-worlds")
    args = parser.parse_args()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    raw = args.output / "runs" / f"{timestamp}-guardian"
    raw.mkdir(parents=True, exist_ok=True)
    results = []
    for variant, clash, flaky in (("clash", True, False), ("flaky", False, True), ("clash+flaky", True, True)):
        for repeat in range(1, args.repeats + 1):
            label = f"{variant}-{repeat}"
            print(f"Running {label}...", flush=True)
            result = run_case(args.world_root / raw.name / label, seed=repeat, clash=clash, flaky=flaky)
            result["label"] = label
            atomic_json(raw / f"{label}.json", result)
            results.append(result)
            print(f"  commits={result['main_commits']} status={result['status']} culprit_ok={result['culprit_ok']} partner_ok={result['partner_ok']} "
                  f"blamed={result['blamed']} steps={result['bisect_steps']} seconds={result['seconds']}", flush=True)
    atomic_json(raw / "summary.json", {"timestamp": timestamp, "kind": "guardian", "repeats": args.repeats, "results": results})
    render.write(args.output)
    clash = [r for r in results if r["variant"] == "clash"]
    flaky = [r for r in results if r["variant"] == "flaky"]
    both = [r for r in results if r["variant"] == "clash+flaky"]
    print(f"clash: culprit {sum(r['culprit_ok'] for r in clash)}/{len(clash)}, partner {sum(r['partner_ok'] for r in clash)}/{len(clash)}; "
          f"flaky: labelled {sum(r['status'] == 'flaky' for r in flaky)}/{len(flaky)}, blamed {sum(r['blamed'] for r in flaky)}; "
          f"clash+flaky: culprit {sum(r['culprit_ok'] for r in both)}/{len(both)}, wrongly blamed {sum(r['blamed'] and not r['culprit_ok'] for r in both)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
