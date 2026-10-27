"""Deterministic two-laptop scenarios, reusable by the demo and evaluation runner."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import sys

import yaml

from . import guardian, hooks, ledger, prs, report, sync_check
from .git import atomic_json, fetch, git, sha, worktree


BASE_FILES = {
    "users.py": 'def get_user(uid):\n    return {"id": uid}\n',
    "account.py": 'def health():\n    return "ok"\n',
    "payments/__init__.py": "",
    "payments/charge.py": 'def charge(amount):\n    """Return the captured amount in cents; input is dollars."""\n    return round(amount * 100)\n',
    "tests/test_users.py": 'from users import get_user\n\ndef test_user():\n    assert get_user(7) == {"id": 7}\n',
    "tests/test_charge.py": 'from payments.charge import charge\n\ndef test_charge():\n    assert charge(5) == 500\n',
    "README.md": "# Tiny shop\n\nA deliberately small Python service for the two-laptop demonstration.\n",
    "pyproject.toml": '[tool.pytest.ini_options]\ntestpaths = ["tests"]\npythonpath = ["."]\n',
    ".gitignore": "__pycache__/\n.pytest_cache/\n*.pyc\n",
}

POLICY = {"trusted_authors": ["engineer_a", "engineer_b"],
          "always_two": ["payments/", ".github/workflows/", ".mergeguard/", ".codex/", ".claude/"],
          "always_one": [], "zero_review_allowed": True, "zero_review_additive": True, "prompter_counts_as_reviewer": False, "api_break_tier": 2,
          "breaker": {"window_days": 7, "strikes_to_trip": 2, "cooldown_days": 14}}

SCENARIOS = {
    "S1": {"name": "rename", "prompt": "Add an account summary that shows the user's id.", "expected_notes": 1},
    "S2": {"name": "required parameter", "prompt": "Add an account summary that shows the user's id.", "expected_notes": 1},
    "S3": {"name": "module move", "prompt": "Add an account summary that shows the user's id.", "expected_notes": 1},
    "S4": {"name": "dollars → cents (semantic blind spot)", "prompt": "Add an invoice total for a list of dollar amounts, returning cents.", "expected_notes": 0},
    "S5": {"name": "unrelated change (control)", "prompt": "Add an account summary that shows the user's id.", "expected_notes": 0},
}


def write(repo, path, source):
    target = Path(repo) / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(source)


def commit(repo, message):
    git(repo, "add", "--all")
    git(repo, "commit", "--quiet", "-m", message)
    return sha(repo, "HEAD")


HOOK_LABELS = {"SessionStart": "session_start", "PostToolUse": "post_tool_use", "Stop": "stop",
               "PreToolUse": "pre_tool_use", "UserPromptSubmit": "user_prompt_submit", "SessionEnd": "session_end"}


def hook_config(python: str | None = None) -> dict:
    """One hook definition serves both agents: Codex reads .codex/hooks.json, Claude Code reads .claude/settings.json."""
    # -I: isolated mode, so a `mergeguard/` directory inside the agent's repository never shadows the installed package.
    command = f"{shlex.quote(python or sys.executable)} -I -m mergeguard.hooks"
    return {"hooks": {
        "SessionStart": [{"hooks": [{"type": "command", "command": command + " session-start", "timeout": 20}]}],
        "PostToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": command + " post-tool-use", "timeout": 20}]}],
        "Stop": [{"hooks": [{"type": "command", "command": command + " stop", "timeout": 20}]}]}}


HOOK_FILES = (".codex/config.toml", ".codex/hooks.json", ".claude/settings.json")


def write_hooks(directory, config: dict | None = None) -> list[Path]:
    """Write the hook files into a worktree: the same files the demo world commits, for a worktree that must not
    carry them in its diff (the caller removes them again with remove_hooks before anything inspects the tree)."""
    directory = Path(directory)
    config = config or hook_config()
    write(directory, ".codex/config.toml", "# Verified against codex-cli 0.154.0; older codex_hooks flag is obsolete.\n[features]\nhooks = true\n")
    write(directory, ".codex/hooks.json", json.dumps(config, indent=2) + "\n")
    write(directory, ".claude/settings.json", json.dumps(config, indent=2) + "\n")
    return [directory / name for name in HOOK_FILES]


def remove_hooks(directory) -> list[Path]:
    directory = Path(directory)
    removed = []
    for name in HOOK_FILES:
        file = directory / name
        if file.is_file():
            file.unlink()
            removed.append(file)
        parent = file.parent
        if parent.is_dir() and parent != directory and not any(parent.iterdir()):
            parent.rmdir()
    return removed


def codex_hook_hash(event_label: str, group: dict, hook: dict) -> str:
    """Codex's hook trust identity (codex-rs hooks/engine/discovery.rs hook_hash + config/fingerprint.rs version_for_toml):
    the normalized handler plus matcher and event label, serialized with sorted keys, SHA-256. Verified against trusted
    entries that the interactive `/hooks` review had already written."""
    timeout = int(hook.get("timeout", 600))
    timeout = min(max(timeout, 1), 3) if event_label in {"session_end", "interrupt"} else max(timeout, 1)
    handler = {"type": "command", "command": hook["command"], "timeout": timeout, "async": bool(hook.get("async", False))}
    if hook.get("statusMessage") is not None:
        handler["statusMessage"] = hook["statusMessage"]
    limit = hook.get("additionalContextLimit")
    if limit is not None and limit != 2500 and event_label != "post_compact":
        handler["additionalContextLimit"] = limit
    identity = {"event_name": event_label, "hooks": [handler]}
    if group.get("matcher") is not None:
        identity["matcher"] = group["matcher"]
    serialized = json.dumps(identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return "sha256:" + hashlib.sha256(serialized).hexdigest()


def write_codex_home(directory, config: dict | None = None, auth_from=None) -> list[Path]:
    """A private CODEX_HOME for one agent session: these hooks, hooks enabled, and the user's own credentials by
    symlink (never copied). Codex loads project `.codex/` only below a `.git` *directory*, so a git worktree (whose
    `.git` is a file) never sees project hooks; `$CODEX_HOME/hooks.json` is read regardless of the working directory.
    The user's ~/.codex is not modified."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    config = config or hook_config()
    (directory / "hooks.json").write_text(json.dumps(config, indent=2) + "\n")
    (directory / "config.toml").write_text("# Private CODEX_HOME written by mergeguard for one session.\n[features]\nhooks = true\n")
    auth_from = Path(auth_from) if auth_from else Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "auth.json"
    link = directory / "auth.json"
    if auth_from.is_file() and not link.exists():
        link.symlink_to(auth_from)
    return [directory / "hooks.json", directory / "config.toml"]


def codex_trust_override(clone, hooks_file=None) -> str:
    """A `-c` override that trusts exactly this clone's hook definitions, pinned by hash: the same record the
    interactive `/hooks` review writes to the user config, scoped to one invocation. It never touches ~/.codex.
    `hooks_file` names a hooks.json outside a project layout (a private CODEX_HOME)."""
    path = Path(hooks_file).resolve() if hooks_file else (Path(clone).resolve() / ".codex" / "hooks.json")
    config = json.loads(path.read_text())
    entries = []
    for event, groups in config["hooks"].items():
        label = HOOK_LABELS[event]
        for group_index, group in enumerate(groups):
            for handler_index, hook in enumerate(group["hooks"]):
                key = f"{path}:{label}:{group_index}:{handler_index}"
                entries.append(f'"{key}" = {{ trusted_hash = "{codex_hook_hash(label, group, hook)}", enabled = true }}')
    return "hooks.state = { " + ", ".join(entries) + " }"


def setup(world: Path) -> dict:
    world = world.expanduser().resolve()
    tool_repo = Path(__file__).resolve().parent.parent
    if world == tool_repo or tool_repo in world.parents:
        raise ValueError("Create the demo world outside the mergeguard tool repository")
    if world.exists() and any(world.iterdir()):
        raise ValueError(f"Demo world already exists: {world}. Choose a fresh path; setup never deletes existing work.")
    world.mkdir(parents=True, exist_ok=True)
    origin, first, second = world / "origin.git", world / "engineer_a", world / "engineer_b"
    git(world, "init", "--bare", "--initial-branch=main", str(origin))
    git(world, "clone", str(origin), str(first))
    git(first, "config", "user.name", "engineer_a")
    git(first, "config", "user.email", "engineer_a@mergeguard.local")
    for path, source in BASE_FILES.items():
        write(first, path, source)
    write(first, ".mergeguard/policy.yaml", yaml.safe_dump(POLICY, sort_keys=False))
    write(first, ".codex/config.toml", "# Verified against codex-cli 0.154.0; older codex_hooks flag is obsolete.\n[features]\nhooks = true\n")
    config = hook_config()
    write(first, ".codex/hooks.json", json.dumps(config, indent=2) + "\n")
    write(first, ".claude/settings.json", json.dumps(config, indent=2) + "\n")
    initial = commit(first, "Initial shop app and mergeguard policy")
    git(first, "push", "--quiet", "-u", "origin", "main")
    git(world, "clone", str(origin), str(second))
    git(second, "config", "user.name", "engineer_b")
    git(second, "config", "user.email", "engineer_b@mergeguard.local")
    state = {"world": str(world), "initial": initial, "origin": str(origin), "engineer_a": str(first), "engineer_b": str(second)}
    atomic_json(world / "state.json", state)
    return state


def change_a(repo, scenario):
    if scenario == "S1":
        write(repo, "users.py", BASE_FILES["users.py"].replace("get_user", "fetch_user"))
        write(repo, "tests/test_users.py", BASE_FILES["tests/test_users.py"].replace("get_user", "fetch_user"))
    elif scenario == "S2":
        write(repo, "users.py", 'def get_user(uid, org_id):\n    return {"id": uid, "org_id": org_id}\n')
        write(repo, "tests/test_users.py", 'from users import get_user\n\ndef test_user():\n    assert get_user(7, "acme") == {"id": 7, "org_id": "acme"}\n')
    elif scenario == "S3":
        (Path(repo) / "users.py").unlink()
        write(repo, "accounts/__init__.py", "")
        write(repo, "accounts/users.py", BASE_FILES["users.py"])
        write(repo, "tests/test_users.py", BASE_FILES["tests/test_users.py"].replace("from users", "from accounts.users"))
    elif scenario == "S4":
        write(repo, "payments/charge.py", 'def charge(amount):\n    """Input and output are now integer cents."""\n    return amount\n')
        write(repo, "tests/test_charge.py", BASE_FILES["tests/test_charge.py"].replace("charge(5)", "charge(500)"))
    else:
        write(repo, "catalog.py", 'def categories():\n    return ["books", "stationery"]\n')


def change_b(repo, scenario, *, repaired=False):
    if scenario == "S4":
        write(repo, "invoices/__init__.py", "")
        write(repo, "invoices/total.py", 'from payments.charge import charge\n\ndef invoice_total(amounts):\n    return sum(charge(value) for value in amounts)\n')
        write(repo, "tests/test_invoice.py", 'from invoices.total import invoice_total\n\ndef test_invoice_total():\n    assert invoice_total([5, 10]) == 1500\n')
    else:
        module = "accounts.users" if repaired and scenario == "S3" else "users"
        function = "fetch_user" if repaired and scenario == "S1" else "get_user"
        arg = 'uid, "acme"' if repaired and scenario == "S2" else "uid"
        write(repo, "account.py", BASE_FILES["account.py"] + f'\n\ndef account_summary(uid):\n    import {module}\n    user = {module}.{function}({arg})\n    return f"User {{user[\'id\']}}"\n')
        write(repo, "tests/test_account.py", 'from account import account_summary\n\ndef test_summary():\n    assert account_summary(7) == "User 7"\n')


def approve_and_merge(repo, pr):
    # Named reviewers are explicit simulated people, never agent approvals.
    for reviewer in ("priya", "sam")[:pr["decision"]["tier"]]:
        prs.approve(repo, pr["number"], reviewer)
    return prs.merge(repo, pr["number"])


def prepare(world: Path, scenario: str, *, naive_b: bool = True, merge_a: bool = True) -> dict:
    """Branch both laptops from the same base. Change A is opened as a PR and, unless merge_a is False, merged now."""
    state = json.loads((world / "state.json").read_text())
    a, b = Path(state["engineer_a"]), Path(state["engineer_b"])
    git(a, "checkout", "-b", f"{scenario.lower()}/change-a", state["initial"])
    git(b, "checkout", "-b", f"{scenario.lower()}/task-b", state["initial"])
    if naive_b:
        change_b(b, scenario)
        commit(b, f"{scenario}: naive task B")
    change_a(a, scenario)
    commit(a, f"{scenario}: scripted change A")
    first = prs.open_pr(a, f"{scenario.lower()}/change-a", f"{scenario}: {SCENARIOS[scenario]['name']}")
    state.update(scenario=scenario, a_pr=first["number"], a_merged=False, task=SCENARIOS[scenario]["prompt"])
    atomic_json(world / "state.json", state)
    return merge_change_a(world, state, fetch_b=True) if merge_a else state


def merge_change_a(world: Path, state: dict | None = None, *, fetch_b: bool = False) -> dict:
    """Laptop A's reviewed change lands on main, typically while laptop B is still working.
    B's clone is not fetched unless asked: in a live session that is the hook's job."""
    state = state or json.loads((world / "state.json").read_text())
    a, b = Path(state["engineer_a"]), Path(state["engineer_b"])
    if state.get("a_merged"):
        return state
    merged = approve_and_merge(a, prs.get(a, state["a_pr"]))
    if fetch_b:
        fetch(b)
    state.update(good=merged["merge_commit"], a_merged=True, a_merged_at=ledger.now())
    atomic_json(world / "state.json", state)
    return state


def live_instructions(world: Path, state: dict, agent: str = "both") -> str:
    b = Path(state["engineer_b"])
    lines = [f"Live two-laptop demo, scenario {state['scenario']} ({SCENARIOS[state['scenario']]['name']}).", "",
             "Laptop B (a live coding agent on its own feature branch):", f"  cd {b}"]
    if agent in {"both", "claude"}:
        lines.append("  claude --model sonnet                     # Claude Code reads hooks from .claude/settings.json")
    if agent in {"both", "codex"}:
        lines.append(f"  codex -c {shlex.quote(codex_trust_override(b))}")
        lines.append("                                            # Codex: trusts exactly these hook definitions by hash")
    lines += [f"  Task to type: {state['task']}", "",
              "Laptop A (from another terminal, while B is still working):",
              f"  python -m mergeguard.demo merge-a --world {world}", "",
              "Back on laptop B after the agent finishes:",
              "  python -m mergeguard sync-check --fetch",
              f"  python -m mergeguard pr open --branch {state['scenario'].lower()}/task-b --title 'Task B'", "",
              "Baseline without the harness: prefix the agent command with MERGEGUARD_DISABLE=1 and merge with",
              "  python -m mergeguard.demo merge-unguarded --world <world> --pr <number>   (evaluation only)"]
    return "\n".join(lines)


def merge_without_guard(repo, number):
    """Evaluation-only baseline. Uses raw Git, never an escape hatch in the gate."""
    pr = prs.get(repo, number)
    fetch(repo)
    with worktree(repo, "origin/main") as checkout:
        git(checkout, "merge", "--no-ff", "-m", f"BASELINE unguarded PR #{number}", pr["head"])
        merged = sha(checkout, "HEAD")
        git(checkout, "push", "--quiet", "origin", "HEAD:main")
    registry = prs.read(repo)
    registry["prs"][str(number)].update(state="merged", merge_commit=merged)
    atomic_json(prs.registry_path(repo), registry)
    fetch(repo)
    return merged


def prevent(world):
    setup(world)
    state = prepare(world, "S1")
    b = Path(state["engineer_b"])
    note = hooks.handle("post-tool-use", {"cwd": str(b), "session_id": "demo", "tool_name": "Bash", "tool_input": {"command": "pytest -q"}, "tool_response": {"exit_code": 0}})
    print(note["hookSpecificOutput"]["additionalContext"])
    pr = prs.open_pr(b, "s1/task-b", "Account summary")
    print(f"PR #{pr['number']} blocked: stale get_user call detected.")
    git(b, "merge", "--no-edit", "origin/main")
    change_b(b, "S1", repaired=True)
    commit(b, "Use users.fetch_user as instructed by sync note")
    branch_tests = guardian.run_tests(b)
    if branch_tests["outcome"] != "pass":
        raise ValueError(branch_tests["output"])
    pr = prs.open_pr(b, "s1/task-b", "Account summary (synced)")
    pr = approve_and_merge(b, pr)
    with worktree(b, "origin/main") as checkout:
        result = guardian.run_tests(checkout)
    if result["outcome"] != "pass":
        raise ValueError(result["output"])
    print(f"Repaired PR #{pr['number']} merged after human review; main passes.")
    (world / "report.md").write_text(report.generate(b, str(world / "report.html")))
    print(f"Report: {world / 'report.html'}")


def review(world):
    state = setup(world)
    b = Path(state["engineer_b"])
    examples = [
        ("docs", "Document the shop API", "README.md", BASE_FILES["README.md"] + "\nAmounts are documented per endpoint.\n"),
        ("comments", "Clarify user lookup comment", "users.py", "# Lookup by stable user id.\n" + BASE_FILES["users.py"]),
        ("docstrings", "Describe user lookup", "users.py", 'def get_user(uid):\n    """Return a user by id."""\n    return {"id": uid}\n'),
        ("code", "Add account greeting", "account.py", BASE_FILES["account.py"] + '\n\ndef greeting():\n    return "Welcome"\n'),
        ("protected", "Clarify payment units", "payments/charge.py", "# Input is dollars.\n" + BASE_FILES["payments/charge.py"]),
        ("assertions", "Remove a charge assertion", "tests/test_charge.py", 'def test_charge():\n    pass\n'),
    ]
    for name, title, path, source in examples:
        git(b, "checkout", "-b", "review/" + name, state["initial"])
        write(b, path, source)
        commit(b, title)
        pr = prs.open_pr(b, "review/" + name, title)
        print(f"PR #{pr['number']} · tier {pr['decision']['tier']} · {title}")
        if pr["decision"]["tier"] == 0:
            prs.merge(b, pr["number"])
    (world / "report.md").write_text(report.generate(b, str(world / "report.html")))
    print(f"Report: {world / 'report.html'}")


def recover(world, *, repeat=False):
    setup(world)
    state = prepare(world, "S4")
    b = Path(state["engineer_b"])
    pr = approve_and_merge(b, prs.open_pr(b, "s4/task-b", "Invoice total"))
    print("Sync gate clean: units changed without a name or signature change.")
    result = guardian.investigate(b, good=state["good"], bad=pr["merge_commit"])
    print(result["message"])
    atomic_json(world / "guardian.json", result)
    if result.get("undo_pr"):
        approve_and_merge(b, prs.get(b, result["undo_pr"]))
    if repeat:
        a = Path(state["engineer_a"])
        fetch(a)
        git(a, "checkout", "-b", "s4/change-a2", "origin/main")
        git(b, "checkout", "-b", "s4/task-b2", "origin/main")
        write(a, "payments/charge.py", 'def charge(amount):\n    """Return mills, ten times the input cents."""\n    return amount * 10\n')
        write(a, "tests/test_charge.py", BASE_FILES["tests/test_charge.py"].replace("charge(5) == 500", "charge(500) == 5000"))
        change_b(b, "S4")
        write(b, "invoices/total.py", 'from payments.charge import charge\n\ndef invoice_total(amounts):\n    return sum(charge(round(value * 100)) for value in amounts)\n')
        commit(a, "Switch captured unit to mills")
        commit(b, "Invoice total with dollar to cent conversion")
        a2 = approve_and_merge(a, prs.open_pr(a, "s4/change-a2", "Switch capture unit to mills"))
        b2 = approve_and_merge(b, prs.open_pr(b, "s4/task-b2", "Invoice total, second attempt"))
        result2 = guardian.investigate(b, good=a2["merge_commit"], bad=b2["merge_commit"])
        print(result2["message"])
        atomic_json(world / "guardian-second.json", result2)
        if result2.get("undo_pr"):
            approve_and_merge(b, prs.get(b, result2["undo_pr"]))
        from .breaker import status
        print(json.dumps(status(b), indent=2))
    (world / "report.md").write_text(report.generate(b, str(world / "report.html")))
    print(f"Report: {world / 'report.html'}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Fresh two-laptop demo worlds; existing worlds are never deleted")
    parser.add_argument("act", choices=["setup", "prepare", "live", "merge-a", "merge-unguarded", "trust", "prevent", "review", "recover", "learn"])
    parser.add_argument("--world", type=Path, default=Path(__file__).resolve().parents[2] / "mergeguard-world")
    parser.add_argument("--scenario", choices=SCENARIOS, default="S1")
    parser.add_argument("--live-b", action="store_true", help="Leave B's task for a live agent")
    parser.add_argument("--no-merge-a", action="store_true", help="Open A's PR but merge it later with merge-a")
    parser.add_argument("--agent", choices=["both", "claude", "codex"], default="both")
    parser.add_argument("--pr", type=int)
    args = parser.parse_args(argv)
    if args.act == "setup":
        print(json.dumps(setup(args.world), indent=2))
    elif args.act == "prepare":
        print(json.dumps(prepare(args.world, args.scenario, naive_b=not args.live_b, merge_a=not args.no_merge_a), indent=2))
    elif args.act == "live":
        setup(args.world)
        state = prepare(args.world, args.scenario, naive_b=False, merge_a=False)
        print(live_instructions(args.world, state, args.agent))
    elif args.act == "merge-a":
        state = merge_change_a(args.world)
        print(f"Change A merged to main as {state['good'][:8]} (PR #{state['a_pr']}). Laptop B will learn on its next fetch.")
    elif args.act == "merge-unguarded":
        state = json.loads((args.world / "state.json").read_text())
        print(merge_without_guard(Path(state["engineer_b"]), args.pr))
    elif args.act == "trust":
        state = json.loads((args.world / "state.json").read_text())
        print(codex_trust_override(state["engineer_b"]))
    elif args.act == "prevent":
        prevent(args.world)
    elif args.act == "review":
        review(args.world)
    else:
        recover(args.world, repeat=args.act == "learn")


if __name__ == "__main__":
    main()
