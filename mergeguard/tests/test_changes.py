import pytest

from mergeguard.changes import detect, index_sources


def test_rename_and_attribution(repo_factory):
    repo = repo_factory()
    renamed = repo.main_change({"users.py": "def fetch_user(uid):\n    return uid\n"})
    repo.main_change({"users.py": "# unrelated comment\ndef fetch_user(uid):\n    return uid\n"})
    delta = detect(repo.path, repo.base, "origin/main")
    assert len(delta) == 1
    assert delta[0]["change"] == "renamed"
    assert delta[0]["new"] == "users.fetch_user"
    assert delta[0]["commit"] == renamed


def test_move(repo_factory):
    repo = repo_factory()
    repo.main_change({"users.py": None, "accounts/users.py": "def get_user(uid):\n    return uid\n"})
    delta = detect(repo.path, repo.base, "origin/main")
    assert delta[0]["change"] == "moved"
    assert delta[0]["new"] == "accounts.users.get_user"


def test_ambiguous_rename_does_not_invent_replacement(repo_factory):
    repo = repo_factory()
    repo.main_change({"users.py": "def one(uid):\n    return uid\n\ndef two(uid):\n    return uid\n"})
    assert detect(repo.path, repo.base, "origin/main")[0]["change"] == "removed"


@pytest.mark.parametrize("new", ["uid, org_id", "user_id", "uid, *, org_id", "*, uid"])
def test_signature_changes(repo_factory, new):
    repo = repo_factory()
    repo.main_change({"users.py": f"def get_user({new}):\n    return 1\n"})
    assert detect(repo.path, repo.base, "origin/main")[0]["change"] == "signature_changed"


def test_optional_added_and_meaning_change_are_not_api_breaks(repo_factory):
    repo = repo_factory()
    repo.main_change({"users.py": "def get_user(uid, org_id=None):\n    return uid * 100\n"})
    assert detect(repo.path, repo.base, "origin/main") == []


def test_index_classes_methods_and_imported_private_helpers():
    sources = {"pkg/__init__.py": "def _used(x):\n    return x\ndef _private():\n    pass\nclass User:\n    def fetch(self, uid):\n        pass\n",
               "consumer.py": "from pkg import _used\n"}
    symbols = index_sources(sources)
    assert set(symbols) == {"pkg._used", "pkg.User", "pkg.User.fetch"}
    assert symbols["pkg.User.fetch"].signature[1]["name"] == "uid"


def test_positional_order_change(repo_factory):
    repo = repo_factory({"api.py": "def f(x, y):\n    return x\n"})
    repo.main_change({"api.py": "def f(y, x):\n    return x\n"})
    assert detect(repo.path, repo.base, "origin/main")[0]["change"] == "signature_changed"
