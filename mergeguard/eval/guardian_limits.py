#!/usr/bin/env python3
"""Guardian limits: probabilistic flaky tests, long histories, a non-monotonic clash, and an ordinary defect.

Every run builds a fresh world and asks the real guardian to explain the failure between the initial commit and the
head of main. Scenery PRs after the event land with raw Git (a team with red CI keeps merging).
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import random
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "eval"))

from mergeguard import guardian, prs  # noqa: E402
from mergeguard.demo import BASE_FILES, approve_and_merge, commit, merge_without_guard, prepare, setup, write  # noqa: E402
from mergeguard.git import atomic_json, fetch, git, sha  # noqa: E402
from guardian_eval import harmless_pr  # noqa: E402
import render  # noqa: E402

PROBABILISTIC_FLAKY = '''import pathlib
import random
import tempfile


def test_latency_budget():
    """Simulated timing-dependent test: fails with probability {p} on each run, reproducibly per run number."""
    counter = pathlib.Path(tempfile.gettempdir()) / "mergeguard-flakyp-{token}"
    run = int(counter.read_text()) + 1 if counter.exists() else 1
    counter.write_text(str(run))
    assert random.Random({seed} * 1000 + run).random() >= {p}, "simulated timing-dependent failure"
'''


def land(a: Path, branch: str, title: str, files: dict, *, guarded: bool) -> str:
    fetch(a)
    git(a, "checkout", "--quiet", "-b", branch, "origin/main")
    for path, source in files.items():
        write(a, path, source)
    commit(a, title)
    pr = prs.open_pr(a, branch, title)
    return approve_and_merge(a, pr)["merge_commit"] if guarded else merge_without_guard(a, pr["number"])


def investigate(world: Path, state: dict) -> tuple[dict, float]:
    b = Path(state["engineer_b"])
    fetch(b)
    started = time.perf_counter()
    result = guardian.investigate(b, good=state["initial"], bad=sha(b, "origin/main"))
    return result, round(time.perf_counter() - started, 1)


def steps(result: dict) -> int:
    return sum(1 for line in result.get("bisect_log", "").splitlines() if line.startswith("Bisecting:"))


def flaky_case(world: Path, seed: int, p: float, *, clash: bool) -> dict:
    rng = random.Random(seed)
    setup(world)
    state = prepare(world, "S4")
    a, b = Path(state["engineer_a"]), Path(state["engineer_b"])
    index = 0
    for _ in range(rng.randint(10, 20)):
        index += 1
        harmless_pr(a, index, rng)
    token = uuid.uuid4().hex
    land(a, "observability/latency-test", "Add latency budget test",
         {"tests/test_latency.py": PROBABILISTIC_FLAKY.replace("{token}", token).replace("{seed}", str(seed)).replace("{p}", str(p))}, guarded=False)
    clash_merge = approve_and_merge(b, prs.open_pr(b, "s4/task-b", "Invoice total"))["merge_commit"] if clash else None
    for _ in range(rng.randint(10, 20)):
        index += 1
        harmless_pr(a, index, rng, guarded=False)
    result, seconds = investigate(world, state)
    blamed = result["status"] in {"clash", "culprit"}
    return {"variant": f"{'clash+' if clash else ''}flaky p={p}", "p": p, "seed": seed, "status": result["status"], "seconds": seconds,
            "main_commits": len(git(b, "rev-list", "--first-parent", "origin/main").splitlines()),
            "flaky_tests": result.get("flaky_tests"), "tests": result.get("tests"), "blamed": blamed,
            "culprit_ok": clash and result.get("culprit") == clash_merge, "partner_ok": clash and result.get("partner_pr") == state["a_pr"],
            "wrong_blame": blamed and not (clash and result.get("culprit") == clash_merge), "message": result.get("message"), "bisect_steps": steps(result)}


def long_case(world: Path, seed: int) -> dict:
    rng = random.Random(seed)
    setup(world)
    state = prepare(world, "S4")
    a, b = Path(state["engineer_a"]), Path(state["engineer_b"])
    index = 0
    for _ in range(rng.randint(60, 120)):
        index += 1
        harmless_pr(a, index, rng)
    clash_merge = approve_and_merge(b, prs.open_pr(b, "s4/task-b", "Invoice total"))["merge_commit"]
    for _ in range(rng.randint(60, 120)):
        index += 1
        harmless_pr(a, index, rng, guarded=False)
    result, seconds = investigate(world, state)
    return {"variant": "long history clash", "seed": seed, "status": result["status"], "seconds": seconds,
            "main_commits": len(git(b, "rev-list", "--first-parent", "origin/main").splitlines()),
            "culprit_ok": result.get("culprit") == clash_merge, "partner_ok": result.get("partner_pr") == state["a_pr"],
            "undo_opened": bool(result.get("undo_pr")), "bisect_steps": steps(result), "message": result.get("message")}


def non_monotonic_case(world: Path, seed: int) -> dict:
    """Main goes cents (A), back to dollars (a revert-like PR), then cents again. The failure of B's patch is not monotonic along main."""
    rng = random.Random(seed)
    setup(world)
    state = prepare(world, "S4")
    a, b = Path(state["engineer_a"]), Path(state["engineer_b"])
    index = 0
    for _ in range(rng.randint(5, 10)):
        index += 1
        harmless_pr(a, index, rng)
    back = land(a, "payments/back-to-dollars", "Back to dollar input",
                {"payments/charge.py": BASE_FILES["payments/charge.py"], "tests/test_charge.py": BASE_FILES["tests/test_charge.py"]}, guarded=True)
    for _ in range(rng.randint(5, 10)):
        index += 1
        harmless_pr(a, index, rng)
    again = land(a, "payments/cents-again", "Cents again",
                 {"payments/charge.py": 'def charge(amount):\n    """Input and output are integer cents."""\n    return amount\n',
                  "tests/test_charge.py": BASE_FILES["tests/test_charge.py"].replace("charge(5)", "charge(500)")}, guarded=True)
    for _ in range(rng.randint(5, 10)):
        index += 1
        harmless_pr(a, index, rng)
    clash_merge = approve_and_merge(b, prs.open_pr(b, "s4/task-b", "Invoice total"))["merge_commit"]
    result, seconds = investigate(world, state)
    registry = prs.read(b)
    partner_commit = result.get("partner", {}).get("commit")
    partner_number = result.get("partner_pr")
    again_number = next((p["number"] for p in registry["prs"].values() if p.get("merge_commit") == again), None)
    return {"variant": "non-monotonic clash", "seed": seed, "status": result["status"], "seconds": seconds,
            "main_commits": len(git(b, "rev-list", "--first-parent", "origin/main").splitlines()),
            "culprit_ok": result.get("culprit") == clash_merge, "partner_pr": partner_number, "partner_is_first_merge": partner_number == state["a_pr"],
            "partner_is_reapply": partner_number == again_number, "partner_reason": result.get("partner", {}).get("reason"),
            "trials": [(t["commit"][:7], t["outcome"]) for t in result.get("partner", {}).get("trials", [])], "message": result.get("message")}


def defect_case(world: Path, seed: int) -> dict:
    """An ordinary bug in B's own code on a long history; its branch tests fail, so it reaches main as a bypassed CI would."""
    rng = random.Random(seed)
    setup(world)
    state = prepare(world, "S5")
    a, b = Path(state["engineer_a"]), Path(state["engineer_b"])
    index = 0
    for _ in range(rng.randint(30, 60)):
        index += 1
        harmless_pr(a, index, rng)
    write(b, "users.py", 'def get_user(uid):\n    return {"id": 0}\n')
    commit(b, "Bug in users")
    bug_merge = merge_without_guard(b, prs.open_pr(b, "s5/task-b", "Bug")["number"])
    for _ in range(rng.randint(30, 60)):
        index += 1
        harmless_pr(a, index, rng, guarded=False)
    result, seconds = investigate(world, state)
    return {"variant": "ordinary defect, long history", "seed": seed, "status": result["status"], "seconds": seconds,
            "main_commits": len(git(b, "rev-list", "--first-parent", "origin/main").splitlines()),
            "culprit_ok": result.get("culprit") == bug_merge, "no_partner": result.get("partner_pr") is None,
            "undo_opened": bool(result.get("undo_pr")), "bisect_steps": steps(result), "message": result.get("message")}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--flaky-runs", type=int, default=6)
    parser.add_argument("--long-runs", type=int, default=3)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--world-root", type=Path, default=Path(__file__).resolve().parents[2] / "mergeguard-eval-worlds")
    args = parser.parse_args()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    raw = args.output / "runs" / f"{timestamp}-guardian-limits"
    raw.mkdir(parents=True, exist_ok=True)
    jobs = []
    for p in (0.1, 0.3, 0.5):
        jobs += [(f"flaky-{p}-{i}", lambda w, i=i, p=p: flaky_case(w, i, p, clash=False)) for i in range(1, args.flaky_runs + 1)]
    jobs += [(f"clash-flaky-0.3-{i}", lambda w, i=i: flaky_case(w, i, 0.3, clash=True)) for i in range(1, args.flaky_runs + 1)]
    jobs += [(f"long-{i}", lambda w, i=i: long_case(w, i)) for i in range(1, args.long_runs + 1)]
    jobs += [(f"nonmono-{i}", lambda w, i=i: non_monotonic_case(w, i)) for i in range(1, args.long_runs + 1)]
    jobs += [(f"defect-{i}", lambda w, i=i: defect_case(w, i)) for i in range(1, args.long_runs + 1)]
    results = []
    for label, fn in jobs:
        print(f"Running {label}...", flush=True)
        try:
            result = fn(args.world_root / raw.name / label)
        except Exception as exc:
            result = {"variant": label.rsplit("-", 1)[0], "status": "runner_error", "error": f"{type(exc).__name__}: {exc}"}
        result["label"] = label
        atomic_json(raw / f"{label}.json", result)
        results.append(result)
        print("  " + json.dumps({k: v for k, v in result.items() if k in ("status", "main_commits", "culprit_ok", "partner_ok", "wrong_blame", "bisect_steps", "seconds", "error")}), flush=True)
    atomic_json(raw / "summary.json", {"timestamp": timestamp, "kind": "guardian-limits", "results": results})
    render.write(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
