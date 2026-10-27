from pathlib import Path

from mergeguard import guardian, ledger, prs
from mergeguard.demo import approve_and_merge, commit, prepare, write
from mergeguard.git import git, sha, worktree


def test_semantic_clash_finds_both_prs_and_validated_undo(world):
    state = prepare(world, "S4")
    b = Path(state["engineer_b"])
    merged = approve_and_merge(b, prs.open_pr(b, "s4/task-b", "Invoice total"))
    original_head = sha(b, "HEAD")
    result = guardian.investigate(b, good=state["good"], bad=merged["merge_commit"])
    assert result["status"] == "clash"
    assert result["pr"] == merged["number"]
    assert result["partner_pr"] == state["a_pr"]
    assert result["alone"]["outcome"] == "pass"
    assert result["undo_validation"]["outcome"] == "pass"
    assert len(result["repetitions"]["bad"]) == len(result["repetitions"]["good"]) == 3
    assert sha(b, "HEAD") == original_head
    assert prs.get(b, result["undo_pr"])["state"] == "open"
    assert [e["type"] for e in ledger.read(b)].count("culprit") == 1
    undo = approve_and_merge(b, prs.get(b, result["undo_pr"]))
    with worktree(b, undo["merge_commit"]) as checkout:
        assert guardian.run_tests(checkout)["outcome"] == "pass"


def test_flaky_stops_before_blame_or_undo(world, monkeypatch):
    b = world / "engineer_b"
    good = sha(b, "HEAD")
    write(b, "README.md", "Something changed\n")
    bad = commit(b, "Change")
    outcomes = iter(["fail", "fail", "pass", "fail", "pass", "pass", "pass"])
    def fake_test(*args, **kwargs):
        outcome = next(outcomes)
        return {"outcome": outcome, "failed": ["tests/test_charge.py::test_charge"] if outcome == "fail" else []}
    monkeypatch.setattr(guardian, "run_tests", fake_test)
    result = guardian.investigate(b, good=good, bad=bad)
    assert result["status"] == "flaky"
    assert ledger.read(b) == []
    assert prs.read(b)["prs"] == {}


def test_missing_historical_test_passes_but_collection_error_does_not(world):
    b = world / "engineer_b"
    assert guardian.run_tests(b, ["tests/missing.py::test_x"])["outcome"] == "pass"
    write(b, "tests/test_broken.py", "import module_that_does_not_exist\n")
    assert guardian.run_tests(b)["outcome"] == "error"


def test_direct_bug_is_not_called_a_clash(world):
    b = world / "engineer_b"
    good = sha(b, "HEAD")
    git(b, "checkout", "-b", "bug")
    write(b, "users.py", 'def get_user(uid):\n    return {"id": 0}\n')
    commit(b, "Bug on branch")
    # The branch's own tests fail, so the gate would block it; reach main the way a bypassed CI would.
    from mergeguard.demo import merge_without_guard
    merged = merge_without_guard(b, prs.open_pr(b, "bug", "Bug")["number"])
    result = guardian.investigate(b, good=good, bad=merged)
    assert result["status"] == "culprit"
    assert result["partner_pr"] is None
    assert result["undo_pr"] is not None
