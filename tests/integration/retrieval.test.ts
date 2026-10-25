import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupFixtureEnv, TASK_A, type TestEnv } from "../helpers/fixture.ts";
import { buildEvidencePack } from "../../src/knowledge/retrieval.ts";
import fs from "node:fs";
import path from "node:path";

let env: TestEnv;
beforeAll(() => {
  env = setupFixtureEnv();
});
afterAll(() => env.cleanup());

describe("index", () => {
  it("stores nodes, edges and evidence bound to the actual HEAD sha", () => {
    const { store, indexed } = env;
    expect(indexed.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(store.getRepository(indexed.repo.id)!.head_sha).toBe(indexed.revision);
    const nodes = store.nodes(indexed.repo.id, indexed.revision);
    expect(nodes.filter((n) => n.kind === "symbol").length).toBeGreaterThan(50);
    expect(nodes.filter((n) => n.kind === "invariant").map((n) => n.id).sort()).toEqual(["INV-001", "INV-002", "INV-003"]);
    const edges = store.edges(indexed.repo.id, indexed.revision);
    expect(edges.some((e) => e.relation === "SUPERSEDES" && e.from_node === "DEC-003" && e.to_node === "DEC-002")).toBe(true);
  });

  it("evidence spans point at real lines of real files", () => {
    const { store, indexed } = env;
    const pricing = store.node(indexed.repo.id, indexed.revision, "SY:app.services.pricing.PricingService")!;
    const attrs = JSON.parse(pricing.attributes_json) as { path: string; line_start: number; line_end: number; evidence_id: string };
    const ev = store.evidenceById(indexed.repo.id, indexed.revision, attrs.evidence_id)!;
    const lines = fs.readFileSync(path.join(env.repo, ev.path!), "utf8").split("\n");
    expect(lines[ev.line_start! - 1]).toMatch(/^class PricingService/);
    expect(ev.source_ref).toBe(indexed.revision);
    expect(ev.authority).toBe("current_implementation");
  });

  it("binds policy invariants to doc sections with approved authority", () => {
    const { store, indexed } = env;
    const inv = JSON.parse(store.node(indexed.repo.id, indexed.revision, "INV-001")!.attributes_json) as { sources: Array<{ resolved: boolean; evidence_id: string }>; status: string };
    expect(inv.status).toBe("confirmed");
    expect(inv.sources[0]!.resolved).toBe(true);
    const ev = store.evidenceById(indexed.repo.id, indexed.revision, inv.sources[0]!.evidence_id)!;
    expect(ev.authority).toBe("approved_policy");
    expect(ev.path).toBe("docs/business-policy.md");
  });

  it("marks superseded ADR sections as superseded evidence", () => {
    const { store, indexed } = env;
    const evs = store.evidence(indexed.repo.id, indexed.revision).filter((e) => e.path === "docs/adr-002-legacy-export-adapter.md");
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.every((e) => e.status === "superseded")).toBe(true);
  });
});

describe("explain", () => {
  it("finds the reusable pricing abstractions for the promotion task with locations", () => {
    const pack = buildEvidencePack(env.store, env.indexed, TASK_A);
    const names = pack.reusable_symbols.map((s) => s.qualified_name);
    expect(names).toContain("app.services.discounts.DiscountPolicy");
    expect(names).toContain("app.services.pricing.PricingService");
    const policy = pack.reusable_symbols.find((s) => s.qualified_name === "app.services.discounts.DiscountPolicy")!;
    expect(policy.path).toBe("app/services/discounts.py");
    expect(policy.reuse_recommendation).toBe("required");
    expect(policy.recommendation_basis).toContain("DEC-001");
    expect(pack.invariants.map((i) => i.id)).toEqual(expect.arrayContaining(["INV-001", "INV-003"]));
    expect(pack.invariants.every((i) => i.binding)).toBe(true);
    expect(pack.docs.some((d) => d.heading === "Promotions" && d.authority === "approved_policy")).toBe(true);
    expect(pack.tests.some((t) => t.name === "test_locked_contract_gets_no_discount")).toBe(true);
    expect(Object.keys(pack.evidence_index).length).toBeGreaterThan(10);
  });

  it("surfaces the superseded export decision as a conflict, not an instruction", () => {
    const pack = buildEvidencePack(env.store, env.indexed, "Add a new invoice export mode");
    const dec2 = pack.decisions.find((d) => d.id === "DEC-002");
    const dec3 = pack.decisions.find((d) => d.id === "DEC-003");
    expect(dec2?.status).toBe("superseded");
    expect(dec2?.superseded_by).toBe("DEC-003");
    expect(dec3?.status).toBe("confirmed");
    expect(pack.conflicts.some((c) => c.kind === "superseded_decision" && c.ids.includes("DEC-002") && c.resolution === "do_not_enforce")).toBe(true);
    expect(pack.reusable_symbols.map((s) => s.qualified_name)).toContain("app.services.exports.InvoiceExportService");
    expect(pack.architecture_rules.find((r) => r.id === "ARCH-004")?.binding).toBe(true);
  });

  it("finds the regression test proving the already-fixed bug", () => {
    const pack = buildEvidencePack(env.store, env.indexed, "Fix the bug where cancelled contracts still receive the volume discount");
    expect(pack.tests.some((t) => t.name === "test_cancelled_contract_gets_no_discount")).toBe(true);
    expect(pack.history.some((h) => /cancelled contracts received volume discounts/i.test(h.subject))).toBe(true);
  });

  it("scopes the entitlement invariant to the upgrade task", () => {
    const pack = buildEvidencePack(env.store, env.indexed, "Add immediate subscription upgrades");
    expect(pack.invariants.map((i) => i.id)).toContain("INV-002");
    expect(pack.reusable_symbols.map((s) => s.qualified_name)).toContain("app.services.subscriptions.SubscriptionService");
    expect(pack.impact.probable_files.map((f) => f.path)).toContain("app/services/subscriptions.py");
    expect(pack.impact.method).toBe("static_imports_only");
  });
});
