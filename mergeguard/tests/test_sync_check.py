import ast

import pytest

from mergeguard.changes import signature
from mergeguard.sync_check import check, incompatible


def test_specific_rename_message_and_uncommitted_repair(repo_factory):
    repo = repo_factory()
    repo.main_change({"users.py": "def fetch_user(uid):\n    return uid\n"})
    repo.write("account.py", "from users import get_user\nget_user(7)\n")
    result = check(repo.path)
    issue = result["issues"][0]
    assert not result["clean"]
    assert issue["used_in"] == ["account.py:2"]
    assert "users.fetch_user" in issue["message"] and "re-run the tests" in issue["message"]
    repo.write("account.py", "from users import fetch_user\nfetch_user(7)\n")
    assert check(repo.path)["clean"]


@pytest.mark.parametrize("params,args,keywords,expected", [
    ("uid, org_id", 1, [], "missing required argument: org_id"),
    ("uid", 2, [], "too many positional"),
    ("uid", 1, ["other"], "unknown keyword"),
    ("uid", 1, ["uid"], "multiple values"),
    ("uid, /", 0, ["uid"], "unknown keyword"),
    ("uid, *, org", 1, [], "missing required argument: org"),
    ("uid, *args, **kwargs", 5, ["other"], None),
    ("uid, org=None", 1, [], None),
])
def test_call_compatibility(params, args, keywords, expected):
    sig = signature(ast.parse(f"def f({params}): pass").body[0])
    result = incompatible(sig, {"positional": args, "keywords": keywords})
    assert any(expected in r for r in result) if expected else not result


def test_compatible_call_to_changed_signature_is_clean(repo_factory):
    repo = repo_factory()
    repo.main_change({"users.py": "def get_user(uid, org_id):\n    return uid\n"})
    repo.write("account.py", "from users import get_user\nget_user(7, 'acme')\n")
    assert check(repo.path)["clean"]


def test_unrelated_main_change_is_clean(repo_factory):
    repo = repo_factory()
    repo.main_change({"catalog.py": "def categories(): return []\n"})
    repo.write("account.py", "from users import get_user\nget_user(7)\n")
    assert check(repo.path)["clean"]


def test_starargs_do_not_claim_missing_unknown_arguments():
    sig = signature(ast.parse("def f(a, b): pass").body[0])
    assert incompatible(sig, {"positional": 0, "keywords": [], "starargs": True}) == []
