import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setupFixtureEnv, type TestEnv } from "../helpers/fixture.ts";
import { fakeMiner, ROUND_ONE, ROUND_TITLES, ROUND_TWO } from "../helpers/fake_miner.ts";
import { mineWithModel, normalizeProposal, resolveMiningModel } from "../../src/mine.ts";
import { loadReviewState } from "../../src/review.ts";
import { PROJECT_ROOT } from "../../src/config.ts";

let env: TestEnv;
let policyFile: string;
let outDir: string;

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

beforeAll(() => {
  env = setupFixtureEnv();
  policyFile = path.join(env.home, "policies", "startup_billing.yaml");
  fs.mkdirSync(path.dirname(policyFile), { recursive: true });
  fs.writeFileSync(policyFile, POLICY);
  outDir = path.join(env.home, "mine-out");
  delete process.env.INTENTOS_MINING_MODEL;
});
afterAll(() => env.cleanup());

describe("intentos mine — the independent miner runs the skill with another model through the same checks as propose", () => {
  it("prompts with the skill and the evidence digest, checks round one, sends the rejections back to the same thread, and records the author", async () => {
    const engine = fakeMiner([() => ROUND_ONE, () => ROUND_TWO], "other-model");
    const lines: string[] = [];
    const r = await mineWithModel(env.repo, { engine, model: "other-model", policyFile, outDir }, (l) => lines.push(l));
    expect(r.model).toBe("other-model");
    expect(r.engine).toBe("fake-miner");
    expect(r.thread_id).toBe("thread-fake-1");
    expect(r.rounds.map((x) => [x.round, x.proposed, x.accepted, x.rejected])).toEqual([
      [1, 4, 2, 2],
      [2, 1, 1, 0],
    ]);
    expect(r.accepted.map((a) => [a.id, a.verified])).toEqual([
      ["CAND-001", "lifted"],
      ["CAND-002", "none"],
      ["CAND-003", "lifted"],
    ]);
    expect(r.rejected.map((x) => x.title)).toEqual(["Quotes carry a currency"]);
    expect(r.candidates.map((c) => c.title)).toEqual(ROUND_TITLES);
    expect(lines).toEqual([expect.stringMatching(/^evidence digest: \d+ tests, \d+ commits, \d+ document sentences at [0-9a-f]{7}; asking other-model to mine the rules \(round 1 of at most 2\)/), "round 1: 4 candidate(s) from other-model; checking references and running tests…", "round 1: 2 accepted, 2 rejected; the review list has 2 candidate(s)", "round 2: 1 candidate(s) from other-model; checking references and running tests…", "round 2: 1 accepted, 0 rejected; the review list has 3 candidate(s)", "done: 3 accepted, 1 still rejected after 2 round(s); the review list has 3 candidate(s)"]);

    // The first prompt carries the skill without its frontmatter, the repository path and the raw list; the second resumes the thread with the rejections.
    expect(engine.calls).toHaveLength(2);
    expect(engine.calls[0]!.threadId).toBeNull();
    expect(engine.calls[0]!.prompt).toMatch(/## Where to look, in this order/);
    expect(engine.calls[0]!.prompt).not.toMatch(/^---\nname:/);
    expect(engine.calls[0]!.prompt).toContain(env.repo);
    expect(engine.calls[0]!.prompt).toMatch(/## The evidence digest/);
    expect(engine.calls[0]!.prompt).toMatch(/Repository .* at [0-9a-f]{7} \(python\)/);
    expect(engine.calls[0]!.prompt).toMatch(/## Tests \(\d+;/);
    expect(engine.calls[0]!.prompt).toMatch(/tests\/test_locked_contract\.py::test_cancelled_contract_gets_no_discount/);
    expect(engine.calls[0]!.prompt).toMatch(/## Commits/);
    expect(engine.calls[0]!.prompt).not.toMatch(/\n- CAND-\d+ \[/); // no pre-ranked candidate list: the model reads facts
    expect(engine.calls[1]!.threadId).toBe("thread-fake-1");
    expect(engine.calls[1]!.prompt).toMatch(/2 accepted \(Volume discount applies at the seat threshold; api never imports legacy\), 2 rejected/);
    expect(engine.calls[1]!.prompt).toMatch(/docs\/missing\.md is not a tracked file/);
    expect(engine.calls[1]!.prompt).toMatch(/Quotes carry a currency: .*test/);

    // Files: prompts and answers per round, the result, and the review list with its author.
    for (const f of ["prompt-1.txt", "round-1.json", "prompt-2.txt", "round-2.json", "result.json"]) expect(fs.existsSync(path.join(outDir, "mine", f)), f).toBe(true);
    const s = JSON.parse(fs.readFileSync(path.join(outDir, "suggestions.json"), "utf8"));
    expect(s.authored_by).toBe("codex");
    expect(s.author).toEqual({ via: "side_thread", model: "other-model", engine: "fake-miner", thread_id: "thread-fake-1" });
    expect(s.note).toMatch(/authored by other-model in an independent side thread/);
    const state = await loadReviewState(env.repo, { policyFile, outDir, by: "tester", hiddenTestsRoot: path.join(env.home, "hidden") });
    expect(state.author).toEqual(s.author);
    expect(state.candidates.map((c) => c.id)).toEqual(["CAND-001", "CAND-002", "CAND-003"]);
  }, 120_000);

  it("replays the saved answers through the CLI without Codex; refuses to run without a model; reads the model from the environment", async () => {
    const out2 = path.join(env.home, "mine-replay");
    const res = spawnSync("node", ["--disable-warning=ExperimentalWarning", path.join(PROJECT_ROOT, "bin", "intentos.js"), "--json", "mine", env.repo, "--replay", path.join(outDir, "mine"), "--policy-file", policyFile, "--out", out2], { encoding: "utf8", env: { ...process.env, INTENTOS_HOME: env.home } });
    expect(res.status, res.stderr).toBe(0);
    const r = JSON.parse(res.stdout);
    expect(r.engine).toBe("replay");
    expect(r.model).toBeNull();
    expect(r.rounds).toHaveLength(2);
    expect(r.accepted.map((a: { title: string }) => a.title)).toEqual(ROUND_TITLES);
    expect(res.stderr).toMatch(/\[mine\] round 2: 1 accepted/);
    expect(JSON.parse(fs.readFileSync(path.join(out2, "suggestions.json"), "utf8")).author.engine).toBe("replay");

    await expect(mineWithModel(env.repo, { policyFile, outDir: out2 })).rejects.toThrow(/INTENTOS_MINING_MODEL/);
    await expect(mineWithModel(env.repo, { engine: fakeMiner([() => ROUND_ONE]), policyFile: path.join(env.home, "policies", "nope.yaml"), outDir: out2 })).rejects.toThrow(/onboard the repository first/);
    process.env.INTENTOS_MINING_MODEL = "env-model";
    try {
      expect(resolveMiningModel()).toBe("env-model");
      expect(resolveMiningModel("explicit")).toBe("explicit");
    } finally {
      delete process.env.INTENTOS_MINING_MODEL;
    }
    expect(resolveMiningModel()).toBeNull();
  }, 120_000);

  it("normalizes the structured answer to the shape propose takes", () => {
    expect(normalizeProposal({ title: "t", rationale: "", test: { existing: null, source: null }, rule: { kind: null, paths: [], forbidden_modules: [] }, sources: [] })).toEqual({ title: "t" });
    expect(normalizeProposal({ title: "t", test: { existing: "a::b", source: null }, rule: { kind: "forbidden_import", paths: ["x/**"], forbidden_modules: ["y"] }, sources: [{ path: "d.md", heading: null }, "e.md"], evidence: [{ type: "doc", ref: "d.md:1", excerpt: "x", line: null }] })).toEqual({
      title: "t",
      test: { existing: "a::b" },
      rule: { kind: "forbidden_import", paths: ["x/**"], forbidden_modules: ["y"] },
      sources: [{ path: "d.md" }, "e.md"],
      evidence: [{ type: "doc", ref: "d.md:1", excerpt: "x" }],
    });
  });
});
