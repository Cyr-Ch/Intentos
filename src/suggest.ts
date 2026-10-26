import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ensureHome, resolvePaths, resolvePython } from "./config.ts";
import { repoIdFor } from "./knowledge/indexer.ts";
import { policyIdFor, runProbe } from "./onboard.ts";
import { LiveCodexEngine, type CodingEngine } from "./codex/adapter.ts";
import { headSha, isGitRepo } from "./util/git.ts";
import { nowIso } from "./util/ids.ts";
import { redact } from "./util/redact.ts";

/**
 * `intentos suggest <repo>`: mine what the repository already says about its rules and turn it into PROPOSALS.
 * Candidates come from `python/policy_suggest.py` (commits, rule-like tests, must/never sentences in documents,
 * ADR files, one-directional layer imports, frozen directories, changelog deprecations). Everything written here is
 * a draft: policy blocks carry `approved_by: TODO`, ADR drafts carry `Status: Proposed`, and nothing is read back
 * as authority until a person moves it into `policies/<id>.yaml`.
 */

export interface CandidateEvidence {
  type: "commit" | "test" | "doc" | "adr" | "import" | "history" | "changelog" | string;
  ref: string;
  excerpt: string;
  path?: string | null;
  line?: number | null;
  [k: string]: unknown;
}

export interface Candidate {
  id: string;
  kind: "invariant" | "architecture_rule" | "frozen_paths" | "decision";
  title: string;
  statement: string;
  confidence: "high" | "medium" | "low";
  evidence: CandidateEvidence[];
  applies_to_paths?: string[];
  scope?: string[];
  /** Draft lifted from the existing test: imports, constants, fixtures and class setup it needs; `notes` lists what could not be resolved. */
  suggested_hidden_test?: { from: string; imports: string; source: string; notes: string[]; standalone: boolean } | null;
  rule?: Record<string, unknown>;
  status?: string;
  supersedes?: string | null;
  sources?: Array<{ path: string; heading?: string | null }>;
  policy_block: Record<string, unknown>;
  /** Business-relevance score in [0, 1] from the deterministic ranker, with its components. */
  score: number;
  signals: { domain: number; shape: number; corroboration: number; centrality: number; stability: number; prior: number };
  relevance: "high" | "medium" | "low";
  rank: number;
  cluster: string;
  cluster_size: number;
  cluster_members: string[];
  /** Set by `--classify`: the model's verdict, validated against the evidence. */
  classification?: Classification | null;
}

export type Category = "business_rule" | "robustness_rule" | "implementation_detail" | "environment" | "tooling" | "duplicate";

export interface Classification {
  category: Category;
  keep: boolean;
  reason: string;
  /** Model rewrite of the statement, present only when every identifier it uses appears in the evidence. */
  rule: string | null;
  rule_rejected: string | null;
  cluster: string;
  duplicate_of: string | null;
}

export interface MinerOutput {
  repo: string;
  head: string;
  policy_id: string;
  candidates: Candidate[];
  counts: Record<string, number>;
  vocabulary?: string[];
  warnings: string[];
}

export interface SuggestOptions {
  policyId?: string;
  /** Directory for suggestions.json / policy-suggestions.md / policy-suggestions.yaml (default `<home>/onboard/<repo-id>`). */
  outDir?: string;
  /** Write ADR drafts (`Status: Proposed`) into the repository. */
  writeAdrs: boolean;
  /** Where ADR drafts go (default `<repo>/docs/decisions`). */
  adrDir?: string;
  /** Ask Codex to turn the mined evidence into readable ADR text (read-only thread); off by default because it spends tokens. */
  withCodex: boolean;
  engine?: CodingEngine;
  maxCommits?: number;
  minConfidence?: Candidate["confidence"];
  /** Drop candidates whose business-relevance score is below this (0..1). */
  minScore?: number;
  /** Ask Codex to classify the top candidates (keep/drop, category, rule rewrite, cluster); validated against the evidence. */
  classify?: boolean;
  /** How many top-ranked candidates to send for classification (default 40, batches of 20). */
  classifyTop?: number;
  /** JSON file with accept_tokens / reject_tokens learned from earlier reviews (default `<out>/feedback.json` when present). */
  feedbackFile?: string;
}

export interface AdrDraft {
  number: number;
  file: string | null;
  title: string;
  candidate_ids: string[];
  synthesized_by: "deterministic" | "codex";
  markdown: string;
}

export interface SuggestResult {
  repo_path: string;
  repo_id: string;
  policy_id: string;
  head: string;
  candidates: Candidate[];
  counts: Record<string, number>;
  files: { json: string; markdown: string; yaml: string };
  adrs: AdrDraft[];
  adr_dir: string | null;
  codex: { used: boolean; model: string | null; usage: unknown; dropped: number; note: string | null };
  classification: { used: boolean; model: string | null; usage: unknown; classified: number; kept: number; filtered: number; rewrites_rejected: number; note: string | null };
  /** Candidates the classifier set aside (still in `candidates`, with `classification.keep === false`). */
  filtered_out: Array<{ id: string; title: string; category: Category; reason: string }>;
  vocabulary: string[];
  warnings: string[];
  next_steps: string[];
}

const CONFIDENCE_RANK: Record<Candidate["confidence"], number> = { high: 0, medium: 1, low: 2 };

export function runMiner(repoPath: string, policyId: string, maxCommits = 500, feedbackFile?: string): MinerOutput {
  const script = path.join(resolvePaths().python, "policy_suggest.py");
  const args = ["-I", script, repoPath, "--policy-id", policyId, "--max-commits", String(maxCommits)];
  if (feedbackFile && fs.existsSync(feedbackFile)) args.push("--feedback", feedbackFile);
  const res = spawnSync(resolvePython(), args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 300_000 });
  if (res.error) throw new Error(`policy miner failed to start: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`policy miner exited ${res.status}: ${(res.stderr ?? "").trim()}`);
  return JSON.parse(res.stdout) as MinerOutput;
}

function evidenceLine(e: CandidateEvidence): string {
  const where = e.path ? `${e.path}${e.line ? `:${e.line}` : ""}` : "";
  return `${e.type} ${e.ref}${where && where !== e.ref ? ` (${where})` : ""}: ${redact(e.excerpt)}`;
}

/** Human-readable review document: one section per candidate with its evidence, the policy block and the hidden-test draft. */
export function renderSuggestionsMarkdown(out: MinerOutput, adrs: AdrDraft[]): string {
  const L: string[] = [];
  L.push(`# Policy suggestions for ${out.policy_id}`);
  L.push("");
  L.push(`Mined from ${out.repo} at ${out.head.slice(0, 12)} on ${nowIso().slice(0, 10)}. **These are proposals with no authority.** Review each one, delete`);
  L.push(`what is wrong, edit the rest, and paste the blocks you accept into \`policies/${out.policy_id}.yaml\` with your name in \`approved_by\`.`);
  L.push("");
  L.push(`Counts: ${Object.entries(out.counts).map(([k, v]) => `${k} ${v}`).join(", ")}${adrs.length ? `; ADR drafts: ${adrs.length}` : ""}. Ordered by business-relevance score`);
  L.push(`(domain vocabulary of this repository, rule shape, corroboration across sources, import-graph centrality, test age).${out.vocabulary?.length ? ` Domain terms seen: ${out.vocabulary.slice(0, 12).join(", ")}.` : ""}`);
  for (const w of out.warnings) L.push(`- warning: ${w}`);
  const classified = out.candidates.some((c) => c.classification);
  const sections: Array<{ title: string; items: Candidate[] }> = classified
    ? [
        { title: "Kept after classification", items: out.candidates.filter((c) => c.classification?.keep) },
        { title: "Filtered out by classification (rescue if wrong)", items: out.candidates.filter((c) => c.classification && !c.classification.keep) },
        { title: "Not classified (below --classify-top)", items: out.candidates.filter((c) => !c.classification) },
      ]
    : (["high", "medium", "low"] as const).map((level) => ({ title: `${level} relevance`, items: out.candidates.filter((c) => c.relevance === level) }));
  for (const section of sections) {
    const group = section.items;
    if (!group.length) continue;
    L.push("");
    L.push(`## ${section.title} (${group.length})`);
    for (const c of group) {
      L.push("");
      L.push(`### ${c.id} · ${c.kind} · ${c.title}`);
      L.push("");
      L.push(`score ${c.score.toFixed(2)} (${c.relevance}; domain ${c.signals.domain.toFixed(2)}, shape ${c.signals.shape.toFixed(2)}, corroboration ${c.signals.corroboration.toFixed(2)}, centrality ${c.signals.centrality.toFixed(2)}, stability ${c.signals.stability.toFixed(2)}) · evidence confidence ${c.confidence}${c.cluster_size > 1 ? ` · cluster \`${c.cluster}\` with ${c.cluster_members.join(", ")}` : ""}`);
      if (c.classification) {
        const k = c.classification;
        L.push(`classification: **${k.category}**, ${k.keep ? "keep" : "drop"} — ${k.reason}${k.duplicate_of ? ` (duplicate of ${k.duplicate_of})` : ""}${k.rule_rejected ? ` · rewrite rejected: ${k.rule_rejected}` : ""}`);
      }
      L.push("");
      L.push(c.classification?.rule ? `${c.classification.rule}\n\n(original: ${c.statement})` : c.statement);
      L.push("");
      L.push("Evidence:");
      for (const e of c.evidence) L.push(`- ${evidenceLine(e)}`);
      if (c.applies_to_paths?.length) L.push(`- applies to: ${c.applies_to_paths.join(", ")}`);
      const adr = adrs.find((a) => a.candidate_ids.includes(c.id));
      if (adr) L.push(`- ADR draft: ${adr.file ?? `ADR-${String(adr.number).padStart(4, "0")} (not written)`}`);
      L.push("");
      L.push("Policy block (edit before use):");
      L.push("```yaml");
      L.push(YAML.stringify(c.policy_block).trimEnd());
      L.push("```");
      if (c.suggested_hidden_test) {
        const t = c.suggested_hidden_test;
        L.push("");
        L.push(`Hidden-test draft from \`${t.from}\`${t.standalone ? " (self-contained: imports, fixtures and class setup included)" : " (INCOMPLETE, see notes)"}; move it under \`benchmarks/hidden_tests/${out.policy_id}/invariants/\` and make sure it checks behaviour, not names only this change introduces:`);
        for (const n of t.notes) L.push(`- note: ${n}`);
        L.push("```python");
        L.push(t.source.trimEnd());
        L.push("```");
      }
    }
  }
  L.push("");
  return L.join("\n");
}

/** Paste-ready YAML with the candidate blocks grouped the way the policy file expects them. */
export function renderSuggestionsYaml(out: MinerOutput): string {
  const kept = out.candidates.filter((c) => !c.classification || c.classification.keep);
  const annotate = (c: Candidate) => ({ ...c.policy_block, _candidate: c.id, _score: c.score, _cluster: c.cluster, _confidence: c.confidence });
  const invariants = kept.filter((c) => c.kind === "invariant").map(annotate);
  const rules = kept.filter((c) => c.kind === "architecture_rule" || c.kind === "frozen_paths").map(annotate);
  const decisions = kept.filter((c) => c.kind === "decision").map(annotate);
  const filtered = out.candidates.filter((c) => c.classification && !c.classification.keep).map((c) => c.id);
  const header = [
    `# Policy suggestions for ${out.policy_id} — PROPOSALS, no authority. Generated by \`intentos suggest\` from ${out.head.slice(0, 12)}.`,
    `# Every block needs a real id (INV-/ARCH-/DEC-nnn), a person in approved_by, and sources that exist in the repository.`,
    `# Remove the _candidate/_score/_cluster/_confidence keys when pasting into policies/${out.policy_id}.yaml.`,
    ...(filtered.length ? [`# Set aside by classification (see policy-suggestions.md to rescue): ${filtered.join(", ")}`] : []),
    "",
  ];
  return header.join("\n") + YAML.stringify({ invariants, architecture_rules: rules, decisions });
}

// ---------------------------------------------------------------------------------------------------------------------
// Classification: Codex sorts, groups and rewrites candidates; it cannot add, delete or approve.

const CATEGORIES: Category[] = ["business_rule", "robustness_rule", "implementation_detail", "environment", "tooling", "duplicate"];

const CLASSIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "category", "keep", "reason", "rule", "cluster", "duplicate_of"],
        properties: {
          id: { type: "string" },
          category: { type: "string", enum: CATEGORIES },
          keep: { type: "boolean" },
          reason: { type: "string" },
          rule: { type: "string" },
          cluster: { type: "string" },
          duplicate_of: { type: ["string", "null"] },
        },
      },
    },
  },
};

function evidenceText(c: Candidate): string {
  const parts: string[] = [c.title, c.statement, ...(c.applies_to_paths ?? []), c.suggested_hidden_test?.source ?? ""];
  for (const e of c.evidence) for (const v of Object.values(e)) parts.push(Array.isArray(v) ? v.map(String).join(" ") : String(v ?? ""));
  return parts.join("\n");
}

/** `HeatBuilding` ~ `heat_building` ~ `heatbuilding`: the forms an identifier takes across Python names and file paths. */
function identifierForms(token: string): string[] {
  const snake = token.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return [...new Set([token.toLowerCase(), snake, snake.replace(/_/g, ""), snake.replace(/_/g, "-")])];
}

/** Identifier-like tokens (snake_case, dotted, CamelCase, paths, backticked) the rewrite uses must all appear in the evidence. */
export function rewriteSupported(rule: string, c: Candidate): { ok: boolean; missing: string[] } {
  const evidence = evidenceText(c).toLowerCase();
  const evidenceCompact = evidence.replace(/[_-]/g, "");
  const tokens = new Set<string>();
  for (const m of rule.matchAll(/`([^`]+)`/g)) tokens.add(m[1]!.trim());
  for (const m of rule.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[_.\/][A-Za-z0-9_.\/]+)+\b/g)) tokens.add(m[0]);
  for (const m of rule.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g)) tokens.add(m[0]);
  const all = [...tokens].filter((t) => t.length > 2);
  const supported = (t: string) => identifierForms(t).some((f) => evidence.includes(f)) || evidenceCompact.includes(t.toLowerCase().replace(/[_-]/g, ""));
  // a CamelCase name inside a dotted token (LockService in LockService.is_locked) is the same finding, not a second one
  const missing = all.filter((t) => !supported(t)).filter((t, _, arr) => !arr.some((o) => o !== t && o.includes(t)));
  return { ok: missing.length === 0, missing };
}

export function buildClassifyPrompt(candidates: Candidate[]): string {
  const L: string[] = [];
  L.push("You are sorting policy candidates mined from a repository. Each candidate came from a commit, a test, a document, an ADR or an import relationship, and the evidence is listed. Decide what each one IS; a person decides later what to approve.");
  L.push("Categories:");
  L.push("- business_rule: a statement about what the system's outputs or state must satisfy in the domain's own terms (e.g. holidays use the Sunday profile; a locked contract never gets a discount).");
  L.push("- robustness_rule: a statement about behaviour at edge cases or invalid input (e.g. zero demand yields a zero profile; negative factors warn).");
  L.push("- implementation_detail: how something is done (a merge, an index, a data path), not what must stay true.");
  L.push("- environment: dependency versions, packaging, installation, file locations.");
  L.push("- tooling: formatting, linting, CI, documentation.");
  L.push("- duplicate: the same rule as another candidate in this list (name it in duplicate_of).");
  L.push("Rules:");
  L.push("- Use ONLY the evidence given. Never invent behaviour. If the evidence does not support a rule, mark keep=false with the reason.");
  L.push("- keep=true only for business_rule and robustness_rule that are specific enough to test.");
  L.push("- rule: ONE sentence in rule form using the repository's own terms, stating what must hold (not what was fixed). Use only identifiers, file names and terms that appear in the evidence; otherwise keep the original statement verbatim.");
  L.push("- cluster: a short lowercase slug naming the rule group (candidates expressing the same rule share it).");
  L.push("- Return a verdict for every id below, in the same order, and no other ids.");
  L.push("");
  L.push("## Candidates");
  for (const c of candidates) {
    L.push(`### ${c.id} (${c.kind}; score ${Number(c.score ?? 0).toFixed(2)}; cluster hint \`${c.cluster ?? "misc"}\`)`);
    L.push(`statement: ${c.statement}`);
    for (const e of c.evidence) L.push(`- ${evidenceLine(e)}`);
    if (c.applies_to_paths?.length) L.push(`- applies to: ${c.applies_to_paths.join(", ")}`);
    const body = testBodyExcerpt(c);
    if (body) {
      L.push("- what the test checks:");
      L.push("```python");
      L.push(body);
      L.push("```");
    }
  }
  return L.join("\n");
}

/** The test function itself (not its fixtures), capped, so the classifier sees the assertion and not just the name. */
export function testBodyExcerpt(c: Candidate, maxLines = 18): string | null {
  const src = c.suggested_hidden_test?.source;
  const name = c.suggested_hidden_test?.from.split("::").pop();
  if (!src || !name) return null;
  const lines = src.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^\\s*(?:async\\s+)?def\\s+${name}\\s*\\(`).test(l));
  if (start < 0) return null;
  const indent = (lines[start]!.match(/^\s*/)?.[0] ?? "").length;
  const out: string[] = [lines[start]!];
  for (let i = start + 1; i < lines.length && out.length < maxLines; i++) {
    const l = lines[i]!;
    if (l.trim() && (l.match(/^\s*/)?.[0] ?? "").length <= indent) break;
    out.push(l);
  }
  return redact(out.map((l) => l.slice(indent)).join("\n")) + (out.length >= maxLines ? "\n    …" : "");
}

async function classifyCandidates(engine: CodingEngine, repoPath: string, candidates: Candidate[], log: (line: string) => void): Promise<SuggestResult["classification"]> {
  const stats: SuggestResult["classification"] = { used: true, model: null, usage: null, classified: 0, kept: 0, filtered: 0, rewrites_rejected: 0, note: null };
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const usages: unknown[] = [];
  for (let i = 0; i < candidates.length; i += 20) {
    const batch = candidates.slice(i, i + 20);
    log(`classifying ${batch[0]!.id}…${batch[batch.length - 1]!.id} (${batch.length} candidates)…`);
    const result = await engine.plan({ cwd: repoPath, prompt: redact(buildClassifyPrompt(batch)), outputSchema: CLASSIFY_SCHEMA });
    stats.model = result.model ?? stats.model;
    if (result.usage) usages.push(result.usage);
    let parsed: { verdicts?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(result.text) as { verdicts?: Array<Record<string, unknown>> };
    } catch {
      stats.note = `${stats.note ? stats.note + "; " : ""}batch starting ${batch[0]!.id}: no parseable JSON, left unclassified`;
      continue;
    }
    const offered = new Set(batch.map((c) => c.id));
    for (const v of parsed.verdicts ?? []) {
      const id = String(v.id ?? "");
      const c = byId.get(id);
      if (!c || !offered.has(id) || c.classification) continue; // unknown id, or a second verdict for the same candidate: ignored
      const category = CATEGORIES.includes(v.category as Category) ? (v.category as Category) : "implementation_detail";
      let keep = Boolean(v.keep) && (category === "business_rule" || category === "robustness_rule");
      const duplicateOf = typeof v.duplicate_of === "string" && offered.has(v.duplicate_of) && v.duplicate_of !== id ? v.duplicate_of : null;
      if (category === "duplicate" && !duplicateOf) keep = false;
      const proposed = typeof v.rule === "string" ? v.rule.trim().slice(0, 400) : "";
      let rule: string | null = null;
      let ruleRejected: string | null = null;
      if (proposed && proposed !== c.statement) {
        const check = rewriteSupported(proposed, c);
        if (check.ok) rule = proposed;
        else {
          ruleRejected = `uses ${check.missing.join(", ")} which the evidence does not mention`;
          stats.rewrites_rejected++;
        }
      }
      c.classification = { category, keep, reason: String(v.reason ?? "").slice(0, 300), rule, rule_rejected: ruleRejected, cluster: String(v.cluster ?? c.cluster).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40) || c.cluster, duplicate_of: duplicateOf };
      if (rule) c.policy_block = { ...c.policy_block, statement: rule };
      stats.classified++;
      if (keep) stats.kept++;
      else stats.filtered++;
    }
  }
  stats.usage = usages.length === 1 ? usages[0] : usages.length ? usages : null;
  return stats;
}


function nextAdrNumber(dir: string): number {
  if (!fs.existsSync(dir)) return 1;
  let max = 0;
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^ADR-(\d{4})/i);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "decision";
}

/** ADR draft from one or more candidates; `text` comes from Codex when synthesis ran, otherwise it is assembled from the evidence. */
export function renderAdr(number: number, title: string, candidates: Candidate[], text: { context: string; decision: string; consequences: string } | null, policyId: string): string {
  const L: string[] = [];
  L.push(`# ADR-${String(number).padStart(4, "0")}: ${title}`);
  L.push("");
  L.push("Status: Proposed");
  L.push(`Date: ${nowIso().slice(0, 10)}`);
  L.push(`Derived-from: ${candidates.map((c) => c.id).join(", ")} (intentos suggest${text ? ", text synthesised by Codex" : ""})`);
  L.push("");
  L.push("## Context");
  L.push("");
  if (text) L.push(text.context.trim());
  else {
    L.push("Evidence found in the repository (not yet reviewed by a person):");
    for (const c of candidates) for (const e of c.evidence) L.push(`- ${evidenceLine(e)}`);
  }
  L.push("");
  L.push("## Decision");
  L.push("");
  L.push(text ? text.decision.trim() : candidates.map((c) => c.statement).join(" "));
  L.push("");
  L.push("## Consequences");
  L.push("");
  if (text) L.push(text.consequences.trim());
  else {
    L.push(`Once accepted, the corresponding block in \`policies/${policyId}.yaml\` makes this binding for every change:`);
    L.push("");
    L.push("```yaml");
    for (const c of candidates) L.push(YAML.stringify(c.policy_block).trimEnd());
    L.push("```");
  }
  L.push("");
  L.push("This record was generated as a proposal. Change `Status` to `Accepted` only after a person has verified the evidence and edited the decision.");
  L.push("");
  return L.join("\n");
}

interface CodexAdr {
  candidate_ids: string[];
  title: string;
  context: string;
  decision: string;
  consequences: string;
}

const ADR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["adrs"],
  properties: {
    adrs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidate_ids", "title", "context", "decision", "consequences"],
        properties: {
          candidate_ids: { type: "array", items: { type: "string" } },
          title: { type: "string" },
          context: { type: "string" },
          decision: { type: "string" },
          consequences: { type: "string" },
        },
      },
    },
  },
};

export function buildAdrSynthesisPrompt(candidates: Candidate[]): string {
  const L: string[] = [];
  L.push("You are drafting Architecture Decision Records (ADRs) for this repository from evidence that was mined deterministically.");
  L.push("Rules:");
  L.push("- Use ONLY the evidence listed below. Do not invent behaviour, history or rationale. If the evidence is too thin for a record, leave that candidate out.");
  L.push("- Group candidates that express the same rule into one ADR; list every candidate id it is based on in candidate_ids.");
  L.push("- Context: what the evidence shows (cite the commit, test, document or import). Decision: ONE sentence a test could verify. Consequences: what future changes must respect.");
  L.push("- Plain prose, no markdown headings inside fields. Every ADR you emit is a proposal a person will review.");
  L.push("");
  L.push("## Candidates");
  for (const c of candidates) {
    L.push(`### ${c.id} (${c.kind}, ${c.confidence})`);
    L.push(`statement: ${c.statement}`);
    for (const e of c.evidence) L.push(`- ${evidenceLine(e)}`);
    if (c.applies_to_paths?.length) L.push(`- applies to: ${c.applies_to_paths.join(", ")}`);
  }
  return L.join("\n");
}

async function synthesizeAdrs(engine: CodingEngine, repoPath: string, candidates: Candidate[]): Promise<{ adrs: CodexAdr[]; dropped: number; model: string | null; usage: unknown; note: string | null }> {
  const prompt = redact(buildAdrSynthesisPrompt(candidates));
  const result = await engine.plan({ cwd: repoPath, prompt, outputSchema: ADR_SCHEMA });
  let parsed: { adrs?: CodexAdr[] };
  try {
    parsed = JSON.parse(result.text) as { adrs?: CodexAdr[] };
  } catch {
    return { adrs: [], dropped: 0, model: result.model, usage: result.usage, note: "Codex returned no parseable JSON; deterministic ADR drafts were used" };
  }
  const known = new Set(candidates.map((c) => c.id));
  const adrs: CodexAdr[] = [];
  let dropped = 0;
  for (const a of parsed.adrs ?? []) {
    const ids = Array.isArray(a.candidate_ids) ? a.candidate_ids.filter((id) => typeof id === "string") : [];
    if (!ids.length || ids.some((id) => !known.has(id)) || !a.title || !a.decision) {
      dropped++; // an ADR that cites evidence we never gave it is exactly the fabrication this guard exists for
      continue;
    }
    adrs.push({ candidate_ids: [...new Set(ids)], title: String(a.title).slice(0, 120), context: String(a.context ?? "").slice(0, 4000), decision: String(a.decision).slice(0, 1000), consequences: String(a.consequences ?? "").slice(0, 4000) });
  }
  return { adrs, dropped, model: result.model, usage: result.usage, note: dropped ? `${dropped} model ADR(s) dropped for citing unknown or missing evidence` : null };
}

export async function suggestPolicy(repoInput: string, opts: SuggestOptions, log: (line: string) => void = () => {}): Promise<SuggestResult> {
  const repoPath = path.resolve(repoInput);
  if (!fs.existsSync(repoPath) || !isGitRepo(repoPath)) throw new Error(`${repoPath} is not a Git repository`);
  const paths = ensureHome(resolvePaths());
  const repoId = repoIdFor(repoPath);
  const probe = runProbe(repoPath);
  const policyId = policyIdFor(probe, repoPath, opts.policyId);
  log(`mining ${repoPath} (commits, tests, documents, imports, changelog)…`);
  const outDirEarly = path.resolve(opts.outDir ?? path.join(paths.home, "onboard", repoId));
  const feedbackFile = opts.feedbackFile ?? path.join(outDirEarly, "feedback.json");
  const mined = runMiner(repoPath, policyId, opts.maxCommits ?? 500, feedbackFile);
  const threshold = CONFIDENCE_RANK[opts.minConfidence ?? "low"];
  mined.candidates = mined.candidates.filter((c) => CONFIDENCE_RANK[c.confidence] <= threshold && c.score >= (opts.minScore ?? 0));
  if (fs.existsSync(feedbackFile)) log(`ranking uses reviewer feedback from ${feedbackFile}`);
  mined.counts = Object.fromEntries(["invariant", "architecture_rule", "frozen_paths", "decision"].map((k) => [k, mined.candidates.filter((c) => c.kind === k).length]));
  const warnings = [...mined.warnings];
  log(`${mined.candidates.length} candidate(s): ${Object.entries(mined.counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);

  // Classification: the model sorts, groups and rewrites the top candidates; verdicts are validated against the evidence.
  let classification: SuggestResult["classification"] = { used: false, model: null, usage: null, classified: 0, kept: 0, filtered: 0, rewrites_rejected: 0, note: null };
  if (opts.classify && mined.candidates.length) {
    const top = mined.candidates.slice(0, opts.classifyTop ?? 40);
    const engine = opts.engine ?? new LiveCodexEngine();
    try {
      classification = await classifyCandidates(engine, repoPath, top, log);
      log(`classified ${classification.classified}: kept ${classification.kept}, set aside ${classification.filtered}${classification.rewrites_rejected ? `, ${classification.rewrites_rejected} rewrite(s) rejected` : ""}`);
    } catch (e) {
      classification.note = `classification failed (${(e as Error).message}); candidates left unclassified`;
      warnings.push(classification.note);
    }
  }

  // ADR drafts: for kept candidates that have no document of their own yet (commit/test/import/history evidence), high or medium confidence.
  const adrCandidates = mined.candidates.filter((c) => c.kind !== "decision" && c.confidence !== "low" && (!c.classification || c.classification.keep) && !c.evidence.some((e) => e.type === "doc" || e.type === "adr")).slice(0, 12);
  const codex: SuggestResult["codex"] = { used: false, model: null, usage: null, dropped: 0, note: null };
  let groups: Array<{ title: string; ids: string[]; text: { context: string; decision: string; consequences: string } | null }> = adrCandidates.map((c) => ({ title: c.title, ids: [c.id], text: null }));
  if (opts.withCodex && adrCandidates.length) {
    log(`asking Codex to draft ${adrCandidates.length} ADR(s) from the mined evidence (read-only thread)…`);
    const engine = opts.engine ?? new LiveCodexEngine();
    try {
      const synth = await synthesizeAdrs(engine, repoPath, adrCandidates);
      codex.used = true;
      codex.model = synth.model;
      codex.usage = synth.usage;
      codex.dropped = synth.dropped;
      codex.note = synth.note;
      if (synth.adrs.length) {
        const covered = new Set(synth.adrs.flatMap((a) => a.candidate_ids));
        groups = [...synth.adrs.map((a) => ({ title: a.title, ids: a.candidate_ids, text: { context: a.context, decision: a.decision, consequences: a.consequences } })), ...adrCandidates.filter((c) => !covered.has(c.id)).map((c) => ({ title: c.title, ids: [c.id], text: null }))];
      }
    } catch (e) {
      codex.note = `Codex synthesis failed (${(e as Error).message}); deterministic ADR drafts were used`;
      warnings.push(codex.note);
    }
  }
  const adrDir = opts.writeAdrs ? path.resolve(opts.adrDir ?? path.join(repoPath, "docs", "decisions")) : null;
  let number = adrDir ? nextAdrNumber(adrDir) : 1;
  const adrs: AdrDraft[] = [];
  const byId = new Map(mined.candidates.map((c) => [c.id, c]));
  for (const g of groups) {
    const cands = g.ids.map((id) => byId.get(id)!).filter(Boolean);
    const markdown = renderAdr(number, g.title, cands, g.text, policyId);
    let file: string | null = null;
    if (adrDir) {
      fs.mkdirSync(adrDir, { recursive: true });
      file = path.join(adrDir, `ADR-${String(number).padStart(4, "0")}-${slug(g.title)}.md`);
      fs.writeFileSync(file, markdown);
    }
    adrs.push({ number, file, title: g.title, candidate_ids: g.ids, synthesized_by: g.text ? "codex" : "deterministic", markdown });
    number++;
  }
  if (adrDir) log(`${adrs.length} ADR draft(s) written to ${adrDir} (Status: Proposed)`);

  const outDir = path.resolve(opts.outDir ?? path.join(paths.home, "onboard", repoId));
  fs.mkdirSync(outDir, { recursive: true });
  const files = { json: path.join(outDir, "suggestions.json"), markdown: path.join(outDir, "policy-suggestions.md"), yaml: path.join(outDir, "policy-suggestions.yaml") };
  fs.writeFileSync(files.markdown, renderSuggestionsMarkdown(mined, adrs));
  fs.writeFileSync(files.yaml, renderSuggestionsYaml(mined));
  const result: SuggestResult = {
    repo_path: repoPath,
    repo_id: repoId,
    policy_id: policyId,
    head: mined.head || headSha(repoPath),
    candidates: mined.candidates,
    counts: mined.counts,
    files,
    adrs,
    adr_dir: adrDir,
    codex,
    classification,
    filtered_out: mined.candidates.filter((c) => c.classification && !c.classification.keep).map((c) => ({ id: c.id, title: c.title, category: c.classification!.category, reason: c.classification!.reason })),
    vocabulary: mined.vocabulary ?? [],
    warnings,
    next_steps: [
      `read ${files.markdown}; delete wrong candidates, edit the rest`,
      `paste accepted blocks from ${files.yaml} into policies/${policyId}.yaml with real ids and your name in approved_by`,
      ...(adrDir ? [`review the ADR drafts in ${adrDir}; set Status: Accepted on the ones you keep and commit them so the policy can cite them`] : [`re-run with --write-adrs to put ADR drafts (Status: Proposed) into the repository`]),
      `move hidden-test drafts under benchmarks/hidden_tests/${policyId}/invariants/ and re-run intentos index ${repoPath}`,
    ],
  };
  fs.writeFileSync(files.json, JSON.stringify(result, null, 2));
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Review feedback: what the reviewer accepted into the policy and what they left out, turned into term weights for the
// next ranking of this repository. The policy file is the ground truth; nothing here changes it.

export interface ReviewFeedback {
  recorded_at: string;
  policy_file: string;
  suggestions_file: string;
  accepted_ids: string[];
  rejected_ids: string[];
  accept_tokens: string[];
  reject_tokens: string[];
}

const FEEDBACK_STOP = new Set(["preserve", "behaviour", "established", "must", "never", "always", "only", "with", "without", "from", "into", "that", "this", "when", "then", "than", "have", "been", "were", "will", "does", "gets", "goes", "after", "before", "under", "over", "revision", "depends", "reverse", "modules", "import", "paths", "policy", "rule", "rules", "test", "tests", "data", "file", "files", "value", "values"]);

function feedbackTokens(c: Candidate): string[] {
  const words = `${c.title} ${c.statement}`.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [];
  return [...new Set(words.map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)).filter((w) => !FEEDBACK_STOP.has(w)))];
}

function overlap(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []);
  const tb = new Set(b.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

/** Decide which candidates of the last run made it into the policy, and derive accept/reject term weights for the next run. */
export function recordReviewFeedback(suggestionsFile: string, policyFile: string, outFile: string): ReviewFeedback {
  if (!fs.existsSync(suggestionsFile)) throw new Error(`${suggestionsFile} not found; run intentos suggest first`);
  if (!fs.existsSync(policyFile)) throw new Error(`${policyFile} not found; nothing has been approved yet`);
  const previous = JSON.parse(fs.readFileSync(suggestionsFile, "utf8")) as { candidates: Candidate[] };
  const policy = YAML.parse(fs.readFileSync(policyFile, "utf8")) as { invariants?: Array<{ statement?: string; verified_by?: string[]; sources?: Array<{ path?: string; heading?: string }> }>; architecture_rules?: Array<{ statement?: string; paths?: string[]; forbidden_modules?: string[] }>; decisions?: Array<{ statement?: string }> };
  const statements = [...(policy.invariants ?? []), ...(policy.architecture_rules ?? []), ...(policy.decisions ?? [])].map((e) => e.statement ?? "").filter(Boolean);
  const verifiedBy = new Set((policy.invariants ?? []).flatMap((i) => i.verified_by ?? []).map((p) => path.basename(p)));
  const headings = new Set((policy.invariants ?? []).flatMap((i) => (i.sources ?? []).map((s) => `${s.path ?? ""}#${s.heading ?? ""}`)));
  const ruleKeys = new Set((policy.architecture_rules ?? []).map((r) => `${(r.paths ?? []).join(",")}|${(r.forbidden_modules ?? []).join(",")}`));
  const accepted: Candidate[] = [];
  const rejected: Candidate[] = [];
  for (const c of previous.candidates) {
    const hidden = (c.policy_block.verified_by as string[] | undefined)?.[0];
    const hiddenBase = hidden ? path.basename(hidden).replace(/^test_inv_TODO_/, "") : null;
    const byTest = !!hiddenBase && [...verifiedBy].some((v) => v.includes(hiddenBase));
    const bySource = (c.sources ?? []).some((s) => headings.has(`${s.path}#${s.heading ?? ""}`));
    const byRule = !!c.rule && ruleKeys.has(`${((c.rule as { paths?: string[] }).paths ?? []).join(",")}|${((c.rule as { forbidden_modules?: string[] }).forbidden_modules ?? []).join(",")}`);
    const byStatement = statements.some((s) => overlap(s, c.classification?.rule ?? c.statement) >= 0.6);
    if (byTest || bySource || byRule || byStatement) accepted.push(c);
    else if (c.relevance !== "low" && (!c.classification || c.classification.keep)) rejected.push(c);
  }
  const acceptTokens = new Set(accepted.flatMap(feedbackTokens));
  const rejectCounts = new Map<string, number>();
  for (const c of rejected) for (const t of feedbackTokens(c)) if (!acceptTokens.has(t)) rejectCounts.set(t, (rejectCounts.get(t) ?? 0) + 1);
  const rejectTokens = [...rejectCounts.entries()].filter(([, n]) => n >= 2 || rejected.length <= 3).map(([t]) => t).sort();
  const feedback: ReviewFeedback = { recorded_at: nowIso(), policy_file: policyFile, suggestions_file: suggestionsFile, accepted_ids: accepted.map((c) => c.id), rejected_ids: rejected.map((c) => c.id), accept_tokens: [...acceptTokens].sort(), reject_tokens: rejectTokens };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(feedback, null, 2));
  return feedback;
}
