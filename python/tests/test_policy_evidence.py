from __future__ import annotations

import json
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import policy_evidence as pe  # noqa: E402


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


def _ts_repo(tmp_path: pathlib.Path) -> pathlib.Path:
    repo = tmp_path / "ts"
    _write(repo, "package.json", json.dumps({"name": "ledger", "type": "module", "scripts": {"test": "vitest run"}, "devDependencies": {"vitest": "^3"}}))
    _write(repo, "tsconfig.json", json.dumps({"compilerOptions": {"baseUrl": ".", "paths": {"@/*": ["src/*"]}}}))
    _write(repo, "src/domain/money.ts", "export class Money {\n  constructor(public cents: number, public currency: string) {}\n}\n")
    _write(repo, "src/domain/ledger.ts", "import { Money } from './money.ts';\nexport class Ledger {\n  post(m: Money) { return m; }\n}\n")
    _write(repo, "src/api/handlers.ts", "import { Ledger } from '@/domain/ledger';\nexport const h = new Ledger();\n")
    _write(repo, "tests/ledger.test.ts", "import { describe, expect, it } from 'vitest';\nimport { Ledger } from '../src/domain/ledger.ts';\nimport { Money } from '@/domain/money';\n\ndescribe('Ledger', () => {\n  it('never posts a negative balance', () => {\n    expect(new Ledger().post(new Money(1, 'EUR')).cents).toBe(1);\n  });\n\n  it(`formats ${'money'}`, () => {\n    expect(1).toBe(1);\n  });\n});\n")
    _write(repo, "docs/rules.md", "# Rules\n\n## Balances\n\nA balance MUST never go below zero.\n")
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "init")
    return repo


def test_digest_reports_tests_commits_documents_structure_and_changelog_as_facts(tmp_path: pathlib.Path):
    repo = _repo(tmp_path)
    out = pe.Digest(str(repo), 100).run("billing")
    assert out["language"] == "python" and out["source_dirs"] == ["app", "app/api", "app/domain", "app/legacy", "app/services"]
    by_ref = {t["ref"]: t for t in out["tests"]}
    cancelled = by_ref["tests/test_discounts.py::test_cancelled_contract_gets_no_discount"]
    assert cancelled["rule_like"] is True and cancelled["production_paths"] == ["app/services/discounts.py"] and cancelled["excerpt"].startswith("assert eligible")
    assert by_ref["tests/test_money.py::test_add"]["rule_like"] is False
    fix = next(c for c in out["commits"] if c["subject"].startswith("Fix: cancelled"))
    assert fix["looks_like_fix"] is True and fix["tests_added"] == ["test_cancelled_contract_gets_no_discount"] and fix["source_files"] == ["app/services/discounts.py"]
    assert not any(c["subject"] == "Fix typo in readme" for c in out["commits"])  # no code touched: not behaviour
    sentences = [d["sentence"] for d in out["documents"] if d["path"] == "docs/business-policy.md"]
    assert any("never receive discounts" in s for s in sentences) and any("must not import" in s for s in sentences)
    assert {a["path"]: a["status"] for a in out["adrs"]} == {"docs/adr-001-pricing.md": "approved", "docs/adr-002-legacy.md": "superseded"}
    assert next(a for a in out["adrs"] if a["status"] == "superseded")["supersedes"] is None
    edges = {(e["from_dir"], e["to_dir"]) for e in out["imports"]}
    assert ("app/api", "app/services") in edges and ("app/services", "app/domain") in edges and ("app/domain", "app/services") not in edges
    assert any(s["dir"] == "app/legacy" and s["name_suggests_legacy"] for s in out["stale_dirs"])
    assert any("legacy adapter will be removed" in e["text"] for e in out["changelog"])
    assert out["counts"]["tests"] == 3 and out["counts"]["fix_commits"] == 1
    # the module never ranks or classifies: no scores, no candidates
    assert "candidates" not in out and all("score" not in t for t in out["tests"])


def test_digest_reads_typescript_tests_imports_and_aliases(tmp_path: pathlib.Path):
    repo = _ts_repo(tmp_path)
    out = pe.Digest(str(repo), 100).run("ledger")
    assert out["language"] == "typescript"
    refs = {t["ref"]: t for t in out["tests"]}
    t = refs["tests/ledger.test.ts::never posts a negative balance"]
    assert t["language"] == "typescript" and t["describe"] == ["Ledger"] and t["rule_like"] is True
    assert t["production_paths"] == ["src/domain/ledger.ts", "src/domain/money.ts"]  # relative import and tsconfig alias both resolve
    assert "tests/ledger.test.ts::formats ${'money'}" not in refs  # template titles with expressions are not stable names
    assert {(e["from_dir"], e["to_dir"]) for e in out["imports"]} == {("src/api", "src/domain")}
    assert any("MUST never go below zero" in d["sentence"] for d in out["documents"])


def test_cli_prints_the_digest(tmp_path: pathlib.Path):
    repo = _repo(tmp_path)
    res = subprocess.run([sys.executable, "-I", str(HERE.parent / "policy_evidence.py"), str(repo), "--policy-id", "billing"], capture_output=True, text=True, check=True)
    out = json.loads(res.stdout)
    assert out["policy_id"] == "billing" and out["counts"]["tests"] == 3 and out["head"]


def test_lifted_python_tests_are_self_contained_and_submodule_imports_resolve(tmp_path: pathlib.Path):
    repo = tmp_path / "t"
    _write(repo, "pkg/__init__.py")
    _write(repo, "pkg/tools.py", "def add_weekdays(df, holidays=None):\n    return df\n")
    _write(repo, "pkg/bdew/__init__.py")
    _write(repo, "pkg/bdew/elec.py", "def profile():\n    return 1\n")
    _write(repo, "tests/conftest.py", "from __future__ import annotations\n\nimport pytest\n\n\n@pytest.fixture\ndef example_houses():\n    return [{'N_Pers': 2}]\n")
    _write(repo, "tests/test_tools.py", "import pandas as pd\nimport pytest\nfrom pkg import tools\nfrom pkg.bdew import elec\n\nYEAR = 2017\n\n\n@pytest.fixture\ndef frame(example_houses):\n    return pd.DataFrame({'y': [YEAR]})\n\n\nclass TestWeekdays:\n    @classmethod\n    def setup_class(cls):\n        cls.df = pd.DataFrame({'x': [1]})\n\n    def test_weekdays_no_holidays(self):\n        dt = tools.add_weekdays(self.df)\n        assert dt is self.df\n\n    def helper(self):\n        return 1\n\n\ndef test_frame_never_empty(frame):\n    assert len(frame) == 1\n\n\ndef test_profile_never_none(missing_fixture):\n    assert elec.profile() is not None\n")
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "init")
    ing = pe.Ingestor(str(repo))
    # class-based test: header + setup_class + the test method, helper left out
    draft, err, _ = ing.find_test("tests/test_tools.py::TestWeekdays::test_weekdays_no_holidays")
    assert err is None and draft["standalone"] is True and draft["notes"] == []
    assert "class TestWeekdays:" in draft["source"] and "def test_weekdays_no_holidays(self):" in draft["source"]
    assert "    @classmethod\n    def setup_class(cls):\n        cls.df = " in draft["source"]
    assert "def helper" not in draft["source"]
    compile(draft["source"], "draft", "exec")
    assert "from pkg import tools" in draft["imports"]
    # module-level test: its fixture, the fixture's fixture from conftest, and the constant the fixture uses are included
    frame, err, _ = ing.find_test("tests/test_tools.py::test_frame_never_empty")
    assert err is None
    assert "@pytest.fixture\ndef frame(example_houses):" in frame["source"] and "@pytest.fixture\ndef example_houses():" in frame["source"] and "YEAR = 2017" in frame["source"]
    assert frame["source"].startswith("from __future__ import annotations\n")
    compile(frame["source"], "draft", "exec")
    # unknown fixture is reported, not silently dropped
    missing, err, _ = ing.find_test("tests/test_tools.py::test_profile_never_none")
    assert err is None and missing["standalone"] is False and "missing_fixture" in missing["notes"][0]
    # the digest resolves `from pkg import tools` and `from pkg.bdew import elec` to the files tests exercise
    digest = pe.Digest(str(repo), 10).run("pkg")
    assert next(t for t in digest["tests"] if t["name"] == "test_weekdays_no_holidays")["production_paths"] == ["pkg/tools.py", "pkg/bdew/elec.py"]
    assert ing.find_test("tests/test_tools.py::test_nope")[1] and "test_nope" in ing.find_test("tests/test_tools.py::test_nope")[1]


def test_lifted_typescript_test_is_the_file_with_imports_repointed_and_the_test_marked_only(tmp_path: pathlib.Path):
    repo = _ts_repo(tmp_path)
    ing = pe.Ingestor(str(repo))
    draft, err, node = ing.find_test("tests/ledger.test.ts::never posts a negative balance")
    assert err is None and draft["language"] == "typescript" and draft["standalone"] is True
    assert node["line"] == 6
    assert "it.only('never posts a negative balance'" in draft["source"]
    assert "from '../../src/domain/ledger.ts'" in draft["source"]  # ../src → ../../src: the hidden dir is two levels down
    assert "from '@/domain/money'" in draft["source"]  # aliases stay as they are; the project config resolves them
    assert "import { describe, expect, it } from 'vitest'" in draft["source"]
    _, err, _ = ing.find_test("tests/ledger.test.ts::does not exist")
    assert err and "does not exist" in err
    # a written vitest module: its imports are checked against the repository and normalised to the hidden depth
    reasons: list[str] = []
    written = ing.written_test("Money is integer", "import { it, expect } from 'vitest';\nimport { Money } from '../../src/domain/money.ts';\nit('x', () => { expect(new Money(1, 'EUR').cents).toBe(1); });\n", reasons)
    assert reasons == [] and written["language"] == "typescript" and written["from"] == "codex:money-is-integer" and written["pending_run"] is True
    reasons = []
    ing.written_test("Broken", "import { it, expect } from 'vitest';\nimport { Nope } from '../../src/domain/nope.ts';\nit('x', () => { expect(Nope).toBe(1); });\n", reasons)
    assert reasons and "../../src/domain/nope.ts" in reasons[0]


def test_ingest_checks_references_lifts_existing_tests_and_requires_a_test_per_invariant(tmp_path: pathlib.Path):
    repo = _repo(tmp_path)
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()
    proposals = [
        {
            "kind": "invariant",
            "title": "Cancelled contracts get no discount",
            "statement": "A contract whose status is cancelled must never receive a volume discount.",
            "category": "business_rule",
            "rationale": "Revenue would be understated.",
            "relevance": "high",
            "evidence": [{"type": "commit", "ref": head[:7], "excerpt": "Fix typo in readme"}],
            "applies_to_paths": ["app/services/discounts.py"],
            "test": {"existing": "tests/test_discounts.py::test_cancelled_contract_gets_no_discount"},
        },
        {"kind": "invariant", "title": "Invented reference", "statement": "Money must never go negative in any case.", "evidence": [{"type": "doc", "ref": "docs/nope.md:3", "excerpt": "x"}], "test": {"existing": "tests/test_money.py::test_subtraction_never_goes_negative"}},
        {"kind": "invariant", "title": "No test given", "statement": "Quotes must always carry a currency code.", "evidence": [{"type": "commit", "ref": "deadbeef", "excerpt": "x"}]},
        {"kind": "architecture_rule", "title": "api never imports legacy", "statement": "The api package must never import the legacy adapter.", "evidence": [{"type": "import", "ref": "app/api/checkout.py:1", "excerpt": "from app.services.pricing import quote"}], "rule": {"kind": "forbidden_import", "paths": ["app/api/**"], "forbidden_modules": ["app.legacy"]}},
        {"kind": "invariant", "title": "Written test", "statement": "Pricing quotes must always return a Money value.", "evidence": [{"type": "doc", "ref": "docs/business-policy.md:5", "excerpt": "Locked contracts never receive discounts"}], "test": {"source": "from app.services.pricing import quote\nfrom app.domain.money import Money\n\n\ndef test_quote_returns_money():\n    assert isinstance(quote(), Money)\n"}},
        {"kind": "decision", "title": "ADR-002 is superseded", "statement": "The legacy adapter decision is superseded by the export service decision.", "evidence": [{"type": "adr", "ref": "docs/adr-002-legacy.md", "excerpt": "Superseded by ADR-003"}], "sources": [{"path": "docs/adr-002-legacy.md", "heading": "Decision"}], "status": "superseded", "supersedes": "ADR-001"},
    ]
    out = pe.Ingestor(str(repo)).ingest(proposals, "r", start=3)
    assert [c["id"] for c in out["candidates"]] == ["CAND-003", "CAND-004", "CAND-005", "CAND-006"]
    assert out["language"] == "python" and out["head"] == head
    lifted = out["candidates"][0]
    assert lifted["suggested_hidden_test"]["from"] == "tests/test_discounts.py::test_cancelled_contract_gets_no_discount"
    assert "def test_cancelled_contract_gets_no_discount" in lifted["suggested_hidden_test"]["source"]
    assert any(e["type"] == "test" and e["line"] == 4 for e in lifted["evidence"])  # the test became evidence with its line
    assert lifted["policy_block"]["verified_by"] == ["benchmarks/hidden_tests/r/invariants/test_inv_TODO_cancelled_contracts_get_no_discount.py"]
    assert lifted["authored_by"] == "codex" and lifted["category"] == "business_rule" and lifted["relevance"] == "high"
    assert lifted["scope"] == ["services", "discounts"]
    assert "score" not in lifted and "classification" not in lifted
    arch = out["candidates"][1]
    assert arch["policy_block"]["kind"] == "forbidden_import" and arch["policy_block"]["forbidden_modules"] == ["app.legacy"]
    written = out["candidates"][2]
    assert written["suggested_hidden_test"]["from"] == "codex:written-test" and written["suggested_hidden_test"]["pending_run"] is True
    decision = out["candidates"][3]
    assert decision["status"] == "superseded" and decision["supersedes"] == "ADR-001" and decision["policy_block"]["id"] == "DEC-TODO"
    reasons = {r["title"]: " ".join(r["reasons"]) for r in out["rejected"]}
    assert "docs/nope.md is not a tracked file" in reasons["Invented reference"]
    assert "commit deadbeef is not in this repository" in reasons["No test given"] and "needs a test" in reasons["No test given"]
    # CLI entry point
    f = tmp_path / "proposals.json"
    f.write_text(json.dumps({"candidates": proposals[:1]}))
    res = subprocess.run([sys.executable, "-I", str(HERE.parent / "policy_evidence.py"), str(repo), "--policy-id", "r", "--ingest", str(f)], capture_output=True, text=True, check=True)
    assert json.loads(res.stdout)["candidates"][0]["id"] == "CAND-001"


def test_ingest_typescript_candidates_point_hidden_tests_at_test_ts_files(tmp_path: pathlib.Path):
    repo = _ts_repo(tmp_path)
    out = pe.Ingestor(str(repo)).ingest(
        [
            {"kind": "invariant", "title": "Balance never negative", "statement": "A ledger balance never goes below zero through post.", "applies_to_paths": ["src/domain/**"], "test": {"existing": "tests/ledger.test.ts::never posts a negative balance"}},
            {"kind": "architecture_rule", "title": "api does not import storage", "statement": "Handlers must not import the storage layer.", "evidence": [{"type": "doc", "ref": "docs/rules.md:5", "excerpt": "MUST never"}], "rule": {"kind": "forbidden_import", "paths": ["src/api/**"], "forbidden_modules": ["src/db"]}},
        ],
        "ledger",
    )
    assert out["language"] == "typescript" and out["rejected"] == []
    inv = out["candidates"][0]
    assert inv["policy_block"]["verified_by"] == ["benchmarks/hidden_tests/ledger/invariants/inv_TODO_balance_never_negative.test.ts"]
    assert inv["evidence"][0] == {"type": "test", "ref": "tests/ledger.test.ts::never posts a negative balance", "excerpt": "expect(new Ledger().post(new Money(1, 'EUR')).cents).toBe(1);", "path": "tests/ledger.test.ts", "line": 6}
    assert inv["scope"] == ["domain"]
    assert out["candidates"][1]["policy_block"]["paths"] == ["src/api/**"]
