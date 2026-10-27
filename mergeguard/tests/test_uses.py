from mergeguard.uses import collect, collect_source


def calls(source, path="consumer.py"):
    return [r for r in collect_source(path, source) if r["call"]]


def test_aliases_and_call_shape():
    records = calls("from users import get_user as lookup\nimport payments.charge as pay\nlookup(7, org='acme')\npay.charge(5)\n")
    assert [r["symbol"] for r in records] == ["users.get_user", "payments.charge.charge"]
    assert records[0]["positional"] == 1
    assert records[0]["keywords"] == ["org"]


def test_dotted_import_and_relative_import():
    assert calls("import accounts.users\naccounts.users.get_user(7)\n")[0]["symbol"] == "accounts.users.get_user"
    assert calls("from .users import get_user\nget_user(7)\n", "accounts/view.py")[0]["symbol"] == "accounts.users.get_user"


def test_unknown_object_and_parameter_shadow_are_ignored():
    result = calls("from users import get_user\ndef f(get_user, obj):\n    get_user(3)\n    obj.get_user(3)\n")
    assert result == []


def test_local_import_resolves():
    result = calls("def f():\n    import users\n    return users.get_user(7)\n")
    assert result[0]["symbol"] == "users.get_user"


def test_includes_untracked_and_uncommitted_but_not_unchanged_files(repo_factory):
    repo = repo_factory({"unchanged.py": "from old import f\nf()\n", "users.py": "def f():\n    pass\n"})
    repo.write("new.py", "from users import f\nf()\n")
    records = collect(repo.path)
    assert {r["symbol"] for r in records} == {"users.f"}


def test_star_arguments_are_recorded():
    record = calls("from api import f\nf(*args, **kwargs)\n")[0]
    assert record["starargs"] and record["starkwargs"]
