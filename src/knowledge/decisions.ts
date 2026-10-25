import type { DecisionRow, KnowledgeStore } from "./storage.ts";
import type { IndexedRepo } from "./repo.ts";
import { nowIso, shortHash } from "../util/ids.ts";

/**
 * Decision memory. Proposed decisions carry `model_inference` authority and can never be
 * blocking; only a human approval (`approveDecision`) upgrades them to `approved_decision`.
 */
export function proposeDecision(store: KnowledgeStore, indexed: IndexedRepo, input: { statement: string; scope: string[]; evidenceIds: string[]; rationale: string | null; source: string }): DecisionRow {
  for (const id of input.evidenceIds) {
    if (!store.evidenceById(indexed.repo.id, indexed.revision, id)) throw new Error(`evidence ${id} does not exist at revision ${indexed.revision.slice(0, 10)}`);
  }
  const row: DecisionRow = {
    id: `DEC-P-${shortHash(`${indexed.repo.id}|${input.statement}|${nowIso()}`, 8)}`,
    repo_id: indexed.repo.id,
    statement: input.statement,
    scope_json: JSON.stringify(input.scope),
    status: "proposed",
    evidence_ids_json: JSON.stringify(input.evidenceIds),
    approved_by: null,
    effective_revision: null,
    supersedes: null,
    authority: "model_inference",
    created_at: nowIso(),
    rationale: input.rationale ? `${input.rationale} [source: ${input.source}]` : `[source: ${input.source}]`,
  };
  store.upsertDecision(row);
  return row;
}

export function approveDecision(store: KnowledgeStore, id: string, approvedBy: string): DecisionRow {
  const row = store.decision(id);
  if (!row) throw new Error(`decision ${id} not found`);
  if (row.status === "superseded") throw new Error(`decision ${id} is superseded and cannot be approved`);
  if (!approvedBy.trim()) throw new Error("approver identity required");
  const repo = store.getRepository(row.repo_id);
  const updated: DecisionRow = { ...row, status: "approved", approved_by: approvedBy, authority: "approved_decision", effective_revision: repo?.head_sha ?? null };
  store.upsertDecision(updated);
  return updated;
}

export function supersedeDecision(store: KnowledgeStore, oldId: string, newId: string, by: string): void {
  const oldRow = store.decision(oldId);
  const newRow = store.decision(newId);
  if (!oldRow || !newRow) throw new Error("both decisions must exist");
  if (newRow.status !== "approved") throw new Error(`${newId} must be approved before it can supersede ${oldId}`);
  store.transaction(() => {
    store.upsertDecision({ ...oldRow, status: "superseded", rationale: `${oldRow.rationale ?? ""} [superseded by ${newId}, ${by}, ${nowIso()}]`.trim() });
    store.upsertDecision({ ...newRow, supersedes: oldId });
  });
}

export function listDecisions(store: KnowledgeStore, repoId: string): DecisionRow[] {
  return store.decisions(repoId);
}

export function proposeFromFeedback(store: KnowledgeStore, runId: string, text: string, scope: string[]): DecisionRow {
  const run = store.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const row: DecisionRow = {
    id: `DEC-R-${shortHash(`${runId}|${text}|${nowIso()}`, 8)}`,
    repo_id: run.repo_id,
    statement: text,
    scope_json: JSON.stringify(scope),
    status: "proposed",
    evidence_ids_json: JSON.stringify([]),
    approved_by: null,
    effective_revision: null,
    supersedes: null,
    authority: "model_inference",
    created_at: nowIso(),
    rationale: `reviewer feedback on run ${runId}`,
  };
  store.upsertDecision(row);
  store.appendEvent(runId, "feedback.recorded", { decision_id: row.id, text, scope });
  return row;
}
