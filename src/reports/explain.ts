import type { EvidencePack } from "../knowledge/retrieval.ts";
import { currentName } from "../knowledge/precedents.ts";

export function renderEvidencePack(p: EvidencePack): string {
  const lines: string[] = [];
  lines.push(`# Evidence pack — ${p.repo_path} @ ${p.revision.slice(0, 10)} (policy ${p.policy_id})`);
  lines.push(`Task: ${p.task}`);
  lines.push(`Query terms: ${p.query.primary.join(", ")}${p.query.expanded.length ? `  (+ ${p.query.expanded.join(", ")})` : ""}`);
  lines.push("");
  lines.push("## Reusable symbols (facts: exist at the cited location)");
  if (!p.reusable_symbols.length) lines.push("  (none matched)");
  for (const s of p.reusable_symbols) {
    lines.push(`  [${s.evidence_id}] ${s.kind} ${s.qualified_name}${s.signature ?? ""}  ${s.path}:${s.line_start}-${s.line_end}  relevance=${s.relevance}`);
    lines.push(`      reuse: ${s.reuse_recommendation} — ${s.recommendation_basis}${s.docstring_excerpt ? `; "${s.docstring_excerpt}"` : ""}`);
  }
  lines.push("");
  lines.push("## Existing tests");
  if (!p.tests.length) lines.push("  (none)");
  for (const t of p.tests) lines.push(`  [${t.evidence_id}] ${t.path}::${t.name} (line ${t.line}) validates: ${t.validates.join(", ")}`);
  lines.push("");
  lines.push("## Documents");
  if (!p.docs.length) lines.push("  (none)");
  for (const d of p.docs) lines.push(`  [${d.evidence_id}] ${d.path}#${d.heading} (lines ${d.line_start}-${d.line_end}) authority=${d.authority} status=${d.status}${d.adr_status ? ` adr=${d.adr_status}` : ""}`);
  lines.push("");
  lines.push("## Applicable business invariants (trusted policy)");
  if (!p.invariants.length) lines.push("  (none — business correctness cannot be verified for this task)");
  for (const c of p.invariants) lines.push(`  ${c.id} [${c.enforcement}, ${c.authority}, ${c.status}] ${c.statement}  sources: ${c.sources.map((s) => `${s.path}${s.heading ? `#${s.heading}` : ""}${s.resolved ? "" : " (UNRESOLVED)"}`).join("; ")}  applicability=${c.applicability}`);
  lines.push("");
  lines.push("## Architecture rules (trusted policy; all run deterministically)");
  for (const c of p.architecture_rules) lines.push(`  ${c.id} [${c.enforcement}, ${c.rule_kind}] ${c.statement}  applicability=${c.applicability}`);
  lines.push("");
  lines.push("## Decisions");
  if (!p.decisions.length) lines.push("  (none matched)");
  for (const c of p.decisions) lines.push(`  ${c.id} [${c.decision_status}${c.superseded_by ? ` → superseded by ${c.superseded_by}` : ""}${c.supersedes ? `, supersedes ${c.supersedes}` : ""}] ${c.statement}  sources: ${c.sources.map((s) => s.path).join("; ")}`);
  if (p.conflicts.length) {
    lines.push("");
    lines.push("## Conflicts / staleness (deterministic)");
    for (const c of p.conflicts) lines.push(`  ${c.kind} (${c.resolution}): ${c.summary}`);
  }
  lines.push("");
  lines.push("## Precedents (how similar tickets were solved here; history, not policy)");
  if (!p.precedents.length) lines.push("  (none matched — run `intentos precedents sync <repo> --issues owner/name` to load the ticket history)");
  for (const pr of p.precedents) {
    lines.push(`  [${pr.evidence_id}] #${pr.number} "${pr.title}"${pr.pull ? ` ← PR #${pr.pull.number}${pr.pull.merged_at ? ` (${pr.pull.merged_at.slice(0, 10)})` : ""}` : ""}  relevance=${pr.relevance}  ${pr.staleness}`);
    const where = pr.symbols.map((x) => `${currentName(x)}${x.current ? (x.line_start ? ` (${x.path}:${x.line_start})` : "") : " [gone]"}`);
    if (where.length) lines.push(`      changed: ${where.join(", ")}`);
    const files = pr.files.filter((f) => !f.is_test).map((f) => `${f.path}${f.current ? "" : " [gone]"}`);
    if (files.length && !where.length) lines.push(`      files: ${files.join(", ")}`);
    if (pr.tests_added.length) lines.push(`      tests added: ${pr.tests_added.map((t) => `${t.path}::${t.name}${t.current ? "" : " [gone]"}`).join(", ")}`);
    lines.push(`      why: ${pr.reasons.join("; ")}${pr.staleness_reasons.length ? `; ${pr.staleness_reasons.join("; ")}` : ""}`);
    lines.push(`      ${pr.url}`);
  }
  lines.push("");
  lines.push(`## Probable impact (${p.impact.method})`);
  for (const i of p.impact.probable_files) lines.push(`  ${i.path}  — ${i.reason} (confidence ${i.confidence})`);
  for (const l of p.impact.limitations) lines.push(`  note: ${l}`);
  if (p.history.length) {
    lines.push("");
    lines.push("## Recent history of impacted files");
    for (const h of p.history) lines.push(`  ${h.sha.slice(0, 8)} ${h.date.slice(0, 10)} ${h.subject}`);
  }
  if (p.suggestions.length) {
    lines.push("");
    lines.push("## Suggestions (heuristic, not facts)");
    for (const s of p.suggestions) lines.push(`  - ${s.text}`);
  }
  lines.push("");
  lines.push(`Allowed path universe: ${p.allowed_path_universe.join(", ")}  |  protected: ${p.protected_paths.join(", ")}`);
  lines.push(`Trusted verification commands: ${p.commands.map((c) => `${c.command_id} (${c.track}, ${c.enforcement})`).join("; ")}`);
  for (const l of p.limitations) lines.push(`note: ${l}`);
  return lines.join("\n");
}
