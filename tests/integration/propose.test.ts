import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setupFixtureEnv, type TestEnv } from "../helpers/fixture.ts";
import { ingestProposals, installSkill, loadDigest, SKILL_NAME, skillText } from "../../src/propose.ts";
import { acceptCandidate, loadReviewState } from "../../src/review.ts";
import { PROJECT_ROOT } from "../../src/config.ts";

let env: TestEnv;
let policyFile: string;
let outDir: string;
let head: string;

const POLICY = `schema_version: "1.0"
policy_id: startup_billing
applies_to: { project_name: startup_billing }
default_allowed_paths: ["app/**", "tests/**"]
protected_paths: ["docs/**"]
commands:
  pytest_project: { description: suite, track: functional, argv: ["{python}", "-m", "pytest", "tests", "-q", "-o", "pythonpath=.", "--junit-xml={junit}"] }
  scope_check: { description: scope, track: scope, builtin: scope_check }
invariants: []
architecture_rules: []
decisions: []
`;

const WRITTEN_TEST = `from app.domain.money import Money
from app.services.exports import Invoice, InvoiceExportService


def test_csv_export_ends_with_the_total_line():
    invoice = Invoice(invoice_id="inv-1", contract_id="c-1", lines=[("Seats", Money.of("10.00"))], total=Money.of("10.00"))
    data = InvoiceExportService().export(invoice, "csv")
    assert data.splitlines()[-1].startswith(b"inv-1,c-1,TOTAL,10.00")
`;

beforeAll(() => {
  env = setupFixtureEnv();
  policyFile = path.join(env.home, "policies", "startup_billing.yaml");
  fs.mkdirSync(path.dirname(policyFile), { recursive: true });
  fs.writeFileSync(policyFile, POLICY);
  outDir = path.join(env.home, "propose-out");
  head = spawnSync("git", ["-C", env.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
});
afterAll(() => env.cleanup());

describe("intentos propose — host-authored candidates are checked, tested and turned into the review list", () => {
  it("accepts a lifted existing test, a written test that passes and an architecture rule; rejects invented references, failing tests and untested invariants", async () => {
    const r = await ingestProposals(
      env.repo,
      [
        {
          title: "Volume discount applies at the seat threshold",
          statement: "A contract at or above the seat threshold must receive the volume discount at checkout.",
          category: "business_rule",
          rationale: "Customers are quoted the discount.",
          relevance: "high",
          evidence: [{ type: "commit", ref: head.slice(0, 7), excerpt: "fixture head" }],
          applies_to_paths: ["app/api/checkout.py"],
          test: { existing: "tests/test_checkout.py::test_checkout_applies_volume_discount" },
        },
        {
          title: "CSV export ends with a TOTAL line",
          statement: "A CSV invoice export must end with the TOTAL line.",
          evidence: [{ type: "test", ref: "tests/test_exports.py::test_csv_export", excerpt: "b\"inv-42,c-1,TOTAL,5400.00,USD\\n\"" }],
          applies_to_paths: ["app/services/exports.py"],
          test: { source: WRITTEN_TEST },
        },
        { title: "Broken written test", statement: "Something the repository does not actually do today.", evidence: [{ type: "doc", ref: "README.md:1", excerpt: "# startup_billing" }], test: { source: "def test_never_true():\n    assert 1 == 2\n" } },
        { title: "Invented reference", statement: "A rule citing a document that does not exist in the repository.", evidence: [{ type: "doc", ref: "docs/missing.md:3", excerpt: "x" }], test: { existing: "tests/test_exports.py::test_csv_export" } },
        { title: "Untested invariant", statement: "Quotes must always carry a currency code of three letters.", evidence: [{ type: "doc", ref: "README.md:1", excerpt: "# startup_billing" }] },
        { kind: "architecture_rule", title: "api never imports legacy", statement: "The api package must never import the legacy adapter.", evidence: [{ type: "import", ref: "app/api/checkout.py:1", excerpt: "import" }], rule: { kind: "forbidden_import", paths: ["app/api/**"], forbidden_modules: ["app.legacy"] } },
        { kind: "decision", title: "Exports live in the export service", statement: "New invoice export formats must be added to the export service, never to the legacy adapter.", evidence: [{ type: "doc", ref: "README.md:1", excerpt: "# startup_billing" }], sources: ["README.md", { path: "docs/adr-0001-export-service.md", heading: "Decision" }] },
        { title: "x" },
      ],
      { policyFile, outDir },
    );
    expect(r.accepted.map((a) => [a.id, a.verified])).toEqual([
      ["CAND-001", "lifted"],
      ["CAND-002", "written"],
      ["CAND-003", "none"],
      ["CAND-004", "none"],
    ]);
    expect(r.candidates[3]!.sources).toEqual([{ path: "README.md", heading: null }, { path: "docs/adr-0001-export-service.md", heading: "Decision" }]);
    const reasons = Object.fromEntries(r.rejected.map((x) => [x.title, x.reasons.join(" | ")]));
    expect(reasons["Broken written test"]).toMatch(/fails at [0-9a-f]{7} in the repository's venv/);
    expect(reasons["Broken written test"]).toMatch(/assert 1 == 2/);
    expect(reasons["Invented reference"]).toMatch(/docs\/missing\.md is not a tracked file/);
    expect(reasons["Untested invariant"]).toMatch(/needs a test/);
    expect(reasons["x"]).toMatch(/statement/);
    const written = r.candidates[1]!;
    expect(written.suggested_hidden_test!.from).toBe("codex:csv-export-ends-with-a-total-line");
    expect(written.suggested_hidden_test!.standalone).toBe(true);
    expect((written.suggested_hidden_test as { pending_run?: boolean }).pending_run).toBeUndefined();
    expect(r.candidates[0]!.suggested_hidden_test!.source).toMatch(/def make_contract/); // lifted with its fixture
    const saved = JSON.parse(fs.readFileSync(r.files.json, "utf8")) as { authored_by: string; note: string; author: { via: string } };
    expect(saved.authored_by).toBe("codex");
    expect(saved.author.via).toBe("host");
    expect(saved.note).toMatch(new RegExp(SKILL_NAME));
    expect(fs.readFileSync(r.files.markdown, "utf8")).toMatch(/CSV export ends with a TOTAL line/);
  }, 120_000);

  it("the review reads the list as it is and an approval writes the test the agent wrote", async () => {
    fs.writeFileSync(policyFile, POLICY);
    const state = await loadReviewState(env.repo, { policyFile, outDir, hiddenTestsRoot: path.join(env.home, "hidden-propose"), by: "tester" });
    expect(state.candidates.map((c) => c.title)).toEqual(["Volume discount applies at the seat threshold", "CSV export ends with a TOTAL line", "api never imports legacy", "Exports live in the export service"]);
    const result = acceptCandidate(state, state.candidates[1]!, undefined, "tester");
    expect(result.assigned_id).toBe("INV-001");
    expect(result.hidden_test_complete).toBe(true);
    const file = fs.readFileSync(result.hidden_test!, "utf8");
    expect(file).toMatch(/Written by the coding agent/);
    expect(file).toMatch(/def test_csv_export_ends_with_the_total_line/);
    expect(fs.readFileSync(policyFile, "utf8")).toMatch(/verified_by:[\s\S]{0,400}test_inv_001_csv_export_ends_with_a_total_line\.py/); // the test file is listed on INV-001
  });

  it("append keeps the accepted candidates and continues the ids; a plain propose replaces them", async () => {
    const again = await ingestProposals(env.repo, [{ title: "Fixed later", statement: "The JSON export must carry the invoice id.", evidence: [{ type: "test", ref: "tests/test_exports.py::test_json_export", excerpt: "invoice_id" }], test: { existing: "tests/test_exports.py::test_json_export" } }], { policyFile, outDir, append: true });
    expect(again.accepted.map((a) => a.id)).toEqual(["CAND-005"]);
    expect(again.candidates.map((c) => c.id)).toEqual(["CAND-001", "CAND-002", "CAND-003", "CAND-004", "CAND-005"]);
    const replaced = await ingestProposals(env.repo, [{ title: "Only one", statement: "The JSON export must carry the invoice id.", evidence: [{ type: "test", ref: "tests/test_exports.py::test_json_export", excerpt: "invoice_id" }], test: { existing: "tests/test_exports.py::test_json_export" } }], { policyFile, outDir });
    expect(replaced.candidates.map((c) => c.id)).toEqual(["CAND-001"]);
    expect(fs.existsSync(path.join(outDir, "review-decisions.json"))).toBe(false);
  }, 120_000);

  it("the evidence digest lists the facts the miner reads, is cached per revision, and its test refs lift as they are", async () => {
    const digest = loadDigest(env.repo, { outDir });
    expect(digest.language).toBe("python");
    expect(digest.head).toBe(head);
    expect(digest.counts.tests).toBeGreaterThan(10);
    expect(digest.tests.find((t) => t.ref === "tests/test_locked_contract.py::test_cancelled_contract_gets_no_discount")).toMatchObject({ rule_like: true, language: "python" });
    expect(digest.tests.find((t) => t.ref === "tests/test_locked_contract.py::test_cancelled_contract_gets_no_discount")!.production_paths).toContain("app/services/pricing.py");
    expect(digest.commits.some((c) => c.looks_like_fix)).toBe(true);
    expect(digest.documents.some((d) => d.path === "docs/business-policy.md" && /never/i.test(d.sentence))).toBe(true);
    expect(digest.adrs.length).toBe(3);
    expect(digest.adrs.some((a) => a.status === "superseded")).toBe(true);
    expect(digest.stale_dirs.some((d) => d.dir === "app/legacy")).toBe(true);
    expect(digest.imports.some((e) => e.from_dir === "app/api" && e.to_dir === "app/services")).toBe(true);
    const cached = JSON.parse(fs.readFileSync(path.join(outDir, "evidence.json"), "utf8")) as { head: string };
    expect(cached.head).toBe(head);
    const withTest = digest.tests.find((t) => t.rule_like)!;
    const r = await ingestProposals(env.repo, [{ title: "From the digest", statement: "The behaviour proven by the cited test must be preserved as it is.", test: { existing: withTest.ref }, rationale: "picked from the digest" }], { policyFile, outDir });
    expect(r.accepted.map((a) => a.verified)).toEqual(["lifted"]);
    expect(r.candidates[0]!.evidence.map((e) => e.type)).toContain("test");
  }, 120_000);

  it("installs the skill as a symlink Codex can scan, and the CLI is wired", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intentos-skills-"));
    try {
      const first = installSkill({ dir });
      expect(first.created).toBe(true);
      expect(fs.readFileSync(path.join(first.link, "SKILL.md"), "utf8")).toBe(skillText());
      expect(skillText()).toMatch(/^---\nname: intentos-policy-mining\ndescription: .+\n---\n/);
      expect(installSkill({ dir }).created).toBe(false);
      fs.rmSync(first.link);
      fs.mkdirSync(first.link);
      expect(() => installSkill({ dir })).toThrow(/not a symlink/);
      expect(installSkill({ dir, force: true }).created).toBe(true);
      const res = spawnSync("node", ["--disable-warning=ExperimentalWarning", path.join(PROJECT_ROOT, "bin", "intentos.js"), "skill", "install", "--dir", dir], { encoding: "utf8", env: { ...process.env, INTENTOS_HOME: env.home } });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/already installed/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
