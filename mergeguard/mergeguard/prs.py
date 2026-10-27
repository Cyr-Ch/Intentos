"""A local bare origin stands in for GitHub; all mutations share one file lock.
In local mode (MERGEGUARD_MAIN names a branch) the shared repository behind the worktrees plays origin: refs are
visible everywhere, so nothing is pushed or fetched, and main is fast-forwarded in place where it is checked out."""
from __future__ import annotations

import json
from pathlib import Path

from . import gate, howmade, ledger, router, sync_check
import os

from .git import atomic_json, common_root, fetch, git, local_mode, lock, main_branch, main_ref, merge_base, root, sha, worktree
from .policy import load


def origin(repo) -> Path:
    if local_mode():
        return common_root(repo)
    remote = git(repo, "remote", "get-url", "origin")
    if remote.startswith("file://"):
        remote = remote[7:]
    result = Path(remote).expanduser()
    if not result.is_absolute():
        result = root(repo) / result
    result = result.resolve()
    if not result.is_dir() or git(result, "rev-parse", "--is-bare-repository", check=False) != "true":
        raise ValueError("Offline PRs require origin to be a local bare repository")
    return result


def registry_path(repo) -> Path:
    state_dir = os.environ.get("MERGEGUARD_STATE_DIR")
    if state_dir:
        return Path(state_dir).expanduser().resolve() / "prs.json"
    return origin(repo).parent / ".mergeguard-prs.json"


def merged_result_check(checkout, merged: str) -> dict | None:
    """MERGEGUARD_MERGE_CHECK names a command (shell-free, `{checkout}` expands to the merge's working tree) that must
    exit 0 on the merged result before main moves. A branch tests itself; this is the only test of the combination.
    A change of meaning behind an unchanged name, which the sync check cannot see, is caught here instead of on main."""
    command = os.environ.get("MERGEGUARD_MERGE_CHECK")
    if not command:
        return None
    import shlex
    import subprocess
    argv = [part.replace("{checkout}", str(checkout)) for part in shlex.split(command)]
    try:
        proc = subprocess.run(argv, cwd=checkout, capture_output=True, text=True, timeout=1800, check=False)
        output = (proc.stdout + proc.stderr).strip()
        outcome = "pass" if proc.returncode == 0 else "fail"
    except (OSError, subprocess.TimeoutExpired) as exc:
        output, outcome = str(exc), "error"
    lines = output.splitlines()
    return {"command": command, "merged": merged, "outcome": outcome, "summary": lines[-1][:300] if lines else outcome,
            "output_tail": "\n".join(lines[-40:])}


def pin_branch(repo, pr: dict) -> None:
    """Keep the reviewed head reachable under refs/mergeguard/pr/<n> while the PR is open."""
    if local_mode():
        git(repo, "update-ref", f"refs/mergeguard/pr/{pr['number']}", pr["head"])
    else:
        git(repo, "fetch", "--quiet", "origin", f"+refs/heads/{pr['branch']}:refs/mergeguard/pr/{pr['number']}")


def publish(repo, checkout, number: int, merged: str, expected: str) -> None:
    """Push an immutable reviewed merge object, then compare-and-swap the real main ref."""
    target = origin(repo)
    branch = main_branch()
    if not local_mode():
        git(checkout, "push", "--quiet", "origin", f"{merged}:refs/mergeguard/candidates/{number}")
        git(target, "update-ref", f"refs/heads/{branch}", merged, expected)
        git(target, "update-ref", "-d", f"refs/mergeguard/candidates/{number}")
        return
    checked_out = git(target, "rev-parse", "--is-bare-repository") != "true" and git(target, "symbolic-ref", "--quiet", "HEAD", check=False) == f"refs/heads/{branch}"
    if not checked_out:
        git(target, "update-ref", f"refs/heads/{branch}", merged, expected)
        return
    # main is checked out in the shared repository: move its working tree along with the ref, never past a dirty tree.
    if git(target, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError(f"{target} has uncommitted changes on {branch}; commit or stash them before merging")
    if sha(target, f"refs/heads/{branch}") != expected:
        raise ValueError("main moved during the merge; recheck the PR against the new main")
    git(target, "merge", "--quiet", "--ff-only", merged)


def read(repo) -> dict:
    path = registry_path(repo)
    return json.loads(path.read_text()) if path.exists() else {"next": 1, "prs": {}}


def _save(repo, data):
    atomic_json(registry_path(repo), data)


def get(repo, number: int) -> dict:
    try:
        return read(repo)["prs"][str(number)]
    except KeyError as exc:
        raise ValueError(f"Unknown PR #{number}") from exc


def ci_result(repo, head: str) -> dict:
    """The branch's own test suite, as PR CI would run it. Cached per head by the caller."""
    from .guardian import run_tests
    with worktree(repo, head) as checkout:
        result = run_tests(checkout)
    return {"head": head, "outcome": result["outcome"], "failed": result.get("failed", []),
            "summary": (result.get("output") or "").strip().splitlines()[-1:] and (result.get("output") or "").strip().splitlines()[-1][:200] or ""}


def _refresh(repo, pr: dict) -> dict:
    fetch(repo)
    remote_head = sha(origin(repo), f"refs/heads/{pr['branch']}")
    if remote_head != pr["head"]:
        pr["head"] = remote_head
        pr["approvals"] = []
    pin_branch(repo, pr)
    if (pr.get("ci") or {}).get("head") != pr["head"]:
        pr["ci"] = ci_result(repo, pr["head"])
    main = sha(repo, main_ref())
    base = merge_base(repo, pr["head"], main)
    decision = router.route(repo, base, pr["head"], pr["author"], howmade_data=pr["howmade"], policy_ref=main,
                            floor=pr.get("min_tier") or 0, floor_reason=pr.get("min_tier_reason"))
    sync = sync_check.check(repo, head=pr["head"], main=main)
    result = gate.evaluate(pr, decision, sync, load(repo, main))
    pr.update(decision=decision, sync=sync, gate=result, checked_main=main)
    return pr


def open_pr(repo, branch: str, title: str, *, author: str | None = None, prompter: str | None = None,
            reverts: str | None = None, min_tier: int = 0, min_tier_reason: str | None = None) -> dict:
    repo = root(repo)
    git(repo, "check-ref-format", "--branch", branch)
    if branch == main_branch():
        raise ValueError("Open a feature branch, not main")
    head = sha(repo, f"refs/heads/{branch}")
    author = author or git(repo, "config", "user.name")
    # A push is always an ordinary fast-forward push, never a force push. Local mode shares refs, so none is needed.
    if not local_mode():
        git(repo, "push", "--quiet", "origin", f"refs/heads/{branch}:refs/heads/{branch}")
    path = registry_path(repo)
    with lock(path.with_suffix(".lock")):
        data = read(repo)
        existing = next((pr for pr in data["prs"].values() if pr["branch"] == branch and pr["state"] == "open"), None)
        if existing and existing["author"] != author:
            raise ValueError("An existing PR's author cannot be changed")
        if existing:
            pr = existing
            if pr["head"] != head:
                pr["approvals"] = []
            pr.update(head=head, title=title)
        else:
            number = data["next"]
            data["next"] += 1
            pr = {"number": number, "branch": branch, "title": title, "head": head, "author": author,
                  "prompter": prompter, "state": "open", "approvals": [], "created_at": ledger.now()}
            data["prs"][str(number)] = pr
        if reverts:
            pr["reverts"] = reverts
        if min_tier:
            pr["min_tier"], pr["min_tier_reason"] = int(min_tier), min_tier_reason
        fetch(repo)
        base = merge_base(repo, head, main_ref())
        initial = router.route(repo, base, head, author, policy_ref=main_ref())
        summary = howmade.summarize(howmade.read(repo, branch), files=len(initial["paths"]), tests_modified=initial["existing_tests_modified"])
        pr.update(howmade=summary, body=howmade.markdown(summary))
        _refresh(repo, pr)
        _save(repo, data)
        return pr


def refresh(repo, number: int) -> dict:
    path = registry_path(repo)
    with lock(path.with_suffix(".lock")):
        data = read(repo)
        pr = data["prs"][str(number)]
        if pr["state"] == "open":
            _refresh(repo, pr)
            _save(repo, data)
        return pr


def approve(repo, number: int, user: str, *, kind: str = "human") -> dict:
    path = registry_path(repo)
    with lock(path.with_suffix(".lock")):
        data = read(repo)
        pr = data["prs"][str(number)]
        if pr["state"] != "open":
            raise ValueError("Only open PRs can be approved")
        _refresh(repo, pr)
        pr["approvals"] = [a for a in pr["approvals"] if a["user"].casefold() != user.casefold()]
        pr["approvals"].append({"user": user, "head": pr["head"], "kind": kind, "ts": ledger.now()})
        pr["gate"] = gate.evaluate(pr, pr["decision"], pr["sync"], load(repo))
        _save(repo, data)
        return pr


def merge(repo, number: int) -> dict:
    repo = root(repo)
    path = registry_path(repo)
    with lock(path.with_suffix(".lock")):
        data = read(repo)
        pr = data["prs"][str(number)]
        if pr["state"] != "open":
            raise ValueError("PR is already closed")
        _refresh(repo, pr)
        _save(repo, data)
        if not pr["gate"]["allowed"]:
            raise ValueError("Merge blocked: " + "\n".join(pr["gate"]["reasons"]))
        expected = pr["checked_main"]
        with worktree(repo, expected) as checkout:
            git(checkout, "-c", "user.name=mergeguard", "-c", "user.email=mergeguard@localhost", "merge", "--no-ff", "-m",
                f"Merge PR #{number}: {pr['title']}", pr["head"])
            merged = sha(checkout, "HEAD")
            if merged == expected:
                raise ValueError("PR adds no commits to main")
            if sha(origin(repo), f"refs/heads/{pr['branch']}") != pr["head"]:
                raise ValueError("PR head changed during merge; recheck and approve the new head")
            pr["merge_check"] = merged_result_check(checkout, merged)
            if pr["merge_check"] and pr["merge_check"]["outcome"] != "pass":
                _save(repo, data)
                raise ValueError("Merge blocked: the merged result failed " + pr["merge_check"]["command"] + ": " + pr["merge_check"]["summary"])
            publish(repo, checkout, number, merged, expected)
        pr.update(state="merged", merge_commit=merged, merged_at=ledger.now())
        _save(repo, data)
        ledger.append(repo, type="merged", pr=number, commit=merged, paths=pr["decision"]["paths"], tier=pr["decision"]["tier"])
        if pr.get("reverts"):
            original = next((p for p in data["prs"].values() if p.get("merge_commit") == pr["reverts"]), {})
            ledger.append(repo, type="reverted", pr=original.get("number"), commit=pr["reverts"],
                          paths=original.get("decision", {}).get("paths", pr["decision"]["paths"]),
                          details={"incident": pr["reverts"], "undo_pr": number})
        fetch(repo)
        return pr
