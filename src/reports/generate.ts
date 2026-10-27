import fs from "node:fs";
import path from "node:path";
import type { KnowledgeStore } from "../knowledge/storage.ts";
import { RunStore, type TaskRecord } from "../orchestrator/store.ts";
import type { ChangeContract } from "../contracts/schemas.ts";
import type { CompiledContract } from "../contracts/compiler.ts";
import type { EvidencePack } from "../knowledge/retrieval.ts";
import type { VerificationResult } from "../verification/results.ts";
import { nowIso } from "../util/ids.ts";

export interface ReportJson {
  run_id: string;
  task: TaskRecord;
  outcome: string;
  final_state: string;
  base_sha: string;
  mode: string;
  simulated: boolean;
  generated_at: string;
  goal: string | null;
  decision: string | null;
  rationale: string | null;
  open_questions: ChangeContract["open_questions"];
  reused_components: Array<{ symbol_id: string; action: string; location: string | null; rationale: string }>;
  decisions: Array<{ id: string; status: string | undefined; statement: string; sources: string[] }>;
  impacted_modules: string[];
  verification: {
    status: string | null;
    attempt: number | null;
    commands: VerificationResult["commands"];
    findings: VerificationResult["findings"];
    tracks: VerificationResult["tracks"] | null;
    unverified_areas: string[];
    limitations: string[];
  } | null;
  changed_files: VerificationResult["changed_files"];
  /** Review-only architectural-surprise signals (rule ids SURPRISE-*): risk triage, never blocking. */
  architectural_surprise: Array<{ id: string; rule_id: string; location: string | null; message: string }>;
  /** How similar tickets were solved before, and what this run did with that: cited by the contract, followed or diverged in the diff. */
  precedents: Array<{ precedent_id: string; number: number; url: string; title: string; pull_url: string | null; staleness: string; relevance: number; cited: boolean; outcome: "followed" | "diverged" | "not_compared"; where: string[] }>;
  evidence: Array<{ id: string; path: string | null; lines: string | null; authority: string; status: string; summary: string | null }>;
  injected_by_compiler: CompiledContract["injected"] | null;
  compiler_warnings: string[];
  artifacts: Record<string, string>;
  metrics: Record<string, unknown> | null;
  risks_and_limitations: string[];
}

const OUTCOME: Record<string, string> = {
  REVIEW_READY: "Review-ready",
  FAILED: "Failed",
  CLARIFICATION_REQUIRED: "Needs clarification",
  ABSTAINED: "Abstained",
  HUMAN_REVIEW: "Human review required",
};

export function generateReport(store: KnowledgeStore, runId: string): { json: ReportJson; markdown: string; paths: { json: string; md: string } } {
  const row = store.getRun(runId);
  if (!row) throw new Error(`run ${runId} not found`);
  const rs = new RunStore(store, runId, row.run_dir);
  const task = JSON.parse(row.task_json) as TaskRecord;
  const contract = row.contract_json ? (JSON.parse(row.contract_json) as ChangeContract) : null;
  const validation = rs.readJson<Omit<CompiledContract, "contract">>("contractValidation");
  const pack = rs.readJson<EvidencePack>("evidence");
  const verification = rs.readJson<VerificationResult>("verification");
  const metrics = rs.readJson<Record<string, unknown>>("metrics");
  const result = row.result_json ? (JSON.parse(row.result_json) as Record<string, unknown>) : null;
  const symbols = new Map((pack?.reusable_symbols ?? []).map((s) => [s.symbol_id, s]));
  const evidenceIndex = pack?.evidence_index ?? {};

  const citedEvidence = new Set<string>();
  contract?.requirements.forEach((r) => r.evidence_ids.forEach((e) => citedEvidence.add(e)));
  contract?.business_invariants.forEach((r) => r.evidence_ids.forEach((e) => citedEvidence.add(e)));
  contract?.architecture_constraints.forEach((r) => r.evidence_ids.forEach((e) => citedEvidence.add(e)));
  contract?.reuse_candidates.forEach((r) => r.evidence_ids.forEach((e) => citedEvidence.add(e)));
  verification?.findings.forEach((f) => f.source_evidence_ids.forEach((e) => citedEvidence.add(e)));

  const risks: string[] = [];
  if (row.mode === "offline") risks.push("Offline mode: the planner/implementer were simulated; nothing here measures Codex performance.");
  if (verification) risks.push(...verification.limitations);
  if (validation?.issues?.length) for (const i of validation.issues.filter((x) => x.severity === "warning")) risks.push(`compiler warning: ${i.message}`);
  if (contract?.requirements.some((r) => r.certainty === "hypothesized")) risks.push("Some requirements are hypothesized from the task text only (no repository evidence).");
  if (result?.reason) risks.push(`run ended with: ${String(result.reason)}`);
  if (!verification && ["REVIEW_READY"].includes(row.state)) risks.push("INCONSISTENT: review-ready without verification artifacts");
  if (verification && verification.status === "passed" && verification.unverified_areas.length) risks.push("Passing verification covers only the listed checks; see unverified areas.");

  const json: ReportJson = {
    run_id: runId,
    task,
    outcome: OUTCOME[row.state] ?? `In progress (${row.state})`,
    final_state: row.state,
    base_sha: row.base_sha,
    mode: row.mode,
    simulated: row.mode === "offline" || !!verification?.simulated,
    generated_at: nowIso(),
    goal: contract?.goal ?? null,
    decision: contract?.decision ?? null,
    rationale: contract?.rationale ?? null,
    open_questions: contract?.open_questions ?? [],
    reused_components: (contract?.reuse_candidates ?? []).map((r) => {
      const s = symbols.get(r.symbol_id);
      return { symbol_id: r.symbol_id, action: r.action, location: s ? `${s.path}:${s.line_start}-${s.line_end}` : null, rationale: r.rationale };
    }),
    decisions: (pack?.decisions ?? []).map((d) => ({ id: d.id, status: d.decision_status, statement: d.statement, sources: d.sources.map((s) => s.path) })),
    impacted_modules: contract?.affected_modules ?? [],
    verification: verification
      ? { status: verification.status, attempt: verification.attempt, commands: verification.commands, findings: verification.findings, tracks: verification.tracks, unverified_areas: verification.unverified_areas, limitations: verification.limitations }
      : null,
    changed_files: verification?.changed_files ?? [],
    architectural_surprise: (verification?.findings ?? []).filter((f) => f.rule_id?.startsWith("SURPRISE-")).map((f) => ({ id: f.id, rule_id: f.rule_id!, location: f.location, message: f.message })),
    precedents: (pack?.precedents ?? []).map((p) => {
      const f = (verification?.findings ?? []).find((x) => x.rule_id?.startsWith("PRECEDENT-") && x.source_evidence_ids.includes(p.evidence_id));
      return { precedent_id: p.precedent_id, number: p.number, url: p.url, title: p.title, pull_url: p.pull?.url ?? null, staleness: p.staleness, relevance: p.relevance, cited: citedEvidence.has(p.evidence_id), outcome: f?.rule_id === "PRECEDENT-FOLLOWED" ? "followed" : f?.rule_id === "PRECEDENT-DIVERGENCE" ? "diverged" : "not_compared", where: p.symbols.filter((x) => x.current).map((x) => x.qualified_name) };
    }),
    evidence: [...citedEvidence].sort().map((id) => {
      const e = evidenceIndex[id];
      return { id, path: e?.path ?? null, lines: e?.line_start ? `${e.line_start}-${e.line_end}` : null, authority: e?.authority ?? "unknown", status: e?.status ?? "unknown", summary: e?.summary ?? null };
    }),
    injected_by_compiler: validation?.injected ?? null,
    compiler_warnings: (validation?.issues ?? []).filter((i) => i.severity === "warning").map((i) => i.message),
    artifacts: artifactPaths(row.run_dir),
    metrics,
    risks_and_limitations: risks,
  };
  const markdown = renderMarkdown(json, contract, pack);
  rs.writeJson("reportJson", json);
  rs.writeText("reportMd", markdown);
  return { json, markdown, paths: { json: rs.path("reportJson"), md: rs.path("reportMd") } };
}

function artifactPaths(runDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(runDir)) return out;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "snapshot") continue;
        walk(p);
      } else out[path.relative(runDir, p)] = p;
    }
  };
  walk(runDir);
  return out;
}

function renderMarkdown(r: ReportJson, contract: ChangeContract | null, pack: EvidencePack | null): string {
  const L: string[] = [];
  const invariants = new Map((pack?.invariants ?? []).map((i) => [i.id, i]));
  const rules = new Map((pack?.architecture_rules ?? []).map((i) => [i.id, i]));
  L.push(`# IntentOS Review — ${r.task.task_id}`);
  L.push("");
  L.push(`Run \`${r.run_id}\` · base \`${r.base_sha.slice(0, 12)}\` · mode ${r.mode}${r.simulated ? " (**simulated orchestration — not an agent performance measurement**)" : ""} · generated ${r.generated_at}`);
  L.push("");
  L.push("## Outcome");
  L.push(`**${r.outcome}** (state ${r.final_state})`);
  if (r.decision && r.decision !== "implement") L.push(`\nPlanner decision: **${r.decision}** — ${r.rationale ?? ""}`);
  if (r.open_questions.length) {
    L.push("\nOpen questions:");
    for (const q of r.open_questions) L.push(`- ${q.id}${q.blocking ? " (blocking)" : ""}: ${q.question}`);
  }
  L.push("");
  L.push("## Requested business goal");
  L.push(r.task.task);
  if (r.goal && r.goal !== r.task.task) L.push(`\nContract goal: ${r.goal}`);
  if (contract?.requirements.length) {
    L.push("\nRequirements:");
    for (const q of contract.requirements) L.push(`- ${q.id} [${q.certainty}] ${q.statement}${q.evidence_ids.length ? ` (evidence ${q.evidence_ids.join(", ")})` : ""}`);
  }
  L.push("");
  L.push("## How the implementation fits the repository");
  L.push(`- Reused components: ${r.reused_components.length ? "" : "none declared"}`);
  for (const c of r.reused_components) L.push(`  - ${c.action}: ${c.symbol_id}${c.location ? ` (${c.location})` : ""} — ${c.rationale}`);
  L.push(`- Applicable architectural decisions: ${r.decisions.length ? "" : "none matched"}`);
  for (const d of r.decisions) L.push(`  - ${d.id} [${d.status}] ${d.statement} (${d.sources.join(", ")})`);
  L.push(`- Impacted modules: ${r.impacted_modules.join(", ") || "n/a"}`);
  if (r.injected_by_compiler) {
    const inj = r.injected_by_compiler;
    const parts = [inj.invariants.length ? `invariants ${inj.invariants.join(", ")}` : "", inj.architecture_constraints.length ? `architecture rules ${inj.architecture_constraints.join(", ")}` : "", inj.verification.length ? `verification ${inj.verification.join(", ")}` : ""].filter(Boolean);
    if (parts.length) L.push(`- Enforced by compiler regardless of planner output: ${parts.join("; ")}`);
  }
  L.push("");
  L.push("## Verified behavior");
  if (!r.verification) {
    L.push("No verification was executed for this run. **No success is claimed.**");
  } else {
    const v = r.verification;
    const byTrack = (track: string) => v.commands.filter((c) => c.track === track);
    const fmt = (c: ReportJson["verification"] extends infer T ? (T extends { commands: Array<infer C> } ? C : never) : never) => `${c.command_id}: ${c.status}${c.tests_passed !== null ? ` (${c.tests_passed} passed, ${c.tests_failed} failed)` : ""} — ${c.summary}`;
    L.push(`Verifier status: **${v.status}** (attempt ${v.attempt})`);
    L.push("- Functional tests:");
    for (const c of byTrack("functional")) L.push(`  - ${fmt(c)}`);
    L.push("- Business invariants:");
    const invCmds = byTrack("business_invariant");
    if (!invCmds.length) L.push("  - none executed — **business correctness not verified**");
    for (const c of invCmds) L.push(`  - ${fmt(c)}`);
    for (const id of contract?.business_invariants.map((b) => b.id) ?? []) {
      const inv = invariants.get(id);
      const failed = v.findings.some((f) => f.rule_id === id && f.severity === "blocking");
      L.push(`  - ${id}: ${failed ? "**VIOLATED**" : v.tracks?.business_invariant?.status === "not_run" ? "not run" : "held in executed checks"} — ${inv?.statement ?? ""}`);
    }
    L.push("- Architecture checks:");
    for (const c of byTrack("architecture")) L.push(`  - ${fmt(c)}`);
    for (const id of contract?.architecture_constraints.map((a) => a.id) ?? []) {
      const failed = v.findings.some((f) => f.rule_id === id && f.severity === "blocking");
      L.push(`  - ${id}: ${failed ? "**VIOLATED**" : "passed"} — ${rules.get(id)?.statement ?? ""}`);
    }
    L.push("- Scope:");
    for (const c of byTrack("scope")) L.push(`  - ${fmt(c)}`);
    const cx = v.findings.filter((f) => f.category === "counterexample");
    const cxCmd = v.commands.find((c) => c.command_id === "counterexamples");
    L.push(`- Counterexamples: ${cxCmd ? `${cxCmd.status} — ${cxCmd.summary}` : "not configured"}${cx.length ? `; ${cx.length} exploratory failure(s) listed below` : ""}`);
    if (v.findings.length) {
      L.push("\nFindings:");
      for (const f of v.findings) L.push(`- ${f.id} **${f.severity}** [${f.category}${f.rule_id ? ` ${f.rule_id}` : ""}; ${f.authority}] ${f.message}${f.expected ? `\n  - expected: ${f.expected}` : ""}${f.observed ? `\n  - observed: ${f.observed}` : ""}${f.log_path ? `\n  - log: ${f.log_path}` : ""}`);
    }
    if (v.unverified_areas.length) {
      L.push("\nNot verified:");
      for (const u of v.unverified_areas) L.push(`- ${u}`);
    }
  }
  L.push("");
  L.push("## Precedents (how similar tickets were solved here)");
  if (!r.precedents.length) L.push("- none matched this task (history, not policy; `intentos precedents sync` loads the ticket history)");
  for (const p of r.precedents) {
    const verdict = p.outcome === "followed" ? "**followed**" : p.outcome === "diverged" ? "**diverged** (review signal)" : p.staleness === "stale" ? "stale, not compared" : "not compared";
    L.push(`- [#${p.number}](${p.url}) ${p.title}${p.pull_url ? ` ([PR](${p.pull_url}))` : ""} — ${p.staleness}, relevance ${p.relevance}${p.cited ? ", cited by the contract" : ""}; ${verdict}${p.where.length ? ` — changed ${p.where.join(", ")}` : ""}`);
  }
  L.push("");
  L.push("## Architectural surprise (review signals)");
  if (!r.verification) L.push("- not evaluated (no verification)");
  else if (!r.architectural_surprise.length) L.push("- none detected — risk triage only; absence is not a design approval");
  for (const s of r.architectural_surprise) L.push(`- ${s.id} ${s.rule_id}${s.location ? ` (${s.location})` : ""}: ${s.message}`);
  L.push("");
  L.push("## Evidence");
  L.push(`- Base revision: \`${r.base_sha}\``);
  L.push("- Sources cited by the contract and findings:");
  for (const e of r.evidence) L.push(`  - ${e.id} ${e.path ?? (e.authority === "historical_precedent" ? "(precedent)" : "(policy)")}${e.lines ? `:${e.lines}` : ""} [${e.authority}, ${e.status}] ${e.summary ?? ""}`);
  L.push(`- Changed files (${r.changed_files.length}):`);
  for (const c of r.changed_files) L.push(`  - ${c.status} ${c.path}${c.in_scope ? "" : " **OUT OF SCOPE**"}${c.protected ? " **PROTECTED**" : ""}`);
  L.push(`- Diff: ${r.artifacts["diff.patch"] ?? "n/a"}`);
  L.push(`- Test logs: ${Object.keys(r.artifacts).filter((k) => k.endsWith(".log")).map((k) => r.artifacts[k]).join(", ") || "n/a"}`);
  L.push(`- Codex events: ${r.artifacts["codex_events.jsonl"] ?? "n/a"}`);
  if (contract?.requirements.some((q) => q.certainty === "hypothesized")) L.push(`- Unresolved assumptions: ${contract.requirements.filter((q) => q.certainty === "hypothesized").map((q) => q.id).join(", ")} are hypothesized from the task text`);
  if (r.metrics) {
    const m = r.metrics;
    L.push(`- Metrics: wall ${m.wall_time_ms} ms; tokens ${typeof m.tokens === "string" ? m.tokens : JSON.stringify(m.tokens)}; repairs ${m.repair_rounds}; verification ${m.verification_time_ms} ms`);
  }
  L.push("");
  L.push("## Risks, reviewer decisions and limitations");
  if (!r.risks_and_limitations.length) L.push("- none recorded");
  for (const x of r.risks_and_limitations) L.push(`- ${x}`);
  L.push("");
  return L.join("\n");
}
