"""Local mode: a checkout plus git worktrees stands in for origin, as IntentOS runs its agents."""
import json
from pathlib import Path

import pytest
import yaml

from mergeguard import ledger, prs, sync_check
from mergeguard.demo import POLICY, commit, write
from mergeguard.git import git, sha
from mergeguard.policy import load


@pytest.fixture
def local(tmp_path, monkeypatch):
    repo = tmp_path / "checkout"
    repo.mkdir()
    git(repo, "init", "--initial-branch=main")
    git(repo, "config", "user.name", "priya")
    git(repo, "config", "user.email", "priya@example.test")
    write(repo, "users.py", "def get_user(uid):\n    return uid\n")
    write(repo, "account.py", "from users import get_user\n\ndef account(uid):\n    return get_user(uid)\n")
    write(repo, "tests/test_users.py", "from users import get_user\n\ndef test_user():\n    assert get_user(1) == 1\n")
    write(repo, "tests/test_account.py", "from account import account\n\ndef test_account():\n    assert account(2) == 2\n")
    commit(repo, "Base")
    state = tmp_path / "state"
    state.mkdir()
    (state / "policy.yaml").write_text(yaml.safe_dump({**POLICY, "zero_review_additive": True}))
    monkeypatch.setenv("MERGEGUARD_MAIN", "main")
    monkeypatch.setenv("MERGEGUARD_STATE_DIR", str(state))
    monkeypatch.setenv("MERGEGUARD_POLICY_FILE", str(state / "policy.yaml"))
    monkeypatch.delenv("MERGEGUARD_LEDGER", raising=False)
    monkeypatch.delenv("MERGEGUARD_DISABLE", raising=False)

    def worktree(name):
        path = tmp_path / name
        git(repo, "worktree", "add", "--quiet", "-b", name, str(path), "main")
        git(path, "config", "user.name", f"agent_{name}")
        git(path, "config", "user.email", f"{name}@example.test")
        return path

    return repo, state, worktree


def test_policy_comes_from_the_trusted_file_not_the_repo(local):
    repo, state, _ = local
    write(repo, ".mergeguard/policy.yaml", yaml.safe_dump({**POLICY, "zero_review_allowed": False}))
    commit(repo, "Repo policy that must not count")
    assert load(repo)["zero_review_allowed"] is True
    assert load(repo)["zero_review_additive"] is True


def test_pr_merge_fast_forwards_the_checkout_and_records_state_outside_it(local):
    repo, state, worktree = local
    a = worktree("a")
    write(a, "users.py", "def get_user(uid):\n    return uid\n\ndef get_email(uid):\n    return f'{uid}@example.test'\n")
    commit(a, "Additive helper")
    pr = prs.open_pr(a, "a", "Add get_email", author="engineer_a")
    assert pr["decision"]["tier"] == 0 and pr["gate"]["allowed"]
    before = sha(repo, "main")
    merged = prs.merge(a, pr["number"])
    assert sha(repo, "main") == merged["merge_commit"] != before
    assert "get_email" in (repo / "users.py").read_text()  # the checkout's working tree moved with the ref
    assert git(repo, "status", "--porcelain") == ""
    assert (state / "prs.json").exists() and ledger.ledger_path(repo) == state / "ledger.jsonl"
    assert not (repo / ".mergeguard-prs.json").exists()
    assert [event["type"] for event in ledger.read(repo)] == ["merged"]


def test_stale_worktree_is_told_about_main_and_blocked_at_merge(local):
    repo, state, worktree = local
    a, b = worktree("a"), worktree("b")
    write(b, "account.py", "from users import get_user\n\ndef account(uid):\n    return get_user(uid)\n\ndef summary(uid):\n    return str(get_user(uid))\n")
    write(a, "users.py", "def fetch_user(uid):\n    return uid\n")
    write(a, "account.py", "from users import fetch_user\n\ndef account(uid):\n    return fetch_user(uid)\n")
    write(a, "tests/test_users.py", "from users import fetch_user\n\ndef test_user():\n    assert fetch_user(1) == 1\n")
    commit(a, "Rename get_user")
    pr_a = prs.open_pr(a, "a", "Rename", author="engineer_a")
    prs.approve(a, pr_a["number"], "priya")
    prs.approve(a, pr_a["number"], "sam")
    prs.merge(a, pr_a["number"])
    # B's uncommitted work is checked against the moved main with no fetch and no remote.
    result = sync_check.check(b)
    assert not result["clean"]
    assert "renamed to `users.fetch_user`" in result["issues"][0]["message"]
    assert "git merge main" in result["issues"][0]["message"]
    commit(b, "Summary")
    pr_b = prs.open_pr(b, "b", "Summary", author="engineer_b")
    assert not pr_b["gate"]["allowed"] and any("fetch_user" in reason for reason in pr_b["gate"]["reasons"])
    with pytest.raises(ValueError, match="fetch_user"):
        prs.merge(b, pr_b["number"])


def test_dirty_checkout_refuses_the_fast_forward(local):
    repo, state, worktree = local
    a = worktree("a")
    write(a, "README.md", "docs\n")
    commit(a, "Docs")
    pr = prs.open_pr(a, "a", "Docs", author="engineer_a")
    write(repo, "users.py", "def get_user(uid):\n    return uid  # edited in the checkout\n")
    before = sha(repo, "main")
    with pytest.raises(ValueError, match="uncommitted changes"):
        prs.merge(a, pr["number"])
    assert sha(repo, "main") == before


def test_min_tier_floor_and_merged_result_check(local, monkeypatch):
    repo, state, worktree = local
    a = worktree("a")
    write(a, "users.py", "def get_user(uid):\n    return uid\n\ndef get_email(uid):\n    return f'{uid}@example.test'\n")
    commit(a, "Additive helper")
    # A caller that already knows a human must look (IntentOS asked for review) raises the floor; the diff rules cannot lower it.
    pr = prs.open_pr(a, "a", "Add get_email", author="engineer_a", min_tier=1, min_tier_reason="verifier asked for a human")
    assert pr["decision"]["tier"] == 1 and "verifier asked for a human" in pr["decision"]["reasons"]
    assert not pr["gate"]["allowed"]
    prs.approve(a, pr["number"], "priya")
    # The merged result must pass a check before main moves: here a command that fails exactly on the merged tree.
    check = state / "check.sh"
    check.write_text("#!/bin/sh\ntest ! -e \"$1/users.py\" || ! grep -q get_email \"$1/users.py\"\n")
    check.chmod(0o755)
    monkeypatch.setenv("MERGEGUARD_MERGE_CHECK", f"{check} {{checkout}}")
    before = sha(repo, "main")
    with pytest.raises(ValueError, match="merged result failed"):
        prs.merge(a, pr["number"])
    assert sha(repo, "main") == before
    assert prs.get(a, pr["number"])["merge_check"]["outcome"] == "fail"
    monkeypatch.setenv("MERGEGUARD_MERGE_CHECK", "true")
    merged = prs.merge(a, pr["number"])
    assert merged["merge_check"]["outcome"] == "pass" and sha(repo, "main") == merged["merge_commit"]


def test_private_codex_home_holds_hooks_and_links_auth(tmp_path):
    from mergeguard.demo import codex_trust_override, write_codex_home
    auth = tmp_path / "auth.json"
    auth.write_text("{}")
    home = tmp_path / "home"
    files = write_codex_home(home, auth_from=auth)
    assert [f.name for f in files] == ["hooks.json", "config.toml"]
    assert (home / "auth.json").is_symlink() and (home / "auth.json").resolve() == auth.resolve()
    assert "hooks = true" in (home / "config.toml").read_text()
    override = codex_trust_override(home, hooks_file=home / "hooks.json")
    assert override.startswith("hooks.state = {") and f'"{(home / "hooks.json").resolve()}:post_tool_use:0:0"' in override
    assert ".codex" not in override
