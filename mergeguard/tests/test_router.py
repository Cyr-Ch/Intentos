import pytest
import yaml

from mergeguard.demo import POLICY
from mergeguard.router import proof, route


def test_comment_and_docstring_proof():
    assert "AST-equivalent" in proof("x = 1\n", "# x\nx=1\n")
    assert proof('def f():\n    """Old."""\n    return 1\n', 'def f():\n    """New."""\n    return 1\n') == "docstring-only"
    assert proof("x = 1\n", "x = 2\n") is None
    assert proof(None, "# comment\n") is None


@pytest.mark.parametrize("path,source,tier", [
    ("README.md", "Docs\n", 0),
    ("docs/guide.txt", "Instructions\n", 0),
    ("users.py", "# comment\ndef get_user(uid):\n    return uid\n", 0),
    ("users.py", 'def get_user(uid):\n    """Lookup."""\n    return uid\n', 0),
    ("users.py", "def get_user(uid):\n    return uid + 1\n", 1),
    ("payments/README.md", "Docs\n", 2),
    (".github/workflows/test.yml", "name: test\n", 2),
])
def test_tiers_from_diff(repo_factory, path, source, tier):
    repo = repo_factory()
    repo.write(path, source)
    head = repo.commit()
    assert route(repo.path, repo.base, head, "engineer_b")["tier"] == tier


def test_untrusted_and_howmade_only_raise(repo_factory):
    repo = repo_factory()
    repo.write("README.md", "Docs\n")
    head = repo.commit()
    assert route(repo.path, repo.base, head, "stranger")["tier"] == 1
    for evidence in [{"test_runs": 3}, {"sync_notes": 1}, {"existing_tests_modified": True}]:
        assert route(repo.path, repo.base, head, "engineer_b", howmade_data=evidence)["tier"] == 1
    repo.write("users.py", "def get_user(uid): return 'risky'\n")
    head = repo.commit()
    assert route(repo.path, repo.base, head, "engineer_b", howmade_data="test runs: 0\nexisting tests modified: no")["tier"] == 1


def test_policy_cannot_lower_itself(repo_factory):
    repo = repo_factory()
    policy = {**POLICY, "always_two": [], "trusted_authors": ["attacker"]}
    repo.write(".mergeguard/policy.yaml", yaml.safe_dump(policy))
    head = repo.commit()
    assert route(repo.path, repo.base, head, "attacker")["tier"] == 2


@pytest.mark.parametrize("after", [None, "def test_ok():\n    pass\n", "def test_ok():\n    assert True\n"])
def test_test_deletion_and_weakening_raise_to_two(repo_factory, after):
    repo = repo_factory({"tests/test_api.py": "def test_ok():\n    assert 1 == 1\n"})
    if after is None:
        (repo.path / "tests/test_api.py").unlink()
    else:
        repo.write("tests/test_api.py", after)
    head = repo.commit()
    assert route(repo.path, repo.base, head, "engineer_b")["tier"] == 2


def test_quick_skim_mode(repo_factory):
    policy = {**POLICY, "zero_review_allowed": False}
    repo = repo_factory({".mergeguard/policy.yaml": yaml.safe_dump(policy)})
    repo.write("README.md", "Docs\n")
    head = repo.commit()
    assert route(repo.path, repo.base, head, "engineer_b")["tier"] == 1


def test_public_api_break_routes_to_two_humans(repo_factory):
    repo = repo_factory({"users.py": "def get_user(uid):\n    return uid\n", "accounts/__init__.py": "",
                         "tests/test_users.py": "def test_user():\n    assert True\n"})
    (repo.path / "users.py").unlink()
    repo.write("accounts/users.py", "def get_user(uid):\n    return uid\n")
    repo.write("tests/test_users.py", "def test_user_renamed():\n    assert True\n")
    head = repo.commit("Move users into a package")
    decision = route(repo.path, repo.base, head, "engineer_b")
    assert decision["tier"] == 2
    assert any(r.startswith("Public API changed: users.get_user moved (now accounts.users.get_user)") for r in decision["reasons"])
    assert not any(r.startswith("Public API") and "test_user" in r for r in decision["reasons"]), "renamed test functions are not public API"
    lowered = repo.main_change({".mergeguard/policy.yaml": yaml.safe_dump({**POLICY, "api_break_tier": 1})})
    assert route(repo.path, repo.base, head, "engineer_b")["tier"] == 2, "policy comes from the trusted ref, here the base"
    assert route(repo.path, repo.base, head, "engineer_b", policy_ref=lowered)["tier"] == 1
    invalid = repo.main_change({".mergeguard/policy.yaml": yaml.safe_dump({**POLICY, "api_break_tier": 3})})
    with pytest.raises(ValueError):
        route(repo.path, repo.base, head, "engineer_b", policy_ref=invalid)


def test_additive_only_code_merges_without_a_human_when_policy_allows(repo_factory):
    from mergeguard.router import additive_proof
    base_users = "def get_user(uid):\n    return uid\n\n\nclass Repo:\n    def one(self):\n        return 1\n"
    repo = repo_factory({"users.py": base_users, "tests/test_users.py": "def test_user():\n    assert True\n"})
    repo.write("users.py", "import json\n\n" + base_users + "\n\ndef get_many(uids):\n    return [get_user(u) for u in uids]\n")
    repo.write("tests/test_many.py", "from users import get_many\n\ndef test_many():\n    assert get_many([1]) == [1]\n")
    repo.write("catalog.py", "def categories():\n    return []\n")
    head = repo.commit("Additive change")
    decision = route(repo.path, repo.base, head, "engineer_b")
    assert decision["tier"] == 0, decision["reasons"]
    assert decision["proofs"]["users.py"].startswith("additive-only") and decision["proofs"]["catalog.py"].startswith("new module")
    strict = route(repo.path, repo.base, head, "engineer_b", policy={**POLICY, "zero_review_additive": False})
    assert strict["tier"] == 1
    # Adding a method to an existing class is additive; changing an existing body is not.
    assert additive_proof(base_users, base_users.replace("return 1\n", "return 1\n\n    def two(self):\n        return 2\n"))
    assert additive_proof(base_users, base_users.replace("return uid", "return {'id': uid}")) is None
    assert additive_proof(base_users, base_users + "\nprint('loaded')\n") is None, "a module-level side effect is not additive"
    assert additive_proof(base_users, base_users.replace("def get_user(uid):", "def get_user(uid, org):")) is None
    # A sync note received, a protected path, or an existing test edit still needs a human.
    assert route(repo.path, repo.base, head, "engineer_b", howmade_data={"sync_notes": 1})["tier"] == 1
    repo.write("payments/__init__.py", "")
    repo.write("payments/refund.py", "def refund(amount):\n    return amount\n")
    assert route(repo.path, repo.base, repo.commit("Additive in payments"), "engineer_b")["tier"] == 2


def test_annotation_only_and_new_constant_proofs(repo_factory):
    from mergeguard.router import additive_proof
    base = "def get_user(uid):\n    return {'id': uid}\n"
    assert proof(base, "def get_user(uid: int) -> dict:\n    return {'id': uid}\n").startswith("annotation-only")
    assert proof(base, "def get_user(uid: int) -> dict:\n    \"\"\"Doc.\"\"\"\n    return {'id': uid}\n").startswith("annotation-only")
    assert proof(base, "def get_user(uid: int) -> dict:\n    return {'id': 0}\n") is None
    assert additive_proof(base, "MAX_USERS = 100\n\n" + base) is not None
    assert additive_proof(base, "LIMITS = {'users': 100, 'orgs': (1, -2)}\n\n" + base) is not None
    assert additive_proof(base, "MAX_USERS = compute()\n\n" + base) is None, "a call is not a literal"
    assert additive_proof("LIMIT = 5\n" + base, "LIMIT = 6\n" + base) is None, "changing an existing constant is not additive"
    repo = repo_factory({"users.py": base})
    repo.write("users.py", "MAX_USERS = 100\n\n\ndef get_user(uid: int) -> dict:\n    return {'id': uid}\n")
    head = repo.commit("Hints and a constant")
    assert route(repo.path, repo.base, head, "engineer_b")["tier"] == 1, "hints plus a constant together is neither proof alone"
    repo.write("users.py", "def get_user(uid: int) -> dict:\n    return {'id': uid}\n")
    assert route(repo.path, repo.base, repo.commit("Hints only"), "engineer_b")["tier"] == 0
