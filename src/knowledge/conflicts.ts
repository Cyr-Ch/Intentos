import type { ConstraintHit, DocHit } from "./retrieval.ts";

export interface Conflict {
  kind: "superseded_decision" | "stale_document" | "conflicted_source" | "contradicting_decisions" | "stale_precedent";
  ids: string[];
  summary: string;
  resolution: "do_not_enforce" | "clarify" | "report";
  basis: "deterministic";
}

/**
 * Deterministic conflict detection over retrieved constraints and documents.
 * Supersession, status and pinned-content mismatches are facts recorded at index time;
 * nothing here uses model judgement.
 */
export function detectConflicts(constraints: ConstraintHit[], docs: DocHit[]): Conflict[] {
  const out: Conflict[] = [];
  const byId = new Map(constraints.map((c) => [c.id, c]));
  for (const c of constraints) {
    if (c.kind === "decision" && c.status === "superseded") {
      const by = c.superseded_by ? byId.get(c.superseded_by) : undefined;
      out.push({
        kind: "superseded_decision",
        ids: [c.id, ...(c.superseded_by ? [c.superseded_by] : [])],
        summary: `${c.id} is superseded${by ? ` by ${by.id} ("${by.statement}")` : c.superseded_by ? ` by ${c.superseded_by}` : ""}; its sources must not be enforced as current policy.`,
        resolution: "do_not_enforce",
        basis: "deterministic",
      });
    }
    if (c.status === "conflicted") {
      out.push({
        kind: "conflicted_source",
        ids: [c.id],
        summary: `${c.id} has a source that could not be resolved or whose content changed since the policy pinned it; treat as unverified until a human re-approves.`,
        resolution: "clarify",
        basis: "deterministic",
      });
    }
  }
  for (const d of docs) {
    if (d.adr_status === "superseded" && d.status === "superseded") {
      const linked = constraints.find((c) => c.sources.some((s) => s.path === d.path));
      if (linked && linked.status !== "superseded") {
        out.push({
          kind: "stale_document",
          ids: [d.doc_id, linked.id],
          summary: `${d.path} declares itself superseded but ${linked.id} still treats it as current.`,
          resolution: "clarify",
          basis: "deterministic",
        });
      } else if (!linked) {
        out.push({ kind: "stale_document", ids: [d.doc_id], summary: `${d.path} is a superseded ADR retrieved for this task; do not follow its instructions.`, resolution: "do_not_enforce", basis: "deterministic" });
      }
    }
  }
  // Dedupe by kind+ids
  const seen = new Set<string>();
  return out.filter((c) => {
    const k = `${c.kind}:${c.ids.join(",")}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
