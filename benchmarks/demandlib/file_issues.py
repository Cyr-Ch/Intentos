#!/usr/bin/env python3
"""File the benchmark tickets as GitHub issues on the fork, using the GitHub CLI.

Only the `issue` text and labels reach GitHub; expected routes, invariants and acceptance plans stay here.
Usage: python3 file_issues.py [--repo Cyr-Ch/oemof-demand] [--only T01,T02] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="Cyr-Ch/oemof-demand")
    ap.add_argument("--only", help="comma-separated ticket ids")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    tickets = yaml.safe_load((HERE / "tickets.yaml").read_text())
    wanted = set(args.only.split(",")) if args.only else None
    who = subprocess.run(["gh", "api", "user", "--jq", ".login"], capture_output=True, text=True)
    if who.returncode != 0:
        print("gh is not logged in", file=sys.stderr)
        return 2
    print(f"filing as {who.stdout.strip()} on {args.repo}")
    filed = {}
    for t in tickets:
        if wanted and t["id"] not in wanted:
            continue
        body = t["issue"].rstrip() + f"\n\n<!-- benchmark ticket {t['id']} -->\n"
        cmd = ["gh", "issue", "create", "-R", args.repo, "--title", t["title"], "--body", body]
        for label in t.get("labels", []):
            cmd += ["--label", label]
        if args.dry_run:
            print(f"{t['id']}: {t['title']}")
            continue
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            # Labels the fork does not have make gh fail; retry without them rather than invent labels.
            res = subprocess.run([c for i, c in enumerate(cmd) if c != "--label" and (i == 0 or cmd[i - 1] != "--label")], capture_output=True, text=True)
        if res.returncode != 0:
            print(f"{t['id']}: failed: {res.stderr.strip()}", file=sys.stderr)
            return 1
        url = res.stdout.strip().splitlines()[-1]
        filed[t["id"]] = url
        print(f"{t['id']}: {url}")
    if filed and not args.dry_run:
        out = HERE / "issues.json"
        existing = json.loads(out.read_text()) if out.exists() else {}
        existing.update(filed)
        out.write_text(json.dumps(existing, indent=2) + "\n")
        print(f"recorded in {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
