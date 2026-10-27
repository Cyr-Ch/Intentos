#!/usr/bin/env python3
"""Review load on real agent-made PRs: how many need no human, one, or two, under the demo policy.

Re-routes every task-B PR from the live evaluation worlds with the current router, then records who would have
reviewed it, whether it could have merged with no human, and whether that merge would have broken main.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "eval"))

from mergeguard import router, sync_check  # noqa: E402
from mergeguard.demo import POLICY  # noqa: E402
from mergeguard.git import atomic_json, git, merge_base  # noqa: E402
import render  # noqa: E402


def agent_prs(run_dir: Path):
    for result_path in sorted(run_dir.glob("*/result.json")):
        result = json.loads(result_path.read_text())
        if result.get("runner_error") or not result.get("world"):
            continue
        b = Path(result["world"]) / "engineer_b"
        registry = Path(result["world"]) / ".mergeguard-prs.json"
        if not b.is_dir() or not registry.exists():
            continue
        pr = next((p for p in json.loads(registry.read_text())["prs"].values() if p["number"] == result["pr"]), None)
        if pr:
            yield result, b, pr


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--policy", choices=["demo", "strict"], default="demo", help="demo: additive code may be tier 0; strict: only docs and comments")
    args = parser.parse_args()
    policy = {**POLICY, "zero_review_additive": args.policy == "demo"}
    rows = []
    for run_dir in sorted((args.output / "runs").glob("*-live-*")):
        for result, b, pr in agent_prs(run_dir):
            head = pr["head"]
            git(b, "fetch", "--quiet", "origin", f"+refs/heads/{pr['branch']}:refs/mergeguard/pr/{pr['number']}")
            # Route against the main the PR was checked against, as the gate did at the time.
            main = pr.get("checked_main") or "origin/main"
            base = merge_base(b, head, main)
            decision = router.route(b, base, head, pr["author"], howmade_data=pr.get("howmade"), policy=policy)
            sync = sync_check.check(b, head=head, main=main)
            rows.append({"run": run_dir.name, "label": result["label"], "scenario": result["scenario"], "arm": result["arm"],
                         "agent": result.get("agent_name"), "model": result.get("model"), "pr": pr["number"], "tier": decision["tier"],
                         "proofs": decision.get("proofs", {}), "reasons": decision["reasons"], "sync_clean": sync["clean"],
                         "no_human_merge": decision["tier"] == 0 and sync["clean"],
                         "main_broken": result.get("main_broken", False), "recovered": result.get("recovered", False)})
    if not rows:
        print("No live evaluation worlds found; run eval/live_compare.py first.")
        return 1
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    summary = {"timestamp": timestamp, "kind": "review", "policy": args.policy, "results": rows,
               "totals": {"prs": len(rows), "tier0": sum(r["tier"] == 0 for r in rows), "tier1": sum(r["tier"] == 1 for r in rows),
                          "tier2": sum(r["tier"] == 2 for r in rows), "no_human_merge": sum(r["no_human_merge"] for r in rows),
                          "blocked_stale": sum(r["tier"] == 0 and not r["sync_clean"] for r in rows),
                          "approvals_flat": len(rows), "approvals_routed": sum(r["tier"] for r in rows),
                          "no_human_merges_that_broke_main": sum(r["no_human_merge"] and r["main_broken"] for r in rows),
                          "of_which_recovered": sum(r["no_human_merge"] and r["main_broken"] and r["recovered"] for r in rows)}}
    raw = args.output / "runs" / f"{timestamp}-review"
    raw.mkdir(parents=True, exist_ok=True)
    atomic_json(raw / "summary.json", summary)
    render.write(args.output)
    print(json.dumps(summary["totals"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
