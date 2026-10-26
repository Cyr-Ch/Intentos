import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupFixtureEnv, TASK_A, type TestEnv } from "../helpers/fixture.ts";
import { buildEvidencePack, type EvidencePack } from "../../src/knowledge/retrieval.ts";
import { compileContract } from "../../src/contracts/compiler.ts";
import { buildOfflineContract } from "../../src/codex/offline.ts";
import { changeContractJsonSchema, type ChangeContract } from "../../src/contracts/schemas.ts";

let env: TestEnv;
let pack: EvidencePack;
const base = () => buildOfflineContract(pack, { route: "implement", fabricateEvidence: false, taskId: "t" });
const compile = (c: unknown) => compileContract(c, pack, env.indexed.policy, { hasTaskTests: true });

beforeAll(() => {
  env = setupFixtureEnv();
  pack = buildEvidencePack(env.store, env.indexed, TASK_A);
});
afterAll(() => env.cleanup());

describe("contract compiler", () => {
  it("accepts a well-formed contract and hashes it", () => {
    const out = compile(base());
    expect(out.route).toBe("implement");
    expect(out.contract_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(out.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("rejects fabricated evidence ids", () => {
    const c = base();
    c.requirements[0]!.evidence_ids = ["EV-deadbeef00"];
    const out = compile(c);
    expect(out.route).toBe("reject");
    expect(out.issues.some((i) => i.code === "unknown_evidence")).toBe(true);
  });

  it("rejects unknown symbols, invariants and architecture rules", () => {
    const c = base();
    c.reuse_candidates.push({ symbol_id: "SY:app.made.Up", action: "must_reuse", evidence_ids: [], rationale: "x" });
    c.business_invariants.push({ id: "INV-999", evidence_ids: [], enforcement: "blocking" });
    c.architecture_constraints.push({ id: "ARCH-999", evidence_ids: [], enforcement: "advisory" });
    const codes = compile(c).issues.map((i) => i.code);
    expect(codes).toContain("unknown_symbol");
    expect(codes).toContain("unknown_invariant");
    expect(codes).toContain("unknown_architecture_constraint");
  });

  it("rejects a stale base revision", () => {
    const c = base();
    c.base_revision = "0000000000000000000000000000000000000000";
    const out = compile(c);
    expect(out.route).toBe("reject");
    expect(out.issues.some((i) => i.code === "revision_mismatch")).toBe(true);
  });

  it("rejects attempts to make protected paths writable or escape the allowlist", () => {
    for (const bad of ["docs/**", "policies/**", ".intentos/**", "../other/**", "/etc/**", "benchmarks/hidden_tests/**"]) {
      const c = base();
      c.allowed_paths = [bad];
      const out = compile(c);
      expect(out.route, bad).toBe("reject");
    }
    const ok = base();
    ok.allowed_paths = ["app/services/*.py", "tests/**"];
    expect(compile(ok).route).toBe("implement");
  });

  it("rejects commands outside the trusted allowlist", () => {
    const c = base();
    c.verification.push({ id: "VER-X", command_id: "rm_rf", origin: "trusted_config" });
    expect(compile(c).issues.some((i) => i.code === "unknown_command")).toBe(true);
  });

  it("injects applicable trusted constraints and required commands the planner omitted", () => {
    const c = base();
    c.business_invariants = [];
    c.architecture_constraints = [];
    c.verification = [{ id: "VER-001", command_id: "pytest_project", origin: "trusted_config" }];
    const out = compile(c);
    expect(out.route).toBe("implement");
    expect(out.injected.invariants).toEqual(expect.arrayContaining(["INV-001", "INV-003"]));
    expect(out.injected.architecture_constraints).toContain("ARCH-001");
    expect(out.injected.verification).toEqual(expect.arrayContaining(["pytest_invariants", "architecture_rules", "scope_check", "pytest_hidden_task"]));
    expect(out.contract!.protected_paths).toContain("docs/**");
  });

  it("ignores a planner downgrade of a policy-blocking constraint", () => {
    const c = base();
    c.business_invariants = c.business_invariants.map((b) => ({ ...b, enforcement: "advisory" as const }));
    const out = compile(c);
    expect(out.contract!.business_invariants.every((b) => b.enforcement === "blocking")).toBe(true);
    expect(out.issues.some((i) => i.code === "downgrade_rejected")).toBe(true);
  });

  it("routes implement with blocking open questions to clarify", () => {
    const c = base();
    c.open_questions = [{ id: "Q1", question: "Does the promo stack with volume discounts?", blocking: true }];
    const out = compile(c);
    expect(out.route).toBe("clarify");
    expect(out.contract!.decision).toBe("clarify");
  });

  it("downgrades confirmed requirements without evidence", () => {
    const c = base();
    c.requirements = [{ id: "REQ-1", statement: "x", evidence_ids: [], certainty: "confirmed" }];
    const out = compile(c);
    expect(out.contract!.requirements[0]!.certainty).toBe("hypothesized");
  });

  it("rejects schema violations", () => {
    expect(compile({ schema_version: "2.0" }).route).toBe("reject");
    expect(compile("not json").route).toBe("reject");
  });

  it("emits a strict JSON schema for structured output", () => {
    const schema = changeContractJsonSchema() as { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
  });
});

describe("blocking constraints need trusted authority", () => {
  it("a conflicted invariant cannot be blocking", () => {
    const c = base();
    const conflicted: EvidencePack = structuredClone(pack);
    conflicted.invariants[0]!.status = "conflicted";
    conflicted.invariants[0]!.binding = false;
    const out = compileContract(c, conflicted, env.indexed.policy, { hasTaskTests: true });
    expect(out.route).toBe("reject");
    expect(out.issues.some((i) => i.code === "unconfirmed_blocking")).toBe(true);
  });
  it("an advisory reference to a conflicted constraint routes implement to clarify", () => {
    const c = base();
    const conflicted: EvidencePack = structuredClone(pack);
    conflicted.invariants[0]!.status = "conflicted";
    conflicted.invariants[0]!.binding = false;
    c.business_invariants = c.business_invariants.map((b) => (b.id === conflicted.invariants[0]!.id ? { ...b, enforcement: "advisory" as const } : b));
    const out = compileContract(c, conflicted, env.indexed.policy, { hasTaskTests: true });
    expect(out.route).toBe("clarify");
    expect(out.issues.some((i) => i.code === "conflicted_constraints")).toBe(true);
  });
  it("a model-inferred rule cannot be blocking", () => {
    const c: ChangeContract = base();
    const inferred: EvidencePack = structuredClone(pack);
    inferred.architecture_rules[0]!.authority = "model_inference";
    inferred.architecture_rules[0]!.binding = false;
    const out = compileContract(c, inferred, env.indexed.policy, { hasTaskTests: true });
    expect(out.issues.some((i) => i.code === "untrusted_blocking")).toBe(true);
  });
});
