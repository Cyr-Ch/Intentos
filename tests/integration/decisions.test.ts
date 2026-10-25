import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupFixtureEnv, type TestEnv } from "../helpers/fixture.ts";
import { approveDecision, proposeDecision, proposeFromFeedback, supersedeDecision } from "../../src/knowledge/decisions.ts";
import { buildEvidencePack } from "../../src/knowledge/retrieval.ts";
import { compileContract } from "../../src/contracts/compiler.ts";
import { buildOfflineContract } from "../../src/codex/offline.ts";
import { createRun, executeRun } from "../../src/orchestrator/runner.ts";

let env: TestEnv;
beforeAll(() => {
  env = setupFixtureEnv();
});
afterAll(() => env.cleanup());

describe("decision memory", () => {
  it("superseded policy decisions are visible with provenance but never bind", () => {
    const pack = buildEvidencePack(env.store, env.indexed, "Add a new invoice export mode");
    const dec2 = pack.decisions.find((d) => d.id === "DEC-002")!;
    expect(dec2.status).toBe("superseded");
    expect(dec2.binding).toBe(false);
    expect(dec2.sources[0]!.path).toBe("docs/adr-002-legacy-export-adapter.md");
    // A planner trying to cite the superseded decision's evidence as a blocking constraint has nothing to attach it to:
    const c = buildOfflineContract(pack, { route: "implement", fabricateEvidence: false, taskId: "t" });
    c.architecture_constraints.push({ id: "DEC-002", evidence_ids: dec2.evidence_ids, enforcement: "blocking" });
    const out = compileContract(c, pack, env.indexed.policy, { hasTaskTests: false });
    expect(out.route).toBe("reject");
    expect(out.issues.some((i) => i.code === "unknown_architecture_constraint")).toBe(true);
  });

  it("reviewer feedback becomes a PROPOSED decision with model_inference authority until approved", async () => {
    const opts = { mode: "offline" as const, offline: { route: "abstain" as const, patchFile: null, claimSuccess: false, fabricateEvidence: false, repairPatchFile: null } };
    const rs = createRun(env.store, env.indexed, "Fix the bug where cancelled contracts still receive the volume discount", opts);
    await executeRun(env.store, rs, opts);
    const proposed = proposeFromFeedback(env.store, rs.runId, "Promotions must always be expressed as DiscountLine entries", ["promotions"]);
    expect(proposed.status).toBe("proposed");
    expect(proposed.authority).toBe("model_inference");
    let pack = buildEvidencePack(env.store, env.indexed, "Add a 15% promotional discount for eligible enterprise subscriptions");
    const seen = pack.decisions.find((d) => d.id === proposed.id);
    expect(seen).toBeDefined();
    expect(seen!.binding).toBe(false);
    expect(seen!.status).toBe("hypothesized");

    const approved = approveDecision(env.store, proposed.id, "billing-owner");
    expect(approved.authority).toBe("approved_decision");
    expect(approved.effective_revision).toBe(env.indexed.revision);
    pack = buildEvidencePack(env.store, env.indexed, "Add a 15% promotional discount for eligible enterprise subscriptions");
    expect(pack.decisions.find((d) => d.id === proposed.id)!.status).toBe("confirmed");
  });

  it("rejects proposals citing evidence that does not exist at the current revision", () => {
    expect(() => proposeDecision(env.store, env.indexed, { statement: "x", scope: [], evidenceIds: ["EV-nope"], rationale: null, source: "test" })).toThrow(/does not exist/);
  });

  it("supersession requires the successor to be approved and records the chain", () => {
    const a = proposeDecision(env.store, env.indexed, { statement: "Use adapter A", scope: ["exports"], evidenceIds: [], rationale: null, source: "test" });
    const b = proposeDecision(env.store, env.indexed, { statement: "Use service B", scope: ["exports"], evidenceIds: [], rationale: null, source: "test" });
    approveDecision(env.store, a.id, "cto");
    expect(() => supersedeDecision(env.store, a.id, b.id, "cto")).toThrow(/must be approved/);
    approveDecision(env.store, b.id, "cto");
    supersedeDecision(env.store, a.id, b.id, "cto");
    expect(env.store.decision(a.id)!.status).toBe("superseded");
    expect(env.store.decision(b.id)!.supersedes).toBe(a.id);
    expect(() => approveDecision(env.store, a.id, "cto")).toThrow(/superseded/);
  });
});
