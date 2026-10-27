import type { EvidencePack } from "../knowledge/retrieval.ts";
import type { ChangedFile } from "../util/git.ts";
import type { Finding } from "./results.ts";
import { currentName } from "../knowledge/precedents.ts";

export const PRECEDENT_RULE_IDS = { followed: "PRECEDENT-FOLLOWED", diverged: "PRECEDENT-DIVERGENCE" } as const;

/** A precedent strong enough to compare the change against: current, retrieved with high relevance, and anchored in code that exists. */
export const PRECEDENT_MIN_RELEVANCE = 0.7;

/**
 * Review-only precedent signals computed from the diff (spec §7.5 family): did the change land where a similar
 * ticket was solved before? `PRECEDENT-FOLLOWED` is informational; `PRECEDENT-DIVERGENCE` asks a reviewer to look,
 * it never blocks — a precedent is history, and a different location may be right.
 */
export function precedentFindings(pack: EvidencePack, changed: ChangedFile[], nextId: (prefix: string) => string): Finding[] {
  const changedCode = changed.filter((c) => c.path.endsWith(".py") && c.status !== "deleted" && !isTestPath(c.path)).map((c) => c.path);
  if (!changedCode.length) return [];
  const out: Finding[] = [];
  for (const p of pack.precedents) {
    if (p.staleness !== "current" && p.staleness !== "partially_stale") continue;
    if (p.relevance < PRECEDENT_MIN_RELEVANCE) continue;
    const anchors = [...new Set(p.files.filter((f) => f.current && !f.is_test && f.path.endsWith(".py")).map((f) => f.renamed_to ?? f.path))];
    if (!anchors.length) continue;
    const shared = anchors.filter((a) => changedCode.includes(a));
    const where = p.symbols.filter((x) => x.current).map(currentName);
    const base = { source_evidence_ids: [p.evidence_id], test: null, log_path: null, authority: "deterministic" as const, category: "architecture" as const };
    if (shared.length) {
      out.push({ ...base, id: nextId("F-PRECEDENT"), severity: "info", rule_id: PRECEDENT_RULE_IDS.followed, expected: `change in ${anchors.join(", ")}`, observed: `changed ${shared.join(", ")}`, message: `follows precedent #${p.number} ("${p.title}"${p.pull ? `, PR #${p.pull.number}` : ""}): the change lands in ${shared.join(", ")}${where.length ? ` where ${where.join(", ")} ${where.length > 1 ? "were" : "was"} changed before` : ""}`, location: shared[0] ?? null });
    } else {
      out.push({ ...base, id: nextId("F-PRECEDENT"), severity: "review", rule_id: PRECEDENT_RULE_IDS.diverged, expected: `change in ${anchors.join(", ")}${where.length ? ` (${where.join(", ")})` : ""}`, observed: `changed ${changedCode.join(", ")}`, message: `diverges from precedent #${p.number} ("${p.title}"${p.pull ? `, PR #${p.pull.number}` : ""}): a similar ticket was solved in ${anchors.join(", ")}${where.length ? ` (${where.join(", ")})` : ""}; this change touches ${changedCode.join(", ")} and none of those files — confirm the new location is intended`, location: changedCode[0] ?? null });
    }
  }
  return out;
}

function isTestPath(p: string): boolean {
  return /(^|\/)tests?\//.test(p) || /(^|\/)test_[^/]*\.py$/.test(p) || /_test\.py$/.test(p);
}
