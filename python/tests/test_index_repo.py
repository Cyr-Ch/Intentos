"""Deterministic extraction tests for the Python indexer (run from the project venv)."""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys

import pytest

HERE = pathlib.Path(__file__).resolve().parent
PY = HERE.parent
sys.path.insert(0, str(PY))

import index_repo  # noqa: E402


def _git(repo: pathlib.Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True).stdout


@pytest.fixture
def tiny_repo(tmp_path: pathlib.Path) -> pathlib.Path:
    repo = tmp_path / "r"
    (repo / "app" / "services").mkdir(parents=True)
    (repo / "tests").mkdir()
    (repo / "docs").mkdir()
    (repo / "app" / "__init__.py").write_text("")
    (repo / "app" / "services" / "__init__.py").write_text("")
    (repo / "app" / "services" / "discounts.py").write_text("class DiscountPolicy:\n    def applicable_discounts(self, contract, subtotal, today):\n        return []\n")
    (repo / "app" / "services" / "pricing.py").write_text(
        '"""Pricing service."""\nfrom decimal import Decimal\nfrom app.services.discounts import DiscountPolicy\n\n\nclass PricingService:\n    """Owns price calculation."""\n\n    def quote(self, contract, today):\n        return DiscountPolicy().applicable_discounts(contract, Decimal("1"), today)\n'
    )
    (repo / "tests" / "test_pricing.py").write_text("from app.services.pricing import PricingService\n\n\ndef test_quote():\n    assert PricingService()\n")
    (repo / "docs" / "adr-002-x.md").write_text("# ADR-002: Legacy\n\nStatus: Superseded by ADR-003\nDate: 2026-04-10\n\n## Decision\nUse legacy.\n\n## Consequences\nNone.\n")
    (repo / ".env").write_text("SECRET=do-not-index\n")
    (repo / ".gitignore").write_text(".env\n")
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "add", "-A")
    _git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
    return repo


def test_symbols_imports_tests_and_docs(tiny_repo: pathlib.Path):
    result = index_repo.index_repo(str(tiny_repo), 1_000_000)
    assert result.repo["head_sha"] == _git(tiny_repo, "rev-parse", "HEAD").strip()
    qns = {s.qualified_name: s for s in result.symbols}
    assert qns["app.services.pricing.PricingService"].kind == "class"
    assert qns["app.services.pricing.PricingService"].line_start == 6
    assert qns["app.services.pricing.PricingService.quote"].kind == "method"
    assert qns["app.services.pricing.PricingService.quote"].signature == "(self, contract, today)"
    assert qns["tests.test_pricing.test_quote"].is_test is True
    internal = {(i.from_module, i.to_module) for i in result.imports if i.resolved_internal}
    assert ("app.services.pricing", "app.services.discounts") in internal
    assert ("tests.test_pricing", "app.services.pricing") in internal
    assert any(c.callee == "DiscountPolicy" and c.from_symbol == "SY:app.services.pricing.PricingService.quote" for c in result.calls)
    assert all(c.extraction_method == "ast_name_match" for c in result.calls)
    doc = result.docs[0]
    assert doc.adr["status"] == "superseded"
    assert doc.adr["superseded_by"] == "ADR-003"
    assert [(s.heading, s.line_start, s.line_end) for s in doc.sections] == [("ADR-002: Legacy", 1, 5), ("Decision", 6, 8), ("Consequences", 9, 10)]
    assert all(not f.endswith(".env") for f in result.files)


def test_determinism_and_span_integrity(tiny_repo: pathlib.Path):
    a = index_repo.index_repo(str(tiny_repo), 1_000_000)
    b = index_repo.index_repo(str(tiny_repo), 1_000_000)
    assert json.dumps(index_repo.asdict(a), sort_keys=True) == json.dumps(index_repo.asdict(b), sort_keys=True)
    for sym in a.symbols:
        lines = (tiny_repo / sym.path).read_text().splitlines()
        assert 1 <= sym.line_start <= sym.line_end <= max(len(lines), 1)
        if sym.kind == "class":
            assert lines[sym.line_start - 1].startswith("class ")


def test_cli_outputs_json(tiny_repo: pathlib.Path):
    out = subprocess.run([sys.executable, "-I", str(PY / "index_repo.py"), str(tiny_repo)], capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    assert data["repo"]["head_sha"]
    assert "limitations" in data and data["limitations"]


def test_only_files_parses_listed_paths_but_resolves_imports_against_all_modules(tiny_repo: pathlib.Path, tmp_path: pathlib.Path):
    full = index_repo.index_repo(str(tiny_repo), 1_000_000)
    partial = index_repo.index_repo(str(tiny_repo), 1_000_000, only_files=["app/services/pricing.py", "docs/missing.md"])
    assert partial.partial is True
    assert partial.only_files == ["app/services/pricing.py"]  # untracked paths are ignored
    assert full.partial is False and full.only_files == []
    # Only the listed file is parsed ...
    assert {s.path for s in partial.symbols} == {"app/services/pricing.py"}
    assert partial.tests == [] and partial.docs == []
    # ... but the tracked tree and module list are complete, so imports resolve to modules that were not parsed.
    assert partial.files == full.files
    assert partial.modules == full.modules
    assert "app.services.discounts" in partial.modules and "tests.test_pricing" in partial.modules
    discounts = [i for i in partial.imports if i.from_module == "app.services.pricing" and i.to_module == "app.services.discounts"]
    assert discounts and discounts[0].resolved_internal is True
    assert [i for i in partial.imports if i.to_module == "decimal"][0].resolved_internal is False
    # The parsed entries are identical to the full run's entries for that file.
    assert [index_repo.asdict(s) for s in partial.symbols] == [index_repo.asdict(s) for s in full.symbols if s.path == "app/services/pricing.py"]
    assert [index_repo.asdict(c) for c in partial.calls] == [index_repo.asdict(c) for c in full.calls if c.path == "app/services/pricing.py"]
    # An empty list still reports the tree.
    empty = index_repo.index_repo(str(tiny_repo), 1_000_000, only_files=[])
    assert empty.partial is True and empty.symbols == [] and empty.modules == full.modules
    # CLI form: the list travels through a JSON file.
    listing = tmp_path / "only.json"
    listing.write_text(json.dumps(["tests/test_pricing.py"]))
    out = subprocess.run([sys.executable, "-I", str(PY / "index_repo.py"), str(tiny_repo), "--only-files", str(listing)], capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    assert data["partial"] is True and data["only_files"] == ["tests/test_pricing.py"]
    assert {s["path"] for s in data["symbols"]} == {"tests/test_pricing.py"}
    assert [t["name"] for t in data["tests"]] == ["test_quote"]
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"not": "a list"}))
    res = subprocess.run([sys.executable, "-I", str(PY / "index_repo.py"), str(tiny_repo), "--only-files", str(bad)], capture_output=True, text=True)
    assert res.returncode == 2 and "error" in json.loads(res.stdout)


def test_src_layout_module_names_drop_the_src_prefix(tmp_path: pathlib.Path):
    repo = tmp_path / "s"
    (repo / "src" / "pkg").mkdir(parents=True)
    (repo / "tests").mkdir()
    (repo / "src" / "pkg" / "__init__.py").write_text("")
    (repo / "src" / "pkg" / "core.py").write_text("def f():\n    return 1\n")
    (repo / "src" / "pkg" / "api.py").write_text("from pkg.core import f\nfrom . import core\n\n\ndef g():\n    return f() + core.f()\n")
    (repo / "tests" / "test_core.py").write_text("from pkg.core import f\n\n\ndef test_f():\n    assert f() == 1\n")
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "add", "-A")
    _git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
    result = index_repo.index_repo(str(repo), 1_000_000)
    qns = {s.qualified_name for s in result.symbols}
    assert "pkg.core.f" in qns and "pkg.api.g" in qns and not any(q.startswith("src.") for q in qns)
    assert "pkg.core" in result.modules and "src.pkg.core" not in result.modules
    resolved = {(i.from_module, i.to_module) for i in result.imports if i.resolved_internal}
    assert ("pkg.api", "pkg.core") in resolved  # absolute import resolves without the src prefix
    assert ("pkg.api", "pkg") in resolved  # relative `from . import core` resolves to the package
    assert ("tests.test_core", "pkg.core") in resolved
