"""Reproduce, isolate, explain, and propose an undo in disposable Git worktrees."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

from . import ledger, prs
from .git import changed_files, fetch, git, main_ref, merge_base, root, sha, worktree


def run_tests(checkout, nodeids: list[str] | None = None) -> dict:
    checkout = Path(checkout)
    requested = nodeids or []
    existing = [node for node in requested if (checkout / node.split("::")[0]).is_file()]
    if requested and not existing:
        return {"outcome": "pass", "failed": [], "missing": requested, "output": "Test files absent at this commit (pass by bisect convention)"}
    with tempfile.TemporaryDirectory(prefix="mergeguard-pytest-") as directory:
        output = Path(directory) / "result.json"
        # This harness executes repository tests, just as CI does. It is not a sandbox.
        env = {**os.environ, "MERGEGUARD_TEST_RESULT": str(output), "MERGEGUARD_DISABLE": "1", "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1", "PYTHONDONTWRITEBYTECODE": "1",
               "PYTHONPATH": os.pathsep.join([str(checkout), str(Path(__file__).resolve().parent.parent)])}
        # MERGEGUARD_PYTEST_ARGS: the repository's own pytest needs (a src-layout `-o pythonpath=…`, a `--deselect` of a test
        # known to fail at base), the same flags the project's CI uses; shell-free, split like a shell would.
        import shlex
        extra = shlex.split(os.environ.get("MERGEGUARD_PYTEST_ARGS", ""))
        # MERGEGUARD_PYTHON: the repository's own interpreter (its venv); the probe plugin is importable there via PYTHONPATH.
        python = os.environ.get("MERGEGUARD_PYTHON") or sys.executable
        command = [python, "-m", "pytest", "-q", "--tb=short", "-p", "mergeguard.pytest_probe", *extra, *existing]
        try:
            result = subprocess.run(command, cwd=checkout, env=env, text=True, capture_output=True, timeout=60)
        except subprocess.TimeoutExpired:
            return {"outcome": "error", "failed": [], "output": "pytest timed out after 60 seconds"}
        evidence = json.loads(output.read_text()) if output.exists() else {}
        missing = sorted(set(requested) - set(existing))
        if result.returncode == 0:
            outcome = "pass"
        elif result.returncode == 1 and evidence.get("failed"):
            outcome = "fail"
        elif requested and result.returncode == 4 and not evidence.get("collected") and "no match" in (result.stdout + result.stderr):
            # The file exists at this commit but the requested test functions do not (they were added later):
            # absent tests pass by the bisect convention, exactly like an absent file.
            outcome = "pass"
            missing = sorted(set(requested))
        else:
            outcome = "error"
        return {**evidence, "outcome": outcome, "missing": missing,
                "output": (result.stdout + result.stderr)[-12000:]}


def at_ref(checkout, ref, tests):
    git(checkout, "checkout", "--quiet", "--force", ref)
    git(checkout, "clean", "-fdx", "--quiet")
    return run_tests(checkout, tests)


def bisect(repo, good, bad, tests) -> tuple[str, str]:
    with worktree(repo, bad) as checkout, tempfile.TemporaryDirectory(prefix="mergeguard-bisect-") as directory:
        runner = Path(directory) / "check.py"
        runner.write_text("import sys\n" +
                          f"sys.path.insert(0, {str(Path(__file__).resolve().parent.parent)!r})\n" +
                          "from mergeguard.guardian import run_tests\n" +
                          f"result = run_tests('.', {tests!r})\n" +
                          "raise SystemExit({'pass': 0, 'fail': 1, 'error': 125}[result['outcome']])\n")
        git(checkout, "bisect", "start", "--first-parent", bad, good)
        try:
            result = subprocess.run(["git", "bisect", "run", sys.executable, str(runner)], cwd=checkout,
                                    text=True, capture_output=True, timeout=300)
            log = result.stdout + result.stderr
            if result.returncode:
                raise ValueError("Bisect could not isolate a unique culprit: " + log[-2500:])
            culprit = sha(checkout, "refs/bisect/bad")
            return culprit, log
        finally:
            git(checkout, "bisect", "reset", check=False)


def partner_search(repo, culprit, branch_head, tests) -> dict:
    main_parent = git(repo, "rev-parse", culprit + "^1")
    branch_base = merge_base(repo, branch_head, main_parent)
    candidates = [branch_base] + git(repo, "rev-list", "--first-parent", "--reverse", f"{branch_base}..{main_parent}").splitlines()
    patch = subprocess.run(["git", "-C", str(repo), "diff", "--binary", branch_base, branch_head], capture_output=True, check=True).stdout
    trials = []
    with worktree(repo, branch_base) as checkout:
        def fails(index):
            commit = candidates[index]
            git(checkout, "reset", "--hard", commit)
            git(checkout, "clean", "-fdx", "--quiet")
            applied = subprocess.run(["git", "-C", str(checkout), "apply", "--index", "--3way", "-"], input=patch, capture_output=True)
            if applied.returncode:
                raise ValueError(f"Partner search patch conflicts at {commit[:8]}; partner remains unknown")
            result = run_tests(checkout, tests)
            trials.append({"commit": commit, "outcome": result["outcome"]})
            if result["outcome"] == "error":
                raise ValueError(f"Partner search test infrastructure failed at {commit[:8]}")
            return result["outcome"] == "fail"
        if fails(0):
            return {"commit": None, "trials": trials, "reason": "Culprit delta fails even at its own base"}
        if len(candidates) == 1 or not fails(len(candidates) - 1):
            return {"commit": None, "trials": trials, "reason": "Clash could not be reproduced on first-parent main"}
        low, high = 0, len(candidates) - 1
        while high - low > 1:
            middle = (low + high) // 2
            if fails(middle):
                high = middle
            else:
                low = middle
        return {"commit": candidates[high], "trials": trials, "assumption": "failure is monotonic across the candidate interval"}


def investigate(repo=".", *, good: str, bad: str, test: str | None = None, undo: bool = True) -> dict:
    repo = root(repo)
    good, bad = sha(repo, good), sha(repo, bad)
    history = git(repo, "rev-list", "--first-parent", bad).splitlines()
    if good not in history or good == bad:
        raise ValueError("good must be an earlier first-parent ancestor of bad")
    evidence = {"good": good, "bad": bad, "repetitions": {"bad": [], "good": []}}
    with worktree(repo, bad) as checkout:
        discovery = run_tests(checkout, [test] if test else None)
        evidence["discovery"] = discovery
        if discovery["outcome"] == "error":
            return {**evidence, "status": "inconclusive", "message": "Test discovery failed; no blame or undo issued"}
        if discovery["outcome"] == "pass":
            return {**evidence, "status": "healthy", "message": "No failing tests at bad"}
        tests = discovery["failed"]
        for label, ref in (("bad", bad), ("good", good)):
            for _ in range(3):
                evidence["repetitions"][label].append(at_ref(checkout, ref, tests))
        if any(r["outcome"] == "error" for values in evidence["repetitions"].values() for r in values):
            return {**evidence, "status": "inconclusive", "message": "Test infrastructure failed during repeated runs; no blame issued"}
        # Classify per test: a flaky test next to a real break must not hide the break, and a test that already
        # fails at good was not caused by this range. Only tests failing 3/3 at bad and 0/3 at good are attributed.
        bad_runs, good_runs = evidence["repetitions"]["bad"], evidence["repetitions"]["good"]
        evidence["flaky_tests"] = [t for t in tests if not all(t in r.get("failed", []) for r in bad_runs)]
        evidence["failing_at_good"] = [t for t in tests if any(t in r.get("failed", []) for r in good_runs)]
        tests = [t for t in tests if t not in evidence["flaky_tests"] and t not in evidence["failing_at_good"]]
        if not tests:
            return {**evidence, "status": "flaky", "message": "flaky: failures were not consistent at bad and passing at good; no blame or undo issued"}
    culprit, bisect_log = bisect(repo, good, bad, tests)
    parents = git(repo, "show", "-s", "--format=%P", culprit).split()
    evidence.update(culprit=culprit, tests=tests, bisect_log=bisect_log)
    if len(parents) != 2:
        return {**evidence, "status": "inconclusive", "message": "Culprit is not a two-parent PR merge; manual recovery required"}
    with worktree(repo, parents[1]) as checkout:
        alone = run_tests(checkout, tests)
    evidence["alone"] = alone
    if alone["outcome"] == "error" or alone.get("missing"):
        return {**evidence, "status": "inconclusive", "message": "Cannot prove culprit's behavior alone (missing tests or infrastructure error)"}
    clash = alone["outcome"] == "pass"
    partner = {"commit": None}
    if clash:
        try:
            partner = partner_search(repo, culprit, parents[1], tests)
        except ValueError as exc:
            partner = {"commit": None, "reason": str(exc)}
    registry = prs.read(repo)
    original = next((p for p in registry["prs"].values() if p.get("merge_commit") == culprit), {})
    other = next((p for p in registry["prs"].values() if p.get("merge_commit") == partner.get("commit")), {})
    number, partner_number = original.get("number"), other.get("number")
    paths = changed_files(repo, parents[0], culprit)
    existing_events = ledger.read(repo)
    if not any(e["type"] == "culprit" and e.get("commit") == culprit for e in existing_events):
        ledger.append(repo, type="culprit", pr=number, commit=culprit, paths=paths, details={"incident": culprit, "tests": tests})
        if clash:
            ledger.append(repo, type="clash", pr=number, commit=culprit, paths=paths, partner_pr=partner_number,
                          details={"partner_commit": partner.get("commit"), "incident": culprit})
    undo_pr = next((p for p in registry["prs"].values() if p.get("reverts") == culprit), None)
    if undo and undo_pr is None:
        fetch(repo)
        with worktree(repo, main_ref()) as checkout:
            branch = f"mergeguard/undo-{culprit[:12]}"
            git(checkout, "checkout", "-b", branch)
            try:
                git(checkout, "-c", "user.name=mergeguard", "-c", "user.email=mergeguard@localhost", "revert", "--no-edit", "-m", "1", culprit)
            except Exception as exc:
                return {**evidence, "status": "undo_conflict", "message": f"Culprit identified but undo needs a human: {exc}",
                        "partner": partner, "pr": number, "partner_pr": partner_number}
            verification = run_tests(checkout)
            evidence["undo_validation"] = verification
            if verification["outcome"] == "fail":
                # A flaky test can fail here too. Only a failure that repeats, and is not already known flaky, rejects the undo.
                suspects = [t for t in verification.get("failed", []) if t not in evidence["flaky_tests"]]
                reruns = [run_tests(checkout, suspects) for _ in range(2)] if suspects else []
                consistent = [t for t in suspects if all(t in r.get("failed", []) for r in reruns)]
                verification["ignored_flaky"] = [t for t in verification.get("failed", []) if t not in consistent]
                verification["consistent_failures"] = consistent
                if consistent:
                    return {**evidence, "status": "undo_failed", "message": "Undo does not restore a passing suite; no PR opened",
                            "partner": partner, "pr": number, "partner_pr": partner_number}
            elif verification["outcome"] != "pass":
                return {**evidence, "status": "undo_failed", "message": "Undo validation hit a test infrastructure error; no PR opened",
                        "partner": partner, "pr": number, "partner_pr": partner_number}
            undo_pr = prs.open_pr(checkout, branch, f"Undo PR #{number}: restore main", author="mergeguard", reverts=culprit)
    cause = f"PR #{number}" if number is not None else culprit[:8]
    if clash:
        cause += f" (clashed with #{partner_number})" if partner_number else " (clash detected; partner unresolved)"
    message = f"Main broke at {culprit[:8]}. Cause: {cause}."
    if undo_pr:
        message += f" Undo PR #{undo_pr['number']} opened."
    if evidence["flaky_tests"]:
        message += " Ignored as flaky: " + ", ".join(evidence["flaky_tests"]) + "."
    return {**evidence, "status": "clash" if clash else "culprit", "pr": number, "partner_pr": partner_number,
            "partner": partner, "undo_pr": undo_pr["number"] if undo_pr else None, "message": message}
