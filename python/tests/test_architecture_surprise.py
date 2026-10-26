from __future__ import annotations

import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import architecture_surprise as surprise  # noqa: E402

HELPER = """
def helper(x, y):
    total = x + y
    if total < 0:
        raise ValueError("negative")
    return total
"""
BASE = {
    "app/services/a.py": HELPER,
    "app/services/b.py": "from app.services.a import helper\n\n\ndef use(v):\n    return helper(v, v)\n",
    "app/services/c.py": "VALUE = 1\n",
    "app/domain/models.py": "from enum import Enum\n\n\nclass Thing:\n    def __init__(self, v):\n        self.v = v\n\n\nclass Kind(Enum):\n    A = 'a'\n",
    "app/api/views.py": "from app.domain.models import Kind, Thing\n\n\ndef view():\n    return Kind.A\n",
    "tests/test_a.py": "def _fixture(a, b):\n    total = a + b\n    if total < 0:\n        raise ValueError('negative')\n    return total\n",
}
INTERNAL = ["app", "app.services", "app.services.a", "app.services.b", "app.services.c", "app.domain", "app.domain.models", "app.api", "app.api.views"]
CONFIG = {"api_paths": ["app/api/**"], "domain_paths": ["app/domain/**"], "ignore_names": []}


def run(candidate: dict[str, str], changed: list[str], base: dict[str, str] = BASE, config: dict = CONFIG) -> dict:
    return surprise.check({"base": base, "candidate": candidate, "changed_paths": changed, "internal_modules": INTERNAL, "config": config})


def kinds(out: dict) -> list[str]:
    return sorted(f["kind"] for f in out["findings"])


def test_new_cross_module_dependency_is_reported_once_per_module():
    cand = {"app/services/b.py": "from app.services.a import helper\nfrom app.services.c import VALUE\nimport app.services.c\n\n\ndef use(v):\n    return helper(v, VALUE)\n"}
    out = run(cand, ["app/services/b.py"])
    deps = [f for f in out["findings"] if f["kind"] == "new_dependency"]
    assert [d["message"].split(" now imports internal module ")[1].split(",")[0] for d in deps] == ["app.services.c"]
    assert deps[0]["line"] == 2
    assert "app.services.a" in deps[0]["expected"]
    assert out["errors"] == []


def test_new_file_imports_are_not_new_dependencies():
    out = run({"app/services/new.py": "from app.services.a import helper\n"}, ["app/services/new.py"])
    assert kinds(out) == []


def test_duplicate_helper_by_renamed_body_and_by_name():
    cand = {
        "app/services/b.py": "from app.services.a import helper\n\n\ndef use(v):\n    return helper(v, v)\n\n\ndef add_checked(p, q):\n    \"\"\"Docstrings are ignored.\"\"\"\n    total = p + q\n    if total < 0:\n        raise ValueError('negative')\n    return total\n\n\ndef tiny(p, q):\n    total = p + q\n    return total\n",
        "app/services/c.py": "VALUE = 1\n\n\ndef use(other):\n    return other\n",
    }
    out = run(cand, ["app/services/b.py", "app/services/c.py"])
    dups = {f["path"]: f for f in out["findings"] if f["kind"] == "duplicate_helper"}
    assert set(dups) == {"app/services/b.py", "app/services/c.py"}
    assert "equivalent to app/services/a.py" in dups["app/services/b.py"]["message"]  # renamed parameters + docstring
    assert "add_checked" in dups["app/services/b.py"]["message"]
    assert "name matches existing app/services/b.py" in dups["app/services/c.py"]["message"]  # use() exists in b.py
    assert not any("tiny" in f["message"] for f in out["findings"])  # 2-statement bodies are never matched


def test_existing_functions_and_test_fixtures_are_not_duplicates():
    out = run({"app/services/a.py": HELPER + "\nX = 1\n"}, ["app/services/a.py"])
    assert kinds(out) == []
    out = run({"tests/test_b.py": "def _fixture(a, b):\n    total = a + b\n    if total < 0:\n        raise ValueError('negative')\n    return total\n"}, ["tests/test_b.py"])
    assert kinds(out) == []


def test_api_domain_construction_ignores_enum_access_and_pre_existing_calls():
    cand = {"app/api/views.py": "from app.domain.models import Kind, Thing\n\n\ndef view():\n    kind = Kind.A\n    other = Kind('a')\n    return Thing(kind)\n"}
    out = run(cand, ["app/api/views.py"])
    cons = [f for f in out["findings"] if f["kind"] == "api_domain_construction"]
    assert [(f["line"], f["message"].split(" constructs domain object ")[1].split("(")[0]) for f in cons] == [(7, "Thing")]
    assert "app/domain/models.py" in cons[0]["expected"]
    # the same call already present at base is not reported again
    base = dict(BASE, **{"app/api/views.py": cand["app/api/views.py"]})
    assert run(cand, ["app/api/views.py"], base=base)["findings"] == []
    # services are not the API layer
    out = run({"app/services/b.py": "from app.domain.models import Thing\n\n\ndef use(v):\n    return Thing(v)\n"}, ["app/services/b.py"])
    assert kinds(out) == ["new_dependency"]


def test_parse_errors_become_errors_not_findings():
    out = run({"app/services/b.py": "def broken(:\n    pass\n"}, ["app/services/b.py"])
    assert out["findings"] == []
    assert out["errors"] and out["errors"][0]["path"] == "app/services/b.py"


def test_ignore_names_config_suppresses_name_matches():
    cand = {"app/services/c.py": "VALUE = 1\n\n\ndef use(other):\n    return other\n"}
    assert kinds(run(cand, ["app/services/c.py"])) == ["duplicate_helper"]
    assert kinds(run(cand, ["app/services/c.py"], config=dict(CONFIG, ignore_names=["use"]))) == []
