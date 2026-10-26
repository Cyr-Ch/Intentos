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
}

export interface MinerOutput {
  repo: string;
  head: string;
  policy_id: string;
  candidates: Candidate[];
  counts: Record<string, number>;
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
  warnings: string[];
  next_steps: string[];
}

const CONFIDENCE_RANK: Record<Candidate["confidence"], number> = { high: 0, medium: 1, low: 2 };

export function runMiner(repoPath: string, policyId: string, maxCommits = 500): MinerOutput {
  const script = path.join(resolvePaths().python, "policy_suggest.py");
  const res = spawnSync(resolvePython(), ["-I", script, repoPath, "--policy-id", policyId, "--max-commits", String(maxCommits)], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 300_000 });
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
  L.push(`Counts: ${Object.entries(out.counts).map(([k, v]) => `${k} ${v}`).join(", ")}${adrs.length ? `; ADR drafts: ${adrs.length}` : ""}.`);
  for (const w of out.warnings) L.push(`- warning: ${w}`);
  for (const level of ["high", "medium", "low"] as const) {
    const group = out.candidates.filter((c) => c.confidence === level);
    if (!group.length) continue;
    L.push("");
    L.push(`## ${level} confidence (${group.length})`);
    for (const c of group) {
      L.push("");
      L.push(`### ${c.id} · ${c.kind} · ${c.title}`);
      L.push("");
      L.push(c.statement);
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
  const invariants = out.candidates.filter((c) => c.kind === "invariant").map((c) => ({ ...c.policy_block, _candidate: c.id, _confidence: c.confidence }));
  const rules = out.candidates.filter((c) => c.kind === "architecture_rule" || c.kind === "frozen_paths").map((c) => ({ ...c.policy_block, _candidate: c.id, _confidence: c.confidence }));
  const decisions = out.candidates.filter((c) => c.kind === "decision").map((c) => ({ ...c.policy_block, _candidate: c.id, _confidence: c.confidence }));
  const header = [
    `# Policy suggestions for ${out.policy_id} — PROPOSALS, no authority. Generated by \`intentos suggest\` from ${out.head.slice(0, 12)}.`,
    `# Every block needs a real id (INV-/ARCH-/DEC-nnn), a person in approved_by, and sources that exist in the repository.`,
    `# Remove the _candidate/_confidence keys when pasting into policies/${out.policy_id}.yaml.`,
    "",
  ];
  return header.join("\n") + YAML.stringify({ invariants, architecture_rules: rules, decisions });
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
  const mined = runMiner(repoPath, policyId, opts.maxCommits ?? 500);
  const threshold = CONFIDENCE_RANK[opts.minConfidence ?? "low"];
  mined.candidates = mined.candidates.filter((c) => CONFIDENCE_RANK[c.confidence] <= threshold);
  mined.counts = Object.fromEntries(["invariant", "architecture_rule", "frozen_paths", "decision"].map((k) => [k, mined.candidates.filter((c) => c.kind === k).length]));
  const warnings = [...mined.warnings];
  log(`${mined.candidates.length} candidate(s): ${Object.entries(mined.counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);

  // ADR drafts: for candidates that have no document of their own yet (commit/test/import/history evidence), high or medium confidence.
  const adrCandidates = mined.candidates.filter((c) => c.kind !== "decision" && c.confidence !== "low" && !c.evidence.some((e) => e.type === "doc" || e.type === "adr")).slice(0, 12);
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
