import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { setupFixtureEnv, type TestEnv } from "../helpers/fixture.ts";
import { buildClassifyPrompt, rewriteSupported, suggestPolicy, type Candidate } from "../../src/suggest.ts";
import type { CodingEngine, PlanRequest } from "../../src/codex/adapter.ts";
import { PROJECT_ROOT } from "../../src/config.ts";

let env: TestEnv;
beforeAll(() => {
  env = setupFixtureEnv();
});
afterAll(() => env.cleanup());

/** Ground truth for the fixture: candidates that correspond to an entry of policies/startup_billing.yaml. */
const POSITIVE = [
  /cancelled contract gets no discount/i, // INV-001
  /locked contract gets no discount/i, // INV-001
  /locked contracts/i, // INV-001 source section
  /locked until expires/i, // INV-001 lock period
  /declined payment leaves entitlements unchanged/i, // INV-002
  /apply upgrade grants entitlements after payment/i, // INV-002
  /entitlements and payment/i, // INV-002 source section
  /promotions/i, // INV-003 source section
  /pricing ownership/i, // ARCH-001 / DEC-001
  /ADR-001/i, // DEC-001
  /ADR-002/i, // DEC-002
  /ADR-003/i, // DEC-003
  /app\/domain must not import/i, // ARCH-002
  /app\/legacy is frozen/i, // ARCH-004
  /invoice exports/i, // DEC-003 source section
];
/** Candidates that are real but not policy material (value-object unit tests, README preamble). */
const NEGATIVE = [/currency mismatch raises/i, /unsupported format raises/i, /subtraction never goes negative/i, /rules of the house/i, /^architecture$/i, /business policy/i];

const isPositive = (c: Candidate) => POSITIVE.some((re) => re.test(c.title));
const isNegative = (c: Candidate) => NEGATIVE.some((re) => re.test(c.title));

describe("suggest ranking", () => {
  it("ranks policy material above unit-test and preamble noise on the fixture (precision benchmark)", async () => {
    const r = await suggestPolicy(env.repo, { writeAdrs: false, withCodex: false, outDir: path.join(env.home, "rank-out") });
    const ranked = r.candidates;
    expect(ranked.map((c) => c.score)).toEqual([...ranked.map((c) => c.score)].sort((a, b) => b - a));
    expect(ranked.every((c) => c.rank === ranked.indexOf(c) + 1)).toBe(true);
    const top10 = ranked.slice(0, 10);
    const precisionAt10 = top10.filter(isPositive).length / 10;
    const negativesInTop10 = top10.filter(isNegative).length;
    const positives = ranked.filter(isPositive);
    const negatives = ranked.filter(isNegative);
    const meanPos = positives.reduce((s, c) => s + c.score, 0) / positives.length;
    const meanNeg = negatives.reduce((s, c) => s + c.score, 0) / negatives.length;
    console.log(`[suggest_rank] precision@10=${precisionAt10.toFixed(2)} negatives_in_top10=${negativesInTop10} mean_pos=${meanPos.toFixed(2)} mean_neg=${meanNeg.toFixed(2)} n=${ranked.length}`);
    expect(precisionAt10).toBeGreaterThanOrEqual(0.7);
    expect(negativesInTop10).toBeLessThanOrEqual(1);
    expect(meanPos).toBeGreaterThan(meanNeg + 0.1);
    // every known positive scores at least medium relevance; README preamble sections never reach high
    expect(positives.every((c) => c.relevance !== "low")).toBe(true);
    expect(negatives.filter((c) => /rules of the house|^architecture$|business policy/i.test(c.title)).every((c) => c.relevance !== "high")).toBe(true);
    // clusters: the locked/cancelled contract rules share one cluster, and no cluster swallows most candidates
    const cancelled = ranked.find((c) => /cancelled contract gets no discount/i.test(c.title))!;
    const locked = ranked.find((c) => /locked contract gets no discount/i.test(c.title))!;
    expect(cancelled.cluster).toBe(locked.cluster);
    expect(cancelled.cluster_members).toContain(locked.id);
    expect(Math.max(...ranked.map((c) => c.cluster_size))).toBeLessThan(ranked.length / 2);
    // signals are present and the review document shows them
    expect(cancelled.signals.corroboration).toBeGreaterThan(0); // test + commit (+ doc section in the cluster)
    const md = fs.readFileSync(r.files.markdown, "utf8");
    expect(md).toContain("## high relevance");
    expect(md).toMatch(/score \d\.\d\d \(high; domain/);
    expect(r.vocabulary).toEqual(expect.arrayContaining(["contract", "discount"]));
    expect(r.classification.used).toBe(false);
  });

  it("--min-score drops low-relevance candidates", async () => {
    const all = await suggestPolicy(env.repo, { writeAdrs: false, withCodex: false, outDir: path.join(env.home, "rank-all") });
    const cut = await suggestPolicy(env.repo, { writeAdrs: false, withCodex: false, minScore: 0.6, outDir: path.join(env.home, "rank-cut") });
    expect(cut.candidates.length).toBeLessThan(all.candidates.length);
    expect(cut.candidates.every((c) => c.score >= 0.6)).toBe(true);
  });
});

describe("suggest --classify", () => {
  it("applies validated verdicts: keeps business rules, sets aside tooling, rejects unsupported rewrites, ignores unknown ids", async () => {
    const prompts: string[] = [];
    const fake: CodingEngine = {
      name: "fake-classifier",
      simulated: false,
      async plan(req: PlanRequest) {
        prompts.push(req.prompt);
        const ids = [...req.prompt.matchAll(/^### (CAND-\d{3})/gm)].map((m) => m[1]!);
        const verdicts = ids.map((id, i) => {
          const block = req.prompt.split(`### ${id}`)[1]!.split("\n### ")[0]!;
          const isCancelled = /cancelled contract gets no discount/i.test(block);
          const isLocked = /locked contract gets no discount/i.test(block);
          const isCurrency = /currency mismatch/i.test(block);
          if (isCancelled) return { id, category: "business_rule", keep: true, reason: "domain rule with a regression test", rule: "A cancelled contract never receives a discount line from DiscountPolicy.", cluster: "locked-contracts", duplicate_of: null };
          if (isLocked) return { id, category: "business_rule", keep: true, reason: "same family", rule: "Locked contracts never receive discounts, enforced by the PaymentGateway reconciliation job.", cluster: "locked-contracts", duplicate_of: null };
          if (isCurrency) return { id, category: "robustness_rule", keep: false, reason: "value-object validation, not a business rule", rule: "", cluster: "money", duplicate_of: null };
          return { id, category: i % 2 ? "implementation_detail" : "business_rule", keep: i % 2 === 0, reason: "fake", rule: "", cluster: "misc", duplicate_of: null };
        });
        verdicts.push({ id: "CAND-999", category: "business_rule", keep: true, reason: "fabricated", rule: "x", cluster: "x", duplicate_of: null });
        return { text: JSON.stringify({ verdicts }), usage: { input_tokens: 1, output_tokens: 1 }, threadId: "t", simulated: false, engine: "fake-classifier", model: "fake-model", items: [] };
      },
      async implement() {
        throw new Error("not used");
      },
    };
    const r = await suggestPolicy(env.repo, { writeAdrs: false, withCodex: false, classify: true, classifyTop: 25, engine: fake, outDir: path.join(env.home, "classify-out") });
    expect(prompts.length).toBe(2); // 25 candidates in batches of 20
    expect(prompts[0]).toMatch(/Use ONLY the evidence given/);
    expect(prompts[0]).toMatch(/- what the test checks:\n```python\ndef test_/); // the assertion is in the prompt, not only the name
    expect(r.classification).toMatchObject({ used: true, model: "fake-model", classified: 25 });
    expect(r.classification.kept + r.classification.filtered).toBe(25);
    expect(r.candidates.filter((c) => c.classification).length).toBe(25);
    expect(r.candidates.filter((c) => !c.classification).length).toBe(r.candidates.length - 25);
    expect(r.candidates.some((c) => c.id === "CAND-999")).toBe(false);

    const cancelled = r.candidates.find((c) => /cancelled contract gets no discount/i.test(c.title))!;
    expect(cancelled.classification).toMatchObject({ category: "business_rule", keep: true, cluster: "locked-contracts", rule: "A cancelled contract never receives a discount line from DiscountPolicy." });
    expect(cancelled.policy_block.statement).toBe("A cancelled contract never receives a discount line from DiscountPolicy."); // DiscountPolicy appears in the evidence

    const locked = r.candidates.find((c) => /locked contract gets no discount/i.test(c.title))!;
    expect(locked.classification!.keep).toBe(true);
    expect(locked.classification!.rule).toBeNull(); // PaymentGateway is not in the evidence: rewrite rejected, original kept
    expect(locked.classification!.rule_rejected).toMatch(/PaymentGateway/);
    expect(locked.policy_block.statement).toBe(locked.statement);
    expect(r.classification.rewrites_rejected).toBeGreaterThanOrEqual(1);

    const currency = r.candidates.find((c) => /currency mismatch/i.test(c.title))!;
    expect(currency.classification).toMatchObject({ category: "robustness_rule", keep: false });
    expect(r.filtered_out.map((f) => f.id)).toContain(currency.id);

    const md = fs.readFileSync(r.files.markdown, "utf8");
    expect(md).toContain("## Kept after classification");
    expect(md).toContain("## Filtered out by classification (rescue if wrong)");
    expect(md).toContain("## Not classified (below --classify-top)");
    expect(md).toContain("classification: **robustness_rule**, drop");
    const yaml = YAML.parse(fs.readFileSync(r.files.yaml, "utf8")) as { invariants: Array<{ _candidate: string }> };
    expect(yaml.invariants.some((b) => b._candidate === currency.id)).toBe(false);
    expect(yaml.invariants.some((b) => b._candidate === cancelled.id)).toBe(true);
    expect(fs.readFileSync(r.files.yaml, "utf8")).toContain(`Set aside by classification`);
  });

  it("rewrite guard checks identifiers, paths and CamelCase names against the evidence", () => {
    const c = { title: "Locked contract gets no discount", statement: "Locked contract gets no discount.", evidence: [{ type: "test", ref: "tests/test_locked_contract.py::test_locked_contract_gets_no_discount", excerpt: "def test_locked_contract_gets_no_discount(self):", path: "tests/test_locked_contract.py" }], applies_to_paths: ["app/services/discounts.py"], suggested_hidden_test: { from: "x", imports: "", source: "from app.services.discounts import DiscountPolicy", notes: [], standalone: true } } as unknown as Candidate;
    expect(rewriteSupported("Locked contracts never get a discount from DiscountPolicy (app/services/discounts.py).", c)).toEqual({ ok: true, missing: [] });
    expect(rewriteSupported("Locked contracts are checked by `LockService.is_locked`.", c).missing).toEqual(["LockService.is_locked"]);
    expect(rewriteSupported("See app/api/checkout.py for details.", c).missing).toEqual(["app/api/checkout.py"]);
    const commitCand = { ...c, evidence: [{ type: "commit", ref: "c635428", excerpt: "Fix a DataFrame.merge", files: ["src/oemof/demand/bdew/heat_building.py"] }] } as unknown as Candidate;
    expect(rewriteSupported("HeatBuilding profiles stay aligned after the merge.", commitCand).ok).toBe(true); // CamelCase matches the touched file name
    expect(rewriteSupported("ElecSlp profiles stay aligned.", commitCand).missing).toEqual(["ElecSlp"]);
    expect(buildClassifyPrompt([c as Candidate & { score: number; cluster: string; kind: string }]).length).toBeGreaterThan(0);
  });

  it("is wired into the CLI", () => {
    const out = path.join(env.home, "cli-rank");
    const res = spawnSync("node", ["--disable-warning=ExperimentalWarning", path.join(PROJECT_ROOT, "bin", "intentos.js"), "--json", "suggest", env.repo, "--out", out, "--min-score", "0.5"], { encoding: "utf8", env: { ...process.env, INTENTOS_HOME: env.home } });
    expect(res.status, res.stderr).toBe(0);
    const parsed = JSON.parse(res.stdout) as { candidates: Candidate[]; classification: { used: boolean } };
    expect(parsed.candidates.every((c) => c.score >= 0.5)).toBe(true);
    expect(parsed.classification.used).toBe(false);
    const bad = spawnSync("node", ["--disable-warning=ExperimentalWarning", path.join(PROJECT_ROOT, "bin", "intentos.js"), "suggest", env.repo, "--out", out, "--min-score", "7"], { encoding: "utf8", env: { ...process.env, INTENTOS_HOME: env.home } });
    expect(bad.status).toBe(1);
  });
});

describe("suggest --record (review feedback loop)", () => {
  it("learns from what the reviewer pasted into the policy and re-ranks the next run accordingly", async () => {
    const { recordReviewFeedback } = await import("../../src/suggest.ts");
    const outDir = path.join(env.home, "feedback-run");
    const first = await suggestPolicy(env.repo, { writeAdrs: false, withCodex: false, outDir });
    const cancelled = first.candidates.find((c) => /cancelled contract gets no discount/i.test(c.title))!;
    const currency = first.candidates.find((c) => /currency mismatch raises/i.test(c.title))!;
    const unsupported = first.candidates.find((c) => /unsupported format raises/i.test(c.title))!;
    // the reviewer accepted the cancelled-contract rule (hidden test adopted) and wrote INV-001 in their own words
    const policyFile = path.join(env.home, "policies", "startup_billing.yaml");
    fs.mkdirSync(path.dirname(policyFile), { recursive: true });
    fs.writeFileSync(policyFile, YAML.stringify({ invariants: [{ id: "INV-001", statement: "Locked and cancelled contracts never receive discounts or promotions of any kind.", verified_by: ["benchmarks/hidden_tests/startup_billing/invariants/test_inv_001_cancelled_contract_gets_no_discount.py"], sources: [{ path: "docs/business-policy.md", heading: "Locked contracts" }] }], architecture_rules: [], decisions: [] }));
    const feedbackFile = path.join(outDir, "feedback.json");
    const fb = recordReviewFeedback(first.files.json, policyFile, feedbackFile);
    expect(fb.accepted_ids).toContain(cancelled.id);
    expect(fb.accepted_ids).toContain(first.candidates.find((c) => c.title === "Locked contracts")!.id); // by source heading
    expect(fb.rejected_ids).toContain(currency.id);
    expect(fb.accept_tokens).toEqual(expect.arrayContaining(["cancelled", "contract", "discount"]));
    expect(fb.reject_tokens).not.toContain("discount");
    // next run picks feedback.json up automatically: accepted terms rise, rejected terms sink
    const second = await suggestPolicy(env.repo, { writeAdrs: false, withCodex: false, outDir });
    const cancelled2 = second.candidates.find((c) => c.title === cancelled.title)!;
    const currency2 = second.candidates.find((c) => c.title === currency.title)!;
    const unsupported2 = second.candidates.find((c) => c.title === unsupported.title)!;
    expect(cancelled2.score).toBeGreaterThan(cancelled.score);
    expect(currency2.score + unsupported2.score).toBeLessThan(currency.score + unsupported.score);
    expect(cancelled2.rank).toBeLessThanOrEqual(cancelled.rank);
  });
});
