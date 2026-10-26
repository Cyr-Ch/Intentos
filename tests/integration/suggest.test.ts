import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { setupFixtureEnv, type TestEnv } from "../helpers/fixture.ts";
import { buildAdrSynthesisPrompt, suggestPolicy, type Candidate } from "../../src/suggest.ts";
import type { CodingEngine, PlanRequest } from "../../src/codex/adapter.ts";
import { PROJECT_ROOT } from "../../src/config.ts";

let env: TestEnv;
beforeAll(() => {
  env = setupFixtureEnv();
});
afterAll(() => env.cleanup());

const byTitle = (cands: Candidate[], needle: string): Candidate => {
  const hit = cands.find((c) => c.title.toLowerCase().includes(needle.toLowerCase()));
  if (!hit) throw new Error(`no candidate titled like ${needle}: ${cands.map((c) => c.title).join(" | ")}`);
  return hit;
};

describe("intentos suggest", () => {
  it("mines the fixture into evidence-backed candidates, review files and ADR drafts without approving anything", async () => {
    const adrDir = path.join(env.home, "adr-drafts");
    fs.mkdirSync(adrDir, { recursive: true });
    fs.writeFileSync(path.join(adrDir, "ADR-0007-existing.md"), "# ADR-0007: existing\n");
    const r = await suggestPolicy(env.repo, { writeAdrs: true, adrDir, withCodex: false, outDir: path.join(env.home, "suggest-out") });
    expect(r.policy_id).toBe("startup_billing");
    expect(r.candidates.length).toBeGreaterThan(10);
    expect(r.counts.decision).toBe(3);

    // the regression fix in history and its test merge into one high-confidence invariant with a hidden-test draft
    const cancelled = byTitle(r.candidates, "Cancelled contract gets no discount");
    expect(cancelled.kind).toBe("invariant");
    expect(cancelled.confidence).toBe("high");
    expect(cancelled.evidence.map((e) => e.type)).toEqual(expect.arrayContaining(["test", "commit"]));
    expect(cancelled.evidence.some((e) => e.type === "commit" && /cancelled contracts received volume discounts/i.test(e.excerpt))).toBe(true);
    expect(cancelled.suggested_hidden_test!.source).toContain("def test_cancelled_contract_gets_no_discount");
    expect(cancelled.policy_block).toMatchObject({ id: "INV-TODO", approved_by: "TODO", enforcement: "blocking" });
    expect((cancelled.policy_block.verified_by as string[])[0]).toMatch(/^benchmarks\/hidden_tests\/startup_billing\/invariants\/test_inv_TODO_/);

    // the ADRs in the repository become decisions with their lineage
    const decisions = r.candidates.filter((c) => c.kind === "decision" && c.evidence[0]!.type === "adr");
    expect(decisions.map((c) => c.status).sort()).toEqual(["approved", "approved", "superseded"]);
    expect(byTitle(decisions, "ADR-003").supersedes).toMatch(/adr-002/i);

    // the layering that exists today is proposed as rules in the direction that preserves it
    const domainRule = byTitle(r.candidates, "app/domain must not import app/services");
    expect(domainRule.rule).toEqual({ kind: "forbidden_import", paths: ["app/domain/**"], forbidden_modules: ["app.services"] });
    expect(domainRule.evidence.every((e) => e.type === "import")).toBe(true);
    expect(r.candidates.some((c) => c.title === "app/api must not import app/services")).toBe(false);
    const frozen = r.candidates.filter((c) => c.kind === "frozen_paths");
    expect(frozen.map((c) => c.rule)).toEqual([{ kind: "frozen_paths", paths: ["app/legacy/**"] }]);

    // must/never sentences keep their document source so the policy can cite it
    const locked = byTitle(r.candidates, "Locked contracts");
    expect(locked.sources).toEqual([{ path: "docs/business-policy.md", heading: "Locked contracts" }]);
    expect(locked.statement).toMatch(/never receive discounts/);

    // review files
    expect(fs.existsSync(r.files.json)).toBe(true);
    const md = fs.readFileSync(r.files.markdown, "utf8");
    expect(md).toContain("# Policy suggestions for startup_billing");
    expect(md).toContain("proposals with no authority");
    expect(md).toContain(`### ${cancelled.id} · invariant · Cancelled contract gets no discount`);
    expect(md).toContain("def test_cancelled_contract_gets_no_discount");
    const yaml = YAML.parse(fs.readFileSync(r.files.yaml, "utf8")) as { invariants: Array<Record<string, unknown>>; architecture_rules: Array<Record<string, unknown>>; decisions: Array<Record<string, unknown>> };
    expect(yaml.invariants.length).toBe(r.counts.invariant);
    expect(yaml.architecture_rules.length).toBe(r.counts.architecture_rule! + r.counts.frozen_paths!);
    expect(yaml.decisions.length).toBe(3);
    expect(yaml.invariants.every((b) => b.approved_by === "TODO" && b.id === "INV-TODO")).toBe(true);

    // ADR drafts only for candidates without a document of their own, numbered after the existing ADR, all Proposed
    expect(r.adrs.length).toBeGreaterThan(0);
    expect(r.adrs[0]!.number).toBe(8);
    expect(r.adrs.every((a) => a.synthesized_by === "deterministic")).toBe(true);
    for (const a of r.adrs) {
      expect(a.file!.startsWith(adrDir)).toBe(true);
      const text = fs.readFileSync(a.file!, "utf8");
      expect(text).toContain("Status: Proposed");
      expect(text).toContain(`Derived-from: ${a.candidate_ids.join(", ")}`);
      const cands = a.candidate_ids.map((id) => r.candidates.find((c) => c.id === id)!);
      expect(cands.every((c) => !c.evidence.some((e) => e.type === "doc" || e.type === "adr"))).toBe(true);
    }
    expect(r.adrs.some((a) => a.candidate_ids.includes(cancelled.id))).toBe(true);
    expect(r.adrs.some((a) => a.candidate_ids.includes(locked.id))).toBe(false);
    expect(r.codex.used).toBe(false);
    expect(r.next_steps.join("\n")).toMatch(/approved_by/);
  });

  it("validates Codex-synthesised ADRs against the mined evidence and falls back for the rest", async () => {
    let prompt = "";
    let cwd = "";
    const fake: CodingEngine = {
      name: "fake-synth",
      simulated: false,
      async plan(req: PlanRequest) {
        prompt = req.prompt;
        cwd = req.cwd;
        const ids = [...req.prompt.matchAll(/^### (CAND-\d{3})/gm)].map((m) => m[1]!);
        return {
          text: JSON.stringify({
            adrs: [
              { candidate_ids: [ids[0], ids[1]], title: "Discounts never reach locked or cancelled contracts", context: "Two tests and a fix commit show it.", decision: "Locked and cancelled contracts receive no discount lines.", consequences: "Eligibility stays in DiscountPolicy." },
              { candidate_ids: ["CAND-999"], title: "Fabricated", context: "made up", decision: "made up", consequences: "made up" },
            ],
          }),
          usage: { input_tokens: 10, output_tokens: 5 },
          threadId: "t-synth",
          simulated: false,
          engine: "fake-synth",
          model: "fake-model",
          items: [],
        };
      },
      async implement() {
        throw new Error("not used");
      },
    };
    const adrDir = path.join(env.home, "adr-codex");
    const r = await suggestPolicy(env.repo, { writeAdrs: true, adrDir, withCodex: true, engine: fake, outDir: path.join(env.home, "suggest-codex") });
    expect(cwd).toBe(env.repo);
    expect(prompt).toMatch(/Use ONLY the evidence listed below/);
    expect(r.codex).toMatchObject({ used: true, model: "fake-model", dropped: 1 });
    const synthesized = r.adrs.filter((a) => a.synthesized_by === "codex");
    expect(synthesized).toHaveLength(1);
    expect(synthesized[0]!.candidate_ids).toHaveLength(2);
    const text = fs.readFileSync(synthesized[0]!.file!, "utf8");
    expect(text).toContain("# ADR-0001: Discounts never reach locked or cancelled contracts");
    expect(text).toContain("Status: Proposed");
    expect(text).toContain("text synthesised by Codex");
    expect(text).toContain("Locked and cancelled contracts receive no discount lines.");
    expect(text).not.toContain("made up");
    expect(r.adrs.filter((a) => a.synthesized_by === "deterministic").length).toBe(r.adrs.length - 1); // uncovered candidates still get deterministic drafts
    expect(buildAdrSynthesisPrompt(r.candidates.slice(0, 2))).toContain(r.candidates[0]!.id);
  });

  it("filters by confidence and is wired into the CLI", async () => {
    const r = await suggestPolicy(env.repo, { writeAdrs: false, withCodex: false, minConfidence: "high", outDir: path.join(env.home, "suggest-high") });
    expect(r.candidates.every((c) => c.confidence === "high")).toBe(true);
    expect(r.adr_dir).toBeNull();
    expect(r.adrs.every((a) => a.file === null)).toBe(true);
    const out = path.join(env.home, "suggest-cli");
    const res = spawnSync("node", ["--disable-warning=ExperimentalWarning", path.join(PROJECT_ROOT, "bin", "intentos.js"), "--json", "suggest", env.repo, "--out", out, "--min-confidence", "medium"], { encoding: "utf8", env: { ...process.env, INTENTOS_HOME: env.home } });
    expect(res.status, res.stderr).toBe(0);
    const parsed = JSON.parse(res.stdout) as { policy_id: string; candidates: Candidate[]; files: { markdown: string } };
    expect(parsed.policy_id).toBe("startup_billing");
    expect(parsed.candidates.every((c) => c.confidence !== "low")).toBe(true);
    expect(fs.existsSync(parsed.files.markdown)).toBe(true);
  });
});
