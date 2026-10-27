from mergeguard.gate import evaluate


def test_only_distinct_current_humans_count():
    pr = {"author": "author", "prompter": "boss", "head": "new", "approvals": [
        {"user": "author", "head": "new"}, {"user": "boss", "head": "new"},
        {"user": "bot[bot]", "head": "new"}, {"user": "agent", "kind": "agent", "head": "new"},
        {"user": "old", "head": "old"}, {"user": "Priya", "head": "new"}, {"user": "priya", "head": "new"}]}
    result = evaluate(pr, {"tier": 2}, {"clean": True}, {"prompter_counts_as_reviewer": False})
    assert result["eligible"] == ["priya"]
    assert not result["allowed"]
    assert len(result["ignored"]) == 5
    assert evaluate(pr, {"tier": 2}, {"clean": True}, {"prompter_counts_as_reviewer": True})["allowed"]


def test_sync_blocks_even_with_enough_approvals():
    pr = {"author": "a", "head": "new", "approvals": [{"user": "b", "head": "new"}]}
    result = evaluate(pr, {"tier": 0}, {"clean": False, "issues": [{"message": "Update users.get_user"}]}, {"prompter_counts_as_reviewer": False})
    assert not result["allowed"]


def test_gate_requires_green_branch_ci():
    from mergeguard import gate
    pr = {"author": "engineer_b", "head": "abc12345", "approvals": [{"user": "priya", "head": "abc12345", "kind": "human"}],
          "ci": {"head": "abc12345", "outcome": "fail", "failed": ["tests/test_x.py::test_x"]}}
    policy = {"prompter_counts_as_reviewer": False}
    result = gate.evaluate(pr, {"tier": 1}, {"clean": True, "issues": []}, policy)
    assert not result["allowed"] and any("CI is not green" in r for r in result["reasons"])
    pr["ci"]["outcome"] = "pass"
    assert gate.evaluate(pr, {"tier": 1}, {"clean": True, "issues": []}, policy)["allowed"]
