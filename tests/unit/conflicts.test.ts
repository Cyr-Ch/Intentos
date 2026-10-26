import { describe, expect, it } from "vitest";
import { detectConflicts } from "../../src/knowledge/conflicts.ts";
import type { ConstraintHit, DocHit } from "../../src/knowledge/retrieval.ts";

const hit = (over: Partial<ConstraintHit>): ConstraintHit => ({ id: "X", kind: "decision", statement: "s", authority: "approved_decision", status: "confirmed", enforcement: "advisory", evidence_ids: [], sources: [], verified_by: [], approved_by: null, applicability: "token_match", binding: false, basis: "trusted_policy", ...over });
const doc = (over: Partial<DocHit>): DocHit => ({ doc_id: "DOC:d", path: "docs/adr-002.md", heading: "h", line_start: 1, line_end: 2, evidence_id: "EV-1", authority: "historical_precedent", status: "superseded", adr_status: "superseded", relevance: 1, excerpt: "", basis: "fact", ...over });

describe("conflict detection", () => {
  it("flags superseded decisions as do_not_enforce with the successor named", () => {
    const out = detectConflicts([hit({ id: "DEC-002", status: "superseded", superseded_by: "DEC-003" }), hit({ id: "DEC-003", statement: "new way" })], []);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("superseded_decision");
    expect(out[0]!.resolution).toBe("do_not_enforce");
    expect(out[0]!.summary).toContain("DEC-003");
  });
  it("flags a document that calls itself superseded while a constraint still treats it as current", () => {
    const linked = hit({ id: "DEC-002", status: "confirmed", sources: [{ path: "docs/adr-002.md", evidence_id: "EV-1", resolved: true, status: "confirmed" }] });
    const out = detectConflicts([linked], [doc({})]);
    expect(out.some((c) => c.kind === "stale_document" && c.resolution === "clarify" && c.ids.includes("DEC-002"))).toBe(true);
  });
  it("flags conflicted sources for human re-approval", () => {
    const out = detectConflicts([hit({ id: "INV-001", kind: "invariant", status: "conflicted" })], []);
    expect(out[0]!.kind).toBe("conflicted_source");
    expect(out[0]!.resolution).toBe("clarify");
  });
});
