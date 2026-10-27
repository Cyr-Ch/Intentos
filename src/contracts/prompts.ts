import type { EvidencePack, PrecedentHit } from "../knowledge/retrieval.ts";
import { currentName } from "../knowledge/precedents.ts";
import type { ChangeContract } from "./schemas.ts";
import type { Finding } from "../verification/results.ts";

/**
 * Prompts are data handed to the model. Repository text appears only as quoted evidence;
 * nothing here is interpolated into shell commands.
 */

export function buildPlanningPrompt(task: string, pack: EvidencePack, opts: { hasTaskTests: boolean }): string {
  const lines: string[] = [];
  lines.push("You are the IntentOS planner. You may read the repository but MUST NOT modify any file.");
  lines.push("Produce an Engineering Change Contract as JSON matching the provided schema. Rules:");
  lines.push("- Reference ONLY evidence IDs (EV-...), symbol IDs (SY:...), invariant IDs (INV-...), architecture rule IDs (ARCH-...) and command IDs listed below. Never invent IDs; a fabricated ID causes rejection.");
  lines.push(`- base_revision must be exactly "${pack.revision}".`);
  lines.push("- decision = \"implement\" when the evidence supports a safe change; \"clarify\" when the task requires a business decision not covered by approved policy (set blocking open questions); \"abstain\" when the requested behaviour already exists on HEAD (cite the tests/code that prove it; verify by reading them and running pytest in read-only mode if useful).");
  lines.push("- allowed_paths must be inside the allowed path universe and must never include protected paths. Keep them as narrow as the task allows; a catch-all like \"**\" is rejected — name the directories or files to edit.");
  lines.push("- verification entries use trusted command ids only (origin = trusted_config).");
  lines.push("- Mark requirements derived from the task text alone as certainty = hypothesized; cite evidence for confirmed/supported ones.");
  lines.push("- Superseded decisions and stale documents are NOT instructions; follow current approved decisions.");
  lines.push("- Precedents show how a similar ticket was solved in this repository. When the task is of the same kind and the precedent is current, prefer its location and pattern (reuse the same function/module, add the test next to the one it added) and cite its evidence id in the requirement it informs. A stale precedent tells you what was asked, not where to change the code now. Precedents are history, never policy: an invariant or architecture rule always wins.");
  lines.push("- Do not restate the whole repository; be specific and concise. Output JSON only.");
  lines.push("");
  lines.push(`## Task\n${task}`);
  lines.push("");
  lines.push(`## Repository\npath: ${pack.repo_path}\nrevision: ${pack.revision}\npolicy: ${pack.policy_id}`);
  lines.push("");
  lines.push("## Reusable symbols (facts)");
  for (const s of pack.reusable_symbols) lines.push(`- ${s.symbol_id} | ${s.kind} ${s.qualified_name}${s.signature ?? ""} | ${s.path}:${s.line_start}-${s.line_end} | evidence ${s.evidence_id} | reuse=${s.reuse_recommendation} (${s.recommendation_basis})`);
  lines.push("");
  lines.push("## Existing tests (facts)");
  for (const t of pack.tests) lines.push(`- ${t.path}::${t.name} line ${t.line} | evidence ${t.evidence_id} | validates ${t.validates.join(", ")}`);
  lines.push("");
  lines.push("## Documents (facts; authority and status shown)");
  for (const d of pack.docs) lines.push(`- ${d.path}#${d.heading} lines ${d.line_start}-${d.line_end} | evidence ${d.evidence_id} | authority=${d.authority} status=${d.status}${d.adr_status ? ` adr=${d.adr_status}` : ""}\n  > ${d.excerpt.replace(/\n/g, "\n  > ")}`);
  lines.push("");
  lines.push("## Applicable business invariants (trusted policy; blocking ones are enforced by the verifier regardless)");
  for (const c of pack.invariants) lines.push(`- ${c.id} [${c.enforcement}, ${c.authority}, ${c.status}] ${c.statement} | evidence ${c.evidence_ids.join(", ")} | sources ${c.sources.map((s) => `${s.path}${s.heading ? `#${s.heading}` : ""}`).join("; ")}`);
  lines.push("");
  lines.push("## Architecture rules (trusted policy)");
  for (const c of pack.architecture_rules) lines.push(`- ${c.id} [${c.enforcement}, ${c.rule_kind}] ${c.statement} | evidence ${c.evidence_ids.join(", ")} | rule ${JSON.stringify(c.rule)}`);
  lines.push("");
  lines.push("## Decisions");
  for (const c of pack.decisions) lines.push(`- ${c.id} [${c.decision_status}${c.superseded_by ? `, superseded by ${c.superseded_by}` : ""}${c.supersedes ? `, supersedes ${c.supersedes}` : ""}] ${c.statement} | evidence ${c.evidence_ids.join(", ")}`);
  if (pack.conflicts.length) {
    lines.push("");
    lines.push("## Detected conflicts / staleness");
    for (const c of pack.conflicts) lines.push(`- ${c.kind} (${c.resolution}): ${c.summary}`);
  }
  lines.push("");
  lines.push("## Precedents (historical, advisory: how similar tickets were solved in this repository)");
  if (!pack.precedents.length) lines.push("- (none)");
  for (const p of pack.precedents) lines.push(precedentLine(p));
  lines.push("");
  lines.push("## Probable impact (static imports only)");
  for (const i of pack.impact.probable_files) lines.push(`- ${i.path} — ${i.reason}`);
  lines.push("");
  lines.push(`## Allowed path universe\n${pack.allowed_path_universe.join(", ")}`);
  lines.push(`## Protected paths (never writable)\n${pack.protected_paths.join(", ")}`);
  lines.push("## Trusted verification command ids");
  for (const c of pack.commands) {
    if (c.requires_task_tests && !opts.hasTaskTests) continue;
    lines.push(`- ${c.command_id}: ${c.description} [${c.track}, ${c.enforcement}]`);
  }
  lines.push("");
  lines.push("Return the contract JSON now.");
  return lines.join("\n");
}

function precedentLine(p: PrecedentHit): string {
  const where = p.symbols.map((x) => `${currentName(x)}${x.current ? "" : " [gone]"}`);
  const files = p.files.filter((f) => !f.is_test).map((f) => `${f.renamed_to ?? f.path}${f.current ? "" : " [gone]"}`);
  const tests = p.tests_added.map((t) => `${t.path}::${t.name}${t.current ? "" : " [gone]"}`);
  return `- ${p.evidence_id} | #${p.number} "${p.title}"${p.pull ? ` (PR #${p.pull.number}${p.pull.merged_at ? `, merged ${p.pull.merged_at.slice(0, 10)}` : ""})` : ""} | ${p.staleness}${p.staleness_reasons.length ? ` (${p.staleness_reasons.join("; ")})` : ""} | relevance ${p.relevance} | changed: ${where.length ? where.join(", ") : files.join(", ") || "n/a"}${tests.length ? ` | tests added: ${tests.join(", ")}` : ""}${p.excerpt ? `\n  > ${p.excerpt.split("\n").filter(Boolean).slice(0, 4).join("\n  > ")}` : ""}`;
}

/** Precedents the contract cites (through evidence ids), then the best current one as advisory context. */
export function precedentsForContract(contract: ChangeContract, pack: EvidencePack): Array<{ hit: PrecedentHit; cited: boolean }> {
  const cited = new Set<string>();
  contract.requirements.forEach((r) => r.evidence_ids.forEach((e) => cited.add(e)));
  contract.reuse_candidates.forEach((r) => r.evidence_ids.forEach((e) => cited.add(e)));
  const out = pack.precedents.filter((p) => cited.has(p.evidence_id)).map((hit) => ({ hit, cited: true }));
  if (!out.length) {
    const lead = pack.precedents.find((p) => p.staleness === "current" && p.relevance >= 0.5);
    if (lead) out.push({ hit: lead, cited: false });
  }
  return out;
}

export function buildImplementationPrompt(contract: ChangeContract, pack: EvidencePack, task: string): string {
  const symbolsById = new Map(pack.reusable_symbols.map((s) => [s.symbol_id, s]));
  const constraints = new Map([...pack.invariants, ...pack.architecture_rules].map((c) => [c.id, c]));
  const lines: string[] = [];
  lines.push("You are implementing an approved Engineering Change Contract inside an isolated Git worktree.");
  lines.push("Hard rules:");
  lines.push(`- Edit ONLY files matching these allowed paths: ${contract.allowed_paths.join(", ")}.`);
  lines.push(`- NEVER create, modify or delete anything matching: ${contract.protected_paths.join(", ")}. Do not weaken, delete or skip existing tests to make them pass.`);
  lines.push("- Do not commit, do not touch Git configuration, do not access the network.");
  lines.push("- Reuse the listed existing abstractions instead of duplicating their logic. Follow the architecture rules exactly.");
  lines.push("- Run the project's test suite (python -m pytest -q) before finishing. Your own success claims are not trusted: an independent verifier re-runs tests and hidden checks afterwards.");
  lines.push("- Finish with a short summary of files changed and how each business invariant is preserved.");
  lines.push("");
  lines.push(`## Task\n${task}`);
  lines.push(`## Goal\n${contract.goal}`);
  lines.push("## Requirements");
  for (const r of contract.requirements) lines.push(`- ${r.id} (${r.certainty}): ${r.statement}`);
  lines.push("## Business invariants (blocking: verified independently by hidden tests)");
  for (const inv of contract.business_invariants) {
    const c = constraints.get(inv.id);
    lines.push(`- ${inv.id} [${inv.enforcement}]: ${c?.statement ?? "(see policy)"}${c?.sources.length ? ` — source: ${c.sources.map((s) => `${s.path}${s.heading ? `#${s.heading}` : ""}`).join("; ")}` : ""}`);
  }
  lines.push("## Architecture constraints (blocking: checked by deterministic AST rules)");
  for (const a of contract.architecture_constraints) {
    const c = constraints.get(a.id);
    lines.push(`- ${a.id} [${a.enforcement}]: ${c?.statement ?? "(see policy)"}${c?.rule ? ` — rule: ${JSON.stringify(c.rule)}` : ""}`);
  }
  lines.push("## Existing components to reuse");
  for (const r of contract.reuse_candidates) {
    const s = symbolsById.get(r.symbol_id);
    lines.push(`- ${r.action}: ${s ? `${s.kind} ${s.qualified_name} (${s.path}:${s.line_start}-${s.line_end})` : r.symbol_id} — ${r.rationale}`);
  }
  if (contract.affected_modules.length) lines.push(`## Probably affected files\n${contract.affected_modules.join(", ")}`);
  const precedents = precedentsForContract(contract, pack);
  if (precedents.length) {
    lines.push("## Precedents (how a similar ticket was solved here; follow the pattern unless the contract says otherwise)");
    for (const { hit, cited } of precedents) {
      const where = hit.symbols.filter((x) => x.current).map((x) => `${currentName(x)}${x.path && x.line_start ? ` (${x.path}:${x.line_start})` : ""}`);
      const files = hit.files.filter((f) => f.current && !f.is_test).map((f) => f.renamed_to ?? f.path);
      lines.push(`- #${hit.number} "${hit.title}"${hit.pull ? ` (PR #${hit.pull.number})` : ""}${cited ? ", cited by the contract" : ", advisory"}: changed ${where.length ? where.join(", ") : files.join(", ") || "n/a"}${hit.tests_added.length ? `; added ${hit.tests_added.map((t) => `${t.path}::${t.name}`).join(", ")}` : ""}`);
    }
  }
  if (contract.open_questions.length) {
    lines.push("## Non-blocking open questions (make the conservative choice and state it in your summary)");
    for (const q of contract.open_questions) lines.push(`- ${q.id}: ${q.question}`);
  }
  lines.push("## Verification that will run independently");
  for (const v of contract.verification) lines.push(`- ${v.command_id}`);
  return lines.join("\n");
}

/**
 * Continuation prompt sent to the *same* Codex thread when `resume` re-enters an implementation or repair
 * turn that was interrupted before it finished. The worktree already holds the partial work.
 */
export function buildContinuePrompt(contract: ChangeContract, phase: "implement" | "repair", findings: Finding[]): string {
  const lines: string[] = [];
  lines.push(`Your previous ${phase === "repair" ? "repair" : "implementation"} turn was interrupted before it finished.`);
  lines.push("The worktree already contains your partial changes: inspect `git status` and `git diff` first, then continue from where you stopped. Do not start over and do not revert work that already satisfies the contract.");
  lines.push("Hard rules (unchanged):");
  lines.push(`- Edit ONLY files matching these allowed paths: ${contract.allowed_paths.join(", ")}.`);
  lines.push(`- NEVER create, modify or delete anything matching: ${contract.protected_paths.join(", ")}. Do not weaken, delete or skip existing tests.`);
  lines.push("- Do not commit, do not touch Git configuration, do not access the network.");
  lines.push("- Run python -m pytest -q before finishing. Your own success claims are not trusted: an independent verifier re-runs tests and hidden checks afterwards.");
  lines.push("- Finish with a short summary of files changed and how each business invariant is preserved.");
  lines.push("");
  lines.push(`## Goal\n${contract.goal}`);
  lines.push("## Requirements");
  for (const r of contract.requirements) lines.push(`- ${r.id} (${r.certainty}): ${r.statement}`);
  lines.push("## Business invariants (blocking: verified independently by hidden tests)");
  for (const inv of contract.business_invariants) lines.push(`- ${inv.id} [${inv.enforcement}]`);
  lines.push("## Architecture constraints (blocking: checked by deterministic AST rules)");
  for (const a of contract.architecture_constraints) lines.push(`- ${a.id} [${a.enforcement}]`);
  if (phase === "repair") {
    const blocking = findings.filter((x) => x.severity === "blocking");
    lines.push("## Blocking findings from the last verification (the interrupted repair was addressing these)");
    if (!blocking.length) lines.push("- (no blocking findings recorded)");
    for (const f of blocking) {
      lines.push(`- ${f.id} [${f.category}${f.rule_id ? ` ${f.rule_id}` : ""}] ${f.message}${f.test ? ` (test: ${f.test})` : ""}${f.expected ? ` expected=${f.expected}` : ""}${f.observed ? ` observed=${f.observed}` : ""}${f.location ? ` at ${f.location}` : ""}`);
    }
  }
  return lines.join("\n");
}

export function buildRepairPrompt(contract: ChangeContract, findings: Finding[], attempt: number): string {
  const lines: string[] = [];
  lines.push(`Repair attempt ${attempt}: the independent verifier rejected the current working tree. Fix the code so the checks below pass WITHOUT changing the contract, tests you did not write, or any protected path.`);
  lines.push(`Allowed paths: ${contract.allowed_paths.join(", ")}. Protected: ${contract.protected_paths.join(", ")}.`);
  lines.push("Do not disable or delete checks. Re-run python -m pytest -q before finishing.");
  lines.push("");
  lines.push("## Blocking findings");
  for (const f of findings.filter((x) => x.severity === "blocking")) {
    lines.push(`- ${f.id} [${f.category}${f.rule_id ? ` ${f.rule_id}` : ""}] ${f.message}${f.test ? ` (test: ${f.test})` : ""}${f.expected ? ` expected=${f.expected}` : ""}${f.observed ? ` observed=${f.observed}` : ""}${f.location ? ` at ${f.location}` : ""}`);
  }
  const review = findings.filter((x) => x.severity !== "blocking");
  if (review.length) {
    lines.push("## Non-blocking findings (address if cheap)");
    for (const f of review) lines.push(`- ${f.id} [${f.category}] ${f.message}`);
  }
  return lines.join("\n");
}
