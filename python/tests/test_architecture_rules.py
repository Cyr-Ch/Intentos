from __future__ import annotations

import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import architecture_rules as ar  # noqa: E402


def _tree(tmp_path: pathlib.Path) -> pathlib.Path:
    (tmp_path / "app" / "api").mkdir(parents=True)
    (tmp_path / "app" / "services").mkdir(parents=True)
    (tmp_path / "app" / "domain").mkdir(parents=True)
    (tmp_path / "app" / "api" / "checkout.py").write_text("from decimal import Decimal\nfrom app.services.discounts import DiscountPolicy\n\n\ndef checkout(c):\n    return DiscountPolicy().applicable_discounts(c, 1, 2)\n")
    (tmp_path / "app" / "services" / "pricing.py").write_text("from app.services.discounts import DiscountPolicy\n\n\ndef quote(c):\n    return DiscountPolicy().applicable_discounts(c, 1, 2)\n")
    (tmp_path / "app" / "services" / "discounts.py").write_text("class DiscountPolicy:\n    def applicable_discounts(self, c, s, t):\n        return []\n")
    (tmp_path / "app" / "domain" / "money.py").write_text("import app.services.pricing\n")
    return tmp_path


def test_forbidden_import_and_call_rules(tmp_path: pathlib.Path):
    root = _tree(tmp_path)
    rules = [
        {"id": "ARCH-001", "kind": "forbidden_import", "paths": ["app/api/**"], "forbidden_modules": ["decimal", "app.services.discounts"]},
        {"id": "ARCH-002", "kind": "forbidden_import", "paths": ["app/domain/**"], "forbidden_modules": ["app.services"]},
        {"id": "ARCH-003", "kind": "forbidden_call", "paths": ["app/**"], "forbidden_callees": ["applicable_discounts"], "allowed_paths": ["app/services/pricing.py", "app/services/discounts.py"]},
        {"id": "ARCH-004", "kind": "frozen_paths", "paths": ["app/legacy/**"]},
    ]
    out = ar.check(str(root), rules, ["app/api/checkout.py"])
    by_rule = {}
    for f in out["findings"]:
        by_rule.setdefault(f["rule_id"], []).append(f)
    assert {f["path"] for f in by_rule["ARCH-001"]} == {"app/api/checkout.py"}
    assert any("decimal" in f["message"] for f in by_rule["ARCH-001"])
    assert [f["path"] for f in by_rule["ARCH-002"]] == ["app/domain/money.py"]
    assert [f["path"] for f in by_rule["ARCH-003"]] == ["app/api/checkout.py"]  # pricing.py is allowed
    assert all(f["in_changed_file"] is (f["path"] == "app/api/checkout.py") for f in out["findings"])
    assert out["errors"] == []
    assert out["checked_files"] == 4


def test_clean_tree_has_no_findings(tmp_path: pathlib.Path):
    root = _tree(tmp_path)
    (root / "app" / "api" / "checkout.py").write_text("from app.services.pricing import quote\n\n\ndef checkout(c):\n    return quote(c)\n")
    (root / "app" / "domain" / "money.py").write_text("X = 1\n")
    rules = [
        {"id": "ARCH-001", "kind": "forbidden_import", "paths": ["app/api/**"], "forbidden_modules": ["decimal", "app.services.discounts"]},
        {"id": "ARCH-003", "kind": "forbidden_call", "paths": ["app/**"], "forbidden_callees": ["applicable_discounts"], "allowed_paths": ["app/services/pricing.py", "app/services/discounts.py"]},
    ]
    assert ar.check(str(root), rules, [])["findings"] == []


def test_glob_semantics():
    assert ar.matches_any("app/api/checkout.py", ["app/api/**"])
    assert ar.matches_any("app/x.py", ["app/**"])
    assert not ar.matches_any("tests/x.py", ["app/**"])
    assert ar.matches_any("app/api/v1/x.py", ["app/**/x.py"])


def test_forbidden_names_catches_verifier_tampering(tmp_path: pathlib.Path):
    root = _tree(tmp_path)
    (root / "app" / "__init__.py").write_text(
        "import os as _os\nimport sys as _sys\nfor _a in _sys.argv:\n    if _a.startswith('--junit-xml='):\n        _os._exit(0)\n"
    )
    rules = [{"id": "ARCH-006", "kind": "forbidden_names", "paths": ["app/**"], "forbidden_names": ["sys.argv", "os._exit"], "forbidden_literals": ["junit"]}]
    out = ar.check(str(root), rules, ["app/__init__.py"])
    msgs = [f["message"] for f in out["findings"]]
    assert any("_sys.argv" in m for m in msgs)
    assert any("_os._exit" in m for m in msgs)
    assert any("junit" in m.lower() for m in msgs)
    assert all(f["path"] == "app/__init__.py" for f in out["findings"])
