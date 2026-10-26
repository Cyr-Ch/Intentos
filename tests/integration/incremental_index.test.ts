import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gitHead, setupFixtureEnv, TASK_A, type TestEnv } from "../helpers/fixture.ts";
import { KnowledgeStore } from "../../src/knowledge/storage.ts";
import { indexRepository, type ConstraintAttributes } from "../../src/knowledge/indexer.ts";
import { loadIndexedRepo } from "../../src/knowledge/repo.ts";
import { buildEvidencePack } from "../../src/knowledge/retrieval.ts";
import { compileContract } from "../../src/contracts/compiler.ts";
import { buildOfflineContract } from "../../src/codex/offline.ts";

let env: TestEnv;
beforeAll(() => {
  env = setupFixtureEnv();
});
afterAll(() => env.cleanup());

function gitRun(repo: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function commitAll(repo: string, message: string): string {
  gitRun(repo, ["add", "-A"]);
  gitRun(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", message]);
  return gitHead(repo);
}

/** Order-independent view of a revision's graph, as the brief's equivalence criterion defines it. */
function graphSets(store: KnowledgeStore, repoId: string, revision: string) {
  return {
    nodes: store
      .nodes(repoId, revision)
      .map((n) => JSON.stringify([n.id, n.kind, n.qualified_name, n.attributes_json]))
      .sort(),
    edges: store
      .edges(repoId, revision)
      .map((e) => JSON.stringify([e.from_node, e.relation, e.to_node, e.confidence]))
      .sort(),
    evidence: store
      .evidence(repoId, revision)
      .map((e) => JSON.stringify([e.id, e.source_type, e.path, e.line_start, e.line_end, e.authority, e.status, e.content_hash]))
      .sort(),
  };
}

function constraint(store: KnowledgeStore, repoId: string, revision: string, id: string): ConstraintAttributes {
  const row = store.node(repoId, revision, id);
  if (!row) throw new Error(`node ${id} missing at ${revision.slice(0, 7)}`);
  return JSON.parse(row.attributes_json) as ConstraintAttributes;
}

describe("incremental re-indexing", () => {
  it("re-extracts only the changed file and produces the same graph as a full index", () => {
    const repoId = env.indexed.repo.id;
    const first = env.indexed.revision;

    // A no-op commit: nothing to re-extract, everything carried.
    const noop = commitAll(env.repo, "no-op");
    expect(noop).not.toBe(first);
    const carriedAll = indexRepository(env.store, env.repo);
    expect(carriedAll.mode).toBe("incremental");
    expect(carriedAll.previous_revision).toBe(first);
    expect(carriedAll.changed_files).toEqual([]);
    expect(carriedAll.deleted_files).toEqual([]);
    expect(carriedAll.carried_files.length).toBeGreaterThan(25);
    expect(carriedAll.limitations.some((l) => /^incremental: \d+ file\(s\) carried from/.test(l))).toBe(true);

    fs.appendFileSync(path.join(env.repo, "app/services/pricing.py"), "\n# incremental-index test marker\n");
    const head = commitAll(env.repo, "touch pricing");
    const summary = indexRepository(env.store, env.repo);
    expect(summary.mode).toBe("incremental");
    expect(summary.head_sha).toBe(head);
    expect(summary.previous_revision).toBe(noop);
    expect(summary.changed_files).toEqual(["app/services/pricing.py"]);
    expect(summary.deleted_files).toEqual([]);
    expect(summary.carried_files).not.toContain("app/services/pricing.py");
    expect(summary.carried_files.length).toBe(carriedAll.carried_files.length - 1);
    expect(summary.cache_file && fs.existsSync(summary.cache_file)).toBe(true);
    expect(env.store.getRepository(repoId)!.head_sha).toBe(head);

    const reference = new KnowledgeStore(path.join(env.home, "full-reference.db"));
    try {
      const full = indexRepository(reference, env.repo);
      expect(full.mode).toBe("full");
      expect(full.head_sha).toBe(head);
      const a = graphSets(env.store, repoId, head);
      const b = graphSets(reference, repoId, head);
      expect(a.nodes.length).toBeGreaterThan(100);
      expect(a.nodes).toEqual(b.nodes);
      expect(a.edges).toEqual(b.edges);
      expect(a.evidence).toEqual(b.evidence);
      expect(summary.counts).toEqual(full.counts);
    } finally {
      reference.close();
    }
  });

  it("marks a policy-bound section whose content changed as conflicted until it is re-approved", () => {
    const repoId = env.indexed.repo.id;
    const doc = path.join(env.repo, "docs/business-policy.md");
    const original = fs.readFileSync(doc, "utf8");
    const edited = original.replace(
      "Locked and cancelled contracts never receive discounts or promotions of any\nkind.",
      "Locked contracts receive a loyalty promotion at renewal.",
    );
    expect(edited).not.toBe(original);
    fs.writeFileSync(doc, edited);
    const head = commitAll(env.repo, "relax the locked-contract policy text");

    const summary = indexRepository(env.store, env.repo);
    expect(summary.mode).toBe("incremental");
    expect(summary.changed_files).toEqual(["docs/business-policy.md"]);
    const flagged = summary.unresolved_sources.find((u) => u.owner === "INV-001");
    expect(flagged?.heading).toBe("Locked contracts");
    expect(flagged?.reason).toMatch(/^section content changed since [0-9a-f]{7}; re-approve or pin content_sha256$/);

    const inv = constraint(env.store, repoId, head, "INV-001");
    expect(inv.status).toBe("conflicted");
    const src = inv.sources[0]!;
    expect(src.resolved).toBe(true);
    expect(src.status).toBe("conflicted");
    expect(src.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(src.approved_content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(src.content_hash).not.toBe(src.approved_content_hash);
    const ev = env.store.evidenceById(repoId, head, src.evidence_id!)!;
    expect(ev.status).toBe("conflicted");
    expect(ev.authority).toBe("approved_policy");
    // Unrelated constraints are untouched.
    expect(constraint(env.store, repoId, head, "INV-002").status).toBe("confirmed");

    // The planner cannot rely on it, and the compiler rejects any attempt to make it blocking.
    const indexed = loadIndexedRepo(env.store, env.repo);
    const pack = buildEvidencePack(env.store, indexed, TASK_A);
    const hit = pack.invariants.find((i) => i.id === "INV-001")!;
    expect(hit.status).toBe("conflicted");
    expect(hit.binding).toBe(false);
    const contract = buildOfflineContract(pack, { route: "implement", fabricateEvidence: false, taskId: "t-incremental" });
    expect(contract.business_invariants.map((b) => b.id)).not.toContain("INV-001");
    contract.business_invariants.push({ id: "INV-001", evidence_ids: [...hit.evidence_ids], enforcement: "blocking" });
    const out = compileContract(contract, pack, indexed.policy, { hasTaskTests: true });
    expect(out.route).toBe("reject");
    expect(out.issues.some((i) => i.severity === "error" && i.code === "unconfirmed_blocking" && i.message.includes("INV-001"))).toBe(true);

    // The conflict is not silently cleared by the next revision.
    fs.appendFileSync(path.join(env.repo, "README.md"), "\nUnrelated note.\n");
    const head2 = commitAll(env.repo, "unrelated change");
    expect(indexRepository(env.store, env.repo).mode).toBe("incremental");
    const still = constraint(env.store, repoId, head2, "INV-001");
    expect(still.status).toBe("conflicted");
    expect(still.sources[0]!.approved_content_hash).toBe(src.approved_content_hash);

    // Editing the section back to the approved text restores confirmation.
    fs.writeFileSync(doc, original);
    const head3 = commitAll(env.repo, "restore the policy text");
    const restored = indexRepository(env.store, env.repo);
    expect(restored.unresolved_sources.some((u) => u.owner === "INV-001")).toBe(false);
    expect(constraint(env.store, repoId, head3, "INV-001").status).toBe("confirmed");
    expect(buildEvidencePack(env.store, loadIndexedRepo(env.store, env.repo), TASK_A).invariants.find((i) => i.id === "INV-001")!.binding).toBe(true);
  });

  it("never reuses a cache written by a different extractor version", () => {
    const before = indexRepository(env.store, env.repo, { full: true });
    expect(before.cache_file).not.toBeNull();
    const cache = JSON.parse(fs.readFileSync(before.cache_file!, "utf8")) as { extractor: string };
    expect(cache.extractor).toMatch(/^[0-9a-f]{16}$/);
    fs.writeFileSync(before.cache_file!, JSON.stringify({ ...cache, extractor: "0000000000000000" }));
    commitAll(env.repo, "no-op after extractor change");
    const after = indexRepository(env.store, env.repo);
    expect(after.mode).toBe("full");
    expect(after.limitations.some((l) => /different extractor version/.test(l))).toBe(true);
    commitAll(env.repo, "no-op with a fresh cache");
    expect(indexRepository(env.store, env.repo).mode).toBe("incremental");
  });

  it("falls back to a full index on --full or a dirty tree, and drops nodes of deleted files", () => {
    const repoId = env.indexed.repo.id;
    const full = indexRepository(env.store, env.repo, { full: true });
    expect(full.mode).toBe("full");
    expect(full.carried_files).toEqual([]);
    expect(full.changed_files).toContain("app/services/pricing.py");
    expect(full.limitations.some((l) => /full re-index: requested with --full/.test(l))).toBe(true);

    fs.appendFileSync(path.join(env.repo, "app/services/audit.py"), "\n# uncommitted\n");
    const dirty = indexRepository(env.store, env.repo);
    expect(dirty.mode).toBe("full");
    expect(dirty.dirty).toBe(true);
    expect(dirty.cache_file).toBeNull();
    expect(dirty.limitations.some((l) => /full re-index: working tree has uncommitted changes/.test(l))).toBe(true);
    gitRun(env.repo, ["checkout", "--", "app/services/audit.py"]);

    const before = gitHead(env.repo);
    expect(env.store.node(repoId, before, "MOD:app.legacy.export_adapter")).not.toBeNull();
    fs.rmSync(path.join(env.repo, "app/legacy/export_adapter.py"));
    const head = commitAll(env.repo, "remove the legacy export adapter");
    const summary = indexRepository(env.store, env.repo);
    expect(summary.mode).toBe("incremental");
    expect(summary.changed_files).toEqual([]);
    expect(summary.deleted_files).toEqual(["app/legacy/export_adapter.py"]);
    expect(env.store.node(repoId, head, "MOD:app.legacy.export_adapter")).toBeNull();
    const legacy = (id: string) => id.startsWith("MOD:app.legacy.export_adapter") || id.startsWith("SY:app.legacy.export_adapter");
    expect(env.store.nodes(repoId, head).some((n) => legacy(n.id))).toBe(false);
    expect(env.store.edges(repoId, head).some((e) => legacy(e.from_node) || legacy(e.to_node))).toBe(false);
    expect(env.store.evidence(repoId, head).some((e) => e.path === "app/legacy/export_adapter.py")).toBe(false);
    expect(env.store.node(repoId, head, "MOD:app.legacy")).not.toBeNull();

    const reference = new KnowledgeStore(path.join(env.home, "full-reference-2.db"));
    try {
      indexRepository(reference, env.repo);
      const a = graphSets(env.store, repoId, head);
      const b = graphSets(reference, repoId, head);
      expect(a.nodes).toEqual(b.nodes);
      expect(a.edges).toEqual(b.edges);
      expect(a.evidence).toEqual(b.evidence);
    } finally {
      reference.close();
    }
  });
});
