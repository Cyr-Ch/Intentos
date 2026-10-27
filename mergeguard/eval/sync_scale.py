#!/usr/bin/env python3
"""Sync check at scale: precision, recall, and latency on generated repositories with known ground truth.

For each repository size, a synthetic package is generated, committed as main, and used as the base of a feature branch.
Each trial applies one API change on main (rename, move, required parameter added, parameter removed, positional reorder,
removal; or a harmless optional parameter / body change) and writes one use on the branch (from-import call,
module-attribute call, aliased call; or a call to a different symbol; or one of the documented blind spots: getattr
dispatch and a method on an object of unknown type). The real sync check runs; its verdict is compared with the truth.
Latency is measured for the check itself and for the hook adapter's cached and fetching paths.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import random
import shutil
import statistics
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "eval"))

from mergeguard import hooks, sync_check  # noqa: E402
from mergeguard.demo import commit, write  # noqa: E402
from mergeguard.git import atomic_json, git, sha  # noqa: E402
import render  # noqa: E402

CHANGES = ["rename", "move", "add_required_param", "remove_param", "reorder_params", "remove", "add_optional_param", "body_change"]
USES = ["from_import_call", "module_attr_call", "alias_call", "other_symbol", "dynamic_getattr", "unknown_method"]
POSITIVE_CHANGES = {"rename", "move", "add_required_param", "remove_param", "reorder_params", "remove"}
EXPLICIT_USES = {"from_import_call", "module_attr_call", "alias_call"}
BLIND_USES = {"dynamic_getattr", "unknown_method"}


def generate(repo: Path, modules: int, functions: int) -> list[tuple[str, str]]:
    symbols = []
    write(repo, "pkg/__init__.py", "")
    for m in range(modules):
        lines = ["import math", ""]
        for f in range(functions):
            name = f"f{m}_{f}"
            lines += [f"def {name}(a, b):", f"    return math.floor(a) + b + {m * functions + f}", "", ""]
            symbols.append((f"pkg.m{m}", name))
        lines += [f"class Service{m}:", "    def run(self, x, y):", "        return x + y", "", ""]
        write(repo, f"pkg/m{m}.py", "\n".join(lines))
    write(repo, "README.md", "# synthetic\n")
    return symbols


def apply_change(repo: Path, module: str, name: str, kind: str) -> dict:
    path = module.replace(".", "/") + ".py"
    source = (repo / path).read_text()
    header = f"def {name}(a, b):"
    assert header in source, (path, name)
    body_line = source.split(header)[1].splitlines()[1]
    if kind == "rename":
        source = source.replace(header, f"def {name}_v2(a, b):")
    elif kind == "move":
        definition = header + "\n" + body_line + "\n"
        source = source.replace(definition, "")
        target = repo / "pkg" / "moved.py"
        target.write_text((target.read_text() if target.exists() else "import math\n\n") + "\n" + definition)
    elif kind == "add_required_param":
        source = source.replace(header, f"def {name}(a, b, c):")
    elif kind == "remove_param":
        source = source.replace(header, f"def {name}(a):")
    elif kind == "reorder_params":
        source = source.replace(header, f"def {name}(b, a):")
    elif kind == "remove":
        source = source.replace(header + "\n" + body_line + "\n", "")
    elif kind == "add_optional_param":
        source = source.replace(header, f"def {name}(a, b, c=0):")
    elif kind == "body_change":
        source = source.replace(body_line, body_line + " + 1")
    (repo / path).write_text(source)
    return {"kind": kind, "module": module, "name": name}


def write_use(repo: Path, module: str, name: str, kind: str, other: str) -> str:
    if kind == "from_import_call":
        source = f"from {module} import {name}\n\n\ndef consumer():\n    return {name}(1, 2)\n"
    elif kind == "module_attr_call":
        source = f"import {module}\n\n\ndef consumer():\n    return {module}.{name}(1, 2)\n"
    elif kind == "alias_call":
        source = f"from {module} import {name} as helper\n\n\ndef consumer():\n    return helper(1, 2)\n"
    elif kind == "other_symbol":
        source = f"from {module} import {other}\n\n\ndef consumer():\n    return {other}(1, 2)\n"
    elif kind == "dynamic_getattr":
        source = f"import {module}\n\n\ndef consumer():\n    return getattr({module}, '{name}')(1, 2)\n"
    else:
        source = f"def consumer(obj):\n    return obj.{name}(1, 2)\n"
    write(repo, "consumer.py", source)
    return source


def expected(change: str, use: str) -> str:
    if change in POSITIVE_CHANGES and use in EXPLICIT_USES:
        return "issue"
    if change in POSITIVE_CHANGES and use in BLIND_USES:
        return "blind"
    return "clean"


def run_size(modules: int, functions: int, seeds: int, rng: random.Random) -> dict:
    with tempfile.TemporaryDirectory(prefix="mergeguard-scale-") as directory:
        repo = Path(directory) / "repo"
        origin = Path(directory) / "origin.git"
        repo.mkdir()
        git(repo, "init", "--quiet", "--initial-branch=main")
        git(repo, "config", "user.name", "scale")
        git(repo, "config", "user.email", "scale@example.test")
        symbols = generate(repo, modules, functions)
        write(repo, ".mergeguard/policy.yaml", "trusted_authors: [scale]\n")
        base = commit(repo, "Base")
        git(Path(directory), "init", "--quiet", "--bare", str(origin))
        git(repo, "remote", "add", "origin", str(origin))
        git(repo, "push", "--quiet", "-u", "origin", "main")
        trials = []
        timings = []
        for change in CHANGES:
            for use in USES:
                for seed in range(seeds):
                    module, name = rng.choice(symbols)
                    other = next(n for m, n in symbols if m == module and n != name)
                    git(repo, "checkout", "--quiet", "main")
                    apply_change(repo, module, name, change)
                    head = commit(repo, f"{change} {module}.{name}")
                    git(repo, "push", "--quiet", "origin", "main")
                    git(repo, "checkout", "--quiet", "-b", f"trial-{len(trials)}", base)
                    write_use(repo, module, name, use, other)
                    started = time.perf_counter()
                    result = sync_check.check(repo, fetch=True)
                    elapsed = (time.perf_counter() - started) * 1000
                    verdict = "issue" if not result["clean"] else "clean"
                    truth = expected(change, use)
                    trials.append({"change": change, "use": use, "seed": seed, "symbol": f"{module}.{name}", "truth": truth, "verdict": verdict,
                                   "issue_ids": [i["id"] for i in result["issues"]], "ms": round(elapsed, 1)})
                    timings.append(elapsed)
                    git(repo, "checkout", "--quiet", "--force", "main")
                    git(repo, "clean", "-fdq")
                    git(repo, "reset", "--quiet", "--hard", base)
                    git(repo, "push", "--quiet", "--force", "origin", "main")
        # Hook adapter latency: first call fetches, second is within the throttle window.
        git(repo, "checkout", "--quiet", "-b", "hook-timing", base)
        write_use(repo, symbols[0][0], symbols[0][1], "from_import_call", symbols[1][1])
        payload = {"cwd": str(repo), "session_id": "scale", "tool_name": "Bash", "tool_input": {"command": "pytest -q"}, "tool_response": "ok"}
        os.environ["MERGEGUARD_FETCH_INTERVAL"] = "3600"
        started = time.perf_counter(); hooks.handle("post-tool-use", payload); with_fetch = (time.perf_counter() - started) * 1000
        cached = []
        for _ in range(5):
            started = time.perf_counter(); hooks.handle("post-tool-use", payload); cached.append((time.perf_counter() - started) * 1000)
        os.environ.pop("MERGEGUARD_FETCH_INTERVAL", None)
    explicit = [t for t in trials if t["truth"] == "issue"]
    blind = [t for t in trials if t["truth"] == "blind"]
    clean = [t for t in trials if t["truth"] == "clean"]
    tp = sum(t["verdict"] == "issue" for t in explicit)
    fp = sum(t["verdict"] == "issue" for t in clean)
    fn = len(explicit) - tp
    by_change = {c: {"recall": f"{sum(t['verdict'] == 'issue' for t in explicit if t['change'] == c)}/{sum(t['change'] == c for t in explicit)}"} for c in sorted(POSITIVE_CHANGES)}
    return {"modules": modules, "functions_per_module": functions, "symbols": len(symbols), "python_files": modules + 1, "trials": len(trials),
            "explicit_positives": len(explicit), "true_positives": tp, "false_positives": fp, "false_negatives": fn,
            "precision": round(tp / (tp + fp), 4) if tp + fp else None, "recall": round(tp / len(explicit), 4) if explicit else None,
            "false_positive_rate": round(fp / len(clean), 4) if clean else None, "clean_trials": len(clean),
            "blind_spot_trials": len(blind), "blind_spot_caught": sum(t["verdict"] == "issue" for t in blind),
            "recall_by_change": by_change,
            "check_ms_mean": round(statistics.fmean(timings), 1), "check_ms_p95": round(sorted(timings)[int(0.95 * (len(timings) - 1))], 1),
            "hook_ms_with_fetch": round(with_fetch, 1), "hook_ms_cached_mean": round(statistics.fmean(cached), 1),
            "misclassified": [t for t in trials if (t["truth"] == "issue") != (t["verdict"] == "issue") and t["truth"] != "blind"][:20]}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sizes", default="10,50,200", help="modules per generated repo")
    parser.add_argument("--functions", type=int, default=8)
    parser.add_argument("--seeds", type=int, default=3, help="trials per (change, use) pair")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    rng = random.Random(7)
    sizes = []
    for modules in [int(x) for x in args.sizes.split(",")]:
        print(f"size {modules} modules...", flush=True)
        result = run_size(modules, args.functions, args.seeds, rng)
        print(f"  trials={result['trials']} precision={result['precision']} recall={result['recall']} fp={result['false_positives']} "
              f"check_ms={result['check_ms_mean']} hook_cached_ms={result['hook_ms_cached_mean']}", flush=True)
        sizes.append(result)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    raw = args.output / "runs" / f"{timestamp}-scale"
    raw.mkdir(parents=True, exist_ok=True)
    atomic_json(raw / "summary.json", {"timestamp": timestamp, "kind": "scale", "seeds": args.seeds, "sizes": sizes})
    render.write(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
