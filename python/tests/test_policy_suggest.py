from __future__ import annotations

import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import policy_suggest as ps  # noqa: E402


def _git(repo: pathlib.Path, *args: str) -> None:
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *args], cwd=repo, capture_output=True, text=True, check=True)


def _write(root: pathlib.Path, rel: str, text: str = "") -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def _repo(tmp_path: pathlib.Path) -> pathlib.Path:
    repo = tmp_path / "r"
    _write(repo, "app/__init__.py")
    _write(repo, "app/domain/__init__.py")
    _write(repo, "app/domain/money.py", "class Money:\n    pass\n")
    _write(repo, "app/services/__init__.py")
    _write(repo, "app/services/pricing.py", "from app.domain.money import Money\n\n\ndef quote():\n    return Money()\n")
    _write(repo, "app/services/discounts.py", "from app.domain.money import Money\n\n\ndef eligible(c):\n    return True\n")
    _write(repo, "app/api/__init__.py")
    _write(repo, "app/api/checkout.py", "from app.services.pricing import quote\n\n\ndef checkout():\n    return quote()\n")
    _write(repo, "app/legacy/__init__.py")
    _write(repo, "app/legacy/adapter.py", "def old():\n    return 1\n")
    _write(repo, "tests/test_money.py", "from app.domain.money import Money\n\n\ndef test_subtraction_never_goes_negative():\n    assert Money()\n\n\ndef test_add():\n    assert True\n")
    _write(repo, "docs/business-policy.md", "# Business Policy\n\n## Locked contracts\n\nLocked contracts never receive discounts of any kind. Promotions must flow through eligibility.\n\n## Pricing ownership\n\nModules under `app/api/**` must not import `app.domain.money`.\n")
    _write(repo, "docs/adr-001-pricing.md", "# ADR-001: PricingService owns pricing\n\nStatus: Accepted\nDate: 2026-03-02\n\n## Context\n\nBugs.\n\n## Decision\n\nPricingService computes all prices. The API layer formats only.\n\n## Consequences\n\nNone.\n")
    _write(repo, "docs/adr-002-legacy.md", "# ADR-002: Legacy adapter\n\nStatus: Superseded by ADR-003\n\n## Decision\n\nUse the legacy adapter.\n")
    _write(repo, "CHANGELOG.md", "# Changelog\n\n## 1.2.0\n\n- Deprecated: the legacy adapter will be removed in 2.0.\n- Added docs.\n")
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "Initial billing domain")
    _write(repo, "app/services/discounts.py", "from app.domain.money import Money\n\n\ndef eligible(c):\n    return c.status != 'cancelled'\n")
    _write(repo, "tests/test_discounts.py", "from app.services.discounts import eligible\n\n\ndef test_cancelled_contract_gets_no_discount():\n    class C:\n        status = 'cancelled'\n    assert eligible(C()) is False\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "Fix: cancelled contracts received volume discounts")
    _write(repo, "README.md", "# r\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "Fix typo in readme")
    return repo


def _by_title(out: dict, needle: str) -> dict:
    hits = [c for c in out["candidates"] if needle.lower() in c["title"].lower()]
    assert hits, f"no candidate titled like {needle!r}: {[c['title'] for c in out['candidates']]}"
    return hits[0]


def test_commit_evidence_merges_into_the_regression_test_candidate(tmp_path: pathlib.Path):
    out = ps.Miner(str(_repo(tmp_path)), 100).run("billing")
    c = _by_title(out, "Cancelled contract gets no discount")
    assert c["kind"] == "invariant" and c["confidence"] == "high"
    types = {e["type"] for e in c["evidence"]}
    assert {"test", "commit"} <= types
    assert any(e["ref"] == "tests/test_discounts.py::test_cancelled_contract_gets_no_discount" for e in c["evidence"])
    assert "app/services/discounts.py" in c["applies_to_paths"]
    assert "def test_cancelled_contract_gets_no_discount" in c["suggested_hidden_test"]["source"]
    assert "from app.services.discounts import eligible" in c["suggested_hidden_test"]["imports"]
    assert c["policy_block"]["verified_by"] == ["benchmarks/hidden_tests/billing/invariants/test_inv_TODO_cancelled_contract_gets_no_discount.py"]
    assert c["policy_block"]["approved_by"] == "TODO"
    # the commit no longer appears as a separate candidate, and the typo commit never did
    assert not any(e["type"] == "commit" and "typo" in e["excerpt"].lower() for c2 in out["candidates"] for e in c2["evidence"])
    assert sum(1 for c2 in out["candidates"] if c2["evidence"][0]["type"] == "commit") == 0


def test_rule_like_tests_become_invariants_with_hidden_test_drafts(tmp_path: pathlib.Path):
    out = ps.Miner(str(_repo(tmp_path)), 100).run("billing")
    c = _by_title(out, "Subtraction never goes negative")
    assert c["confidence"] == "high" and c["suggested_hidden_test"]["from"] == "tests/test_money.py::test_subtraction_never_goes_negative"
    assert "app/domain/money.py" in c["applies_to_paths"]
    assert not any("test_add" in c2["title"].lower() or c2["title"] == "Add" for c2 in out["candidates"])  # plain tests are not rules


def test_documents_adrs_and_changelog(tmp_path: pathlib.Path):
    out = ps.Miner(str(_repo(tmp_path)), 100).run("billing")
    locked = _by_title(out, "Locked contracts")
    assert locked["kind"] == "invariant" and locked["sources"] == [{"path": "docs/business-policy.md", "heading": "Locked contracts"}]
    assert len(locked["evidence"]) == 2 and locked["statement"].startswith("Locked contracts never receive")
    ownership = _by_title(out, "Pricing ownership")
    assert ownership["kind"] == "architecture_rule"
    adrs = {c["title"]: c for c in out["candidates"] if c["kind"] == "decision" and c["evidence"][0]["type"] == "adr"}
    assert adrs["ADR-001: PricingService owns pricing"]["status"] == "approved"
    assert adrs["ADR-001: PricingService owns pricing"]["statement"].startswith("PricingService computes all prices.")
    assert adrs["ADR-002: Legacy adapter"]["status"] == "superseded"
    assert any(c["kind"] == "decision" and c["evidence"][0]["type"] == "changelog" and "Deprecated" in c["statement"] for c in out["candidates"])
    assert not any("Added docs" in c["statement"] for c in out["candidates"])


def test_layering_and_frozen_directories(tmp_path: pathlib.Path):
    out = ps.Miner(str(_repo(tmp_path)), 100).run("billing")
    rules = {c["title"]: c for c in out["candidates"] if c["kind"] == "architecture_rule" and c.get("rule")}
    assert rules["app/domain must not import app/services"]["rule"] == {"kind": "forbidden_import", "paths": ["app/domain/**"], "forbidden_modules": ["app.services"]}
    assert rules["app/services must not import app/api"]["confidence"] == "medium"
    assert "app/api must not import app/services" not in rules  # that direction exists today
    frozen = [c for c in out["candidates"] if c["kind"] == "frozen_paths"]
    assert [c["rule"] for c in frozen] == [{"kind": "frozen_paths", "paths": ["app/legacy/**"]}]
    assert frozen[0]["policy_block"]["kind"] == "frozen_paths"


def test_ordering_ids_and_cli(tmp_path: pathlib.Path):
    repo = _repo(tmp_path)
    out = ps.Miner(str(repo), 100).run("billing")
    confidences = [c["confidence"] for c in out["candidates"]]
    assert confidences == sorted(confidences, key={"high": 0, "medium": 1, "low": 2}.get)
    assert [c["id"] for c in out["candidates"]] == [f"CAND-{i:03d}" for i in range(1, len(out["candidates"]) + 1)]
    res = subprocess.run([sys.executable, "-I", str(HERE.parent / "policy_suggest.py"), str(repo), "--policy-id", "billing"], capture_output=True, text=True, check=True)
    assert '"policy_id": "billing"' in res.stdout


def test_housekeeping_commits_and_adjective_fixed_are_not_rules(tmp_path: pathlib.Path):
    repo = _repo(tmp_path)
    for subject, rel, text in [
        ("Fix black issues", "app/services/pricing.py", "from app.domain.money import Money\n\n\ndef quote():\n    return Money()  # noqa\n"),
        ("Fix line length in pricing", "app/services/pricing.py", "from app.domain.money import Money\n\n\ndef quote():\n    return Money()\n"),
        ("Allow usage of fixed season time intervals", "app/services/seasons.py", "FIXED = True\n"),
        ("Fix tests", "app/services/seasons.py", "FIXED = False\n"),
        ("Fix: rounding of totals drifted by a cent", "app/services/pricing.py", "from app.domain.money import Money\n\n\ndef quote():\n    return Money().round()\n"),
        ("Fix: rounding of totals drifted by a cent", "app/services/pricing.py", "from app.domain.money import Money\n\n\ndef quote():\n    return Money().round2()\n"),
    ]:
        _write(repo, rel, text)
        _git(repo, "add", "-A")
        _git(repo, "commit", "-qm", subject)
    out = ps.Miner(str(repo), 100).run("billing")
    titles = [c["title"] for c in out["candidates"] if c["evidence"][0]["type"] == "commit"]
    assert titles == ["Rounding of totals drifted by a cent"]  # housekeeping, "fixed season", "Fix tests" all filtered; duplicate subject merged
    rounding = next(c for c in out["candidates"] if c["title"] == "Rounding of totals drifted by a cent")
    assert rounding["confidence"] == "medium" and len([e for e in rounding["evidence"] if e["type"] == "commit"]) == 2


def test_src_layout_parent_child_layering_and_contributing_skipped(tmp_path: pathlib.Path):
    repo = tmp_path / "s"
    _write(repo, "src/pkg/__init__.py")
    _write(repo, "src/pkg/tools.py", "def helper():\n    return 1\n")
    _write(repo, "src/pkg/bdew/__init__.py")
    _write(repo, "src/pkg/bdew/elec.py", "from pkg.tools import helper\n\n\ndef profile():\n    return helper()\n")
    _write(repo, "src/pkg/vdi/__init__.py")
    _write(repo, "src/pkg/vdi/regions.py", "from pkg.bdew.elec import profile\n\n\ndef region():\n    return profile()\n")
    _write(repo, "CONTRIBUTING.md", "# Contributing\n\nYou must run black before pushing. Never force-push.\n")
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "init")
    out = ps.Miner(str(repo), 100).run("pkg")
    rules = {c["title"]: c for c in out["candidates"] if c["kind"] == "architecture_rule"}
    assert "src/pkg must not import src/pkg/bdew" in rules  # parent must not depend on its subpackage
    assert rules["src/pkg must not import src/pkg/bdew"]["rule"] == {"kind": "forbidden_import", "paths": ["src/pkg/**"], "forbidden_modules": ["pkg.bdew"]}
    assert "src/pkg/bdew must not import src/pkg/vdi" in rules  # siblings, one direction only
    assert not any("Contributing" in c["title"] for c in out["candidates"])
