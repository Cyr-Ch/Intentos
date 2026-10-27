/** Policies without a person in the loop: every kept candidate with a test lands in the policy and the hidden tests. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setupFixtureEnv, type TestEnv } from "../helpers/fixture.ts";
import { suggestPolicy } from "../../src/suggest.ts";
import { autoApprove, autoApprover, loadReviewState } from "../../src/review.ts";
import { loadPolicyFile } from "../../src/knowledge/policy.ts";

let env: TestEnv;
let policyFile: string;
let hiddenRoot: string;
const outDir = () => path.join(env.home, "auto-out");

const MINIMAL_POLICY = `schema_version: "1.0"
policy_id: startup_billing
applies_to: { project_name: startup_billing }
default_allowed_paths: ["app/**", "tests/**"]
protected_paths: ["docs/**"]
commands:
  pytest_project: { description: suite, track: functional, argv: ["{python}", "-m", "pytest", "-q", "--junit-xml={junit}"] }
  scope_check: { description: scope, track: scope, builtin: scope_check }
invariants: []
architecture_rules: []
decisions: []
`;

beforeAll(async () => {
  env = setupFixtureEnv();
  await suggestPolicy(env.repo, { writeAdrs: false, withCodex: false, outDir: outDir() });
  policyFile = path.join(env.home, "policies", "startup_billing.yaml");
  fs.mkdirSync(path.dirname(policyFile), { recursive: true });
  fs.writeFileSync(policyFile, MINIMAL_POLICY);
  hiddenRoot = path.join(env.home, "hidden_tests");
});
afterAll(() => env.cleanup());

describe("automatic approval", () => {
  it("approves every pending candidate that has a test, leaves testless invariants pending, records the approver and re-indexes", async () => {
    const state = await loadReviewState(env.repo, { outDir: outDir(), policyFile, hiddenTestsRoot: hiddenRoot, by: autoApprover({ via: "side_thread", model: "other-model" }), store: env.store });
    const before = state.candidates.length;
    expect(before).toBeGreaterThan(0);
    const r = autoApprove(state);
    expect(r.by).toBe("auto:other-model");
    expect(r.approved.length + r.without_test.length + r.failed.length).toBe(before);
    expect(r.approved.length).toBeGreaterThan(0);
    const policy = loadPolicyFile(policyFile);
    const rules = [...policy.invariants, ...policy.architecture_rules, ...policy.decisions];
    expect(rules).toHaveLength(r.approved.length);
    expect(rules.every((x) => (x as { approved_by?: string }).approved_by === "auto:other-model")).toBe(true);
    for (const inv of policy.invariants) {
      expect(inv.verified_by.length).toBeGreaterThan(0);
      for (const t of inv.verified_by) expect(fs.existsSync(path.join(process.cwd(), t))).toBe(true);
    }
    for (const w of r.without_test) expect(state.candidates.find((c) => c.id === w.id)!.kind).toBe("invariant");
    expect(r.finish.accepted).toBe(r.approved.length);
    expect(r.finish.skipped).toBe(r.without_test.length);
    expect(r.finish.index?.policy_id).toBe("startup_billing");
    // Running it again changes nothing: everything is decided.
    const again = autoApprove(state);
    expect(again.approved).toHaveLength(0);
    expect(loadPolicyFile(policyFile).invariants).toHaveLength(policy.invariants.length);
  });

  it("names the approver after who mined the list", () => {
    expect(autoApprover(null)).toBe("auto:miner");
    expect(autoApprover({ via: "host", model: null })).toBe("auto:codex");
    expect(autoApprover({ via: "side_thread", model: "gpt-x" })).toBe("auto:gpt-x");
  });
});
