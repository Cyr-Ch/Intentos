from pathlib import Path

import pytest

from mergeguard import prs
from mergeguard.demo import approve_and_merge, change_b, commit, prepare, write
from mergeguard.git import fetch, git, sha


def test_new_head_dismisses_approvals_and_authors_do_not_count(world):
    b = world / "engineer_b"
    git(b, "checkout", "-b", "work")
    write(b, "account.py", "def health():\n    return 'still ok'\n\ndef summary(): return 'hello'\n")  # body change: tier 1
    commit(b, "Summary")
    pr = prs.open_pr(b, "work", "Summary")
    number = pr["number"]
    assert not prs.approve(b, number, "engineer_b")["gate"]["allowed"]
    assert prs.approve(b, number, "priya")["gate"]["allowed"]
    write(b, "account.py", "def health():\n    return 'still ok'\n\ndef summary(): return 'changed'\n")
    commit(b, "Changed after approval")
    git(b, "push", "origin", "work")
    assert prs.refresh(b, number)["approvals"] == []
    with pytest.raises(ValueError, match="Merge blocked"):
        prs.merge(b, number)
    prs.approve(b, number, "priya")
    merged = prs.merge(b, number)
    assert len(git(b, "show", "-s", "--format=%P", merged["merge_commit"]).split()) == 2


def test_merge_rechecks_main_after_approval(world):
    b, a = world / "engineer_b", world / "engineer_a"
    git(b, "checkout", "-b", "summary")
    change_b(b, "S1")
    commit(b, "Summary")
    pr = prs.open_pr(b, "summary", "Summary")
    prs.approve(b, pr["number"], "priya")
    git(a, "checkout", "-b", "rename")
    from mergeguard.demo import change_a
    change_a(a, "S1")
    commit(a, "Rename")
    approve_and_merge(a, prs.open_pr(a, "rename", "Rename"))
    before = sha(prs.origin(b), "main")
    with pytest.raises(ValueError, match="users.fetch_user"):
        prs.merge(b, pr["number"])
    assert sha(prs.origin(b), "main") == before


def test_pr_policy_is_read_from_current_main(world):
    import yaml
    from mergeguard.demo import POLICY
    a, b = world / "engineer_a", world / "engineer_b"
    git(b, "checkout", "-b", "docs")
    write(b, "README.md", "Harmless docs\n")
    commit(b, "Docs")
    pr = prs.open_pr(b, "docs", "Docs")
    assert pr["decision"]["tier"] == 0
    git(a, "checkout", "-b", "protect-docs")
    write(a, ".mergeguard/policy.yaml", yaml.safe_dump({**POLICY, "always_two": POLICY["always_two"] + ["README.md"]}))
    commit(a, "Protect docs")
    approve_and_merge(a, prs.open_pr(a, "protect-docs", "Protect docs"))
    assert prs.refresh(b, pr["number"])["decision"]["tier"] == 2


def test_setup_refuses_existing_world(world):
    from mergeguard.demo import setup
    with pytest.raises(ValueError, match="already exists"):
        setup(world)
