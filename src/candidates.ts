import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { resolvePaths, resolvePython } from "./config.ts";
import { nowIso } from "./util/ids.ts";
import { redact } from "./util/redact.ts";

/**
 * Policy candidates and the evidence digest they are mined from.
 *
 * A candidate is a rule a model stated after reading the repository (the host agent through the
 * `intentos-policy-mining` skill, or IntentOS's independent side thread), checked and tested by `ingestProposals`.
 * Nothing here has authority: a candidate becomes policy only when a reviewer approves it.
 *
 * The evidence digest (`python/policy_evidence.py`) is what the model reads first: tests with their first assertion,
 * commits with the files and tests they touched, must/never sentences in documents, ADRs, import edges between
 * directories, stale directories, changelog deprecations. It selects nothing and ranks nothing.
 */

export interface CandidateEvidence {
  type: "commit" | "test" | "doc" | "adr" | "import" | "history" | "changelog" | string;
  ref: string;
  excerpt: string;
  path?: string | null;
  line?: number | null;
  [k: string]: unknown;
}

export type Level = "high" | "medium" | "low";
export type Category = "business_rule" | "robustness_rule";

/** A hidden-test draft: a complete test module (pytest or vitest/jest) that runs on its own from the hidden directory. */
export interface HiddenTestDraft {
  /** `path::test` of the lifted test, or `codex:<slug>` for a test the model wrote. */
  from: string;
  language: "python" | "typescript";
  imports: string;
  source: string;
  /** What the lift could not resolve (fixtures, class setup); empty when `standalone`. */
  notes: string[];
  standalone: boolean;
}

export interface Candidate {
  id: string;
  kind: "invariant" | "architecture_rule" | "frozen_paths" | "decision";
  title: string;
  statement: string;
  /** Business rule (a user or the business would notice its violation) or robustness rule (an engineer would). */
  category: Category;
  /** Why the model believes it is a rule of this repository: the reading, in one or two sentences. */
  rationale: string;
  confidence: Level;
  relevance: Level;
  evidence: CandidateEvidence[];
  applies_to_paths?: string[];
  scope?: string[];
  suggested_hidden_test?: HiddenTestDraft | null;
  rule?: Record<string, unknown>;
  status?: string;
  supersedes?: string | null;
  sources?: Array<{ path: string; heading?: string | null }>;
  policy_block: Record<string, unknown>;
  authored_by: "codex";
  rank: number;
}

/** Output of `policy_evidence.py --ingest`. */
export interface IngestOutput {
  repo: string;
  head: string;
  policy_id: string;
  language: "python" | "typescript" | "mixed";
  candidates: Candidate[];
  rejected: Array<{ title: string; reasons: string[] }>;
  counts: Record<string, number>;
  warnings: string[];
}

export interface DigestTest {
  ref: string;
  path: string;
  line: number;
  name: string;
  language: "python" | "typescript";
  describe?: string[];
  excerpt: string;
  rule_like: boolean;
  production_paths: string[];
}
export interface DigestCommit {
  sha: string;
  date: string;
  subject: string;
  body: string;
  source_files: string[];
  test_files: string[];
  tests_added: string[];
  looks_like_fix: boolean;
}
export interface DigestStatement {
  path: string;
  heading: string | null;
  line: number;
  sentence: string;
  format: "markdown" | "rst";
}
export interface DigestAdr {
  path: string;
  title: string;
  status: "approved" | "proposed" | "superseded" | "rejected";
  status_raw: string;
  decision: string;
  supersedes: string | null;
}
export interface DigestImportEdge {
  from_dir: string;
  to_dir: string;
  count: number;
  reverse_exists: boolean;
  examples: Array<{ path: string; line: number; imports: string }>;
}
export interface DigestStaleDir {
  dir: string;
  files: number;
  last_commit: string | null;
  repo_last_commit: string | null;
  name_suggests_legacy: boolean;
}
export interface DigestChangelogEntry {
  path: string;
  line: number;
  version: string | null;
  text: string;
}

/** A modal sentence from a docstring or comment in production code: what the author said must hold, at that line. */
export interface DigestCodeNote {
  ref: string;
  path: string;
  line: number;
  kind: "docstring" | "comment";
  symbol: string | null;
  sentence: string;
}
/** A resolved ticket from the synced precedents: what a user reported and the pull request that settled it. */
export interface DigestTicket {
  ref: string;
  number: number;
  title: string;
  excerpt: string;
  labels: string[];
  closed_at: string | null;
  pull: { number: number | null; title: string; merge_sha: string | null } | null;
  files: string[];
  symbols: string[];
  tests_added: string[];
  rule_like: boolean;
}

/** The evidence digest: raw facts, no selection. */
export interface EvidenceDigest {
  repo: string;
  head: string;
  policy_id: string;
  language: "python" | "typescript" | "mixed";
  source_dirs: string[];
  tests: DigestTest[];
  commits: DigestCommit[];
  documents: DigestStatement[];
  adrs: DigestAdr[];
  imports: DigestImportEdge[];
  stale_dirs: DigestStaleDir[];
  changelog: DigestChangelogEntry[];
  code_notes: DigestCodeNote[];
  tickets: DigestTicket[];
  /** `synced_at` of the precedents file the tickets came from (null when none was synced); part of the cache key. */
  precedents_synced_at?: string | null;
  counts: Record<string, number>;
  warnings: string[];
}

export const EVIDENCE_SCRIPT = "policy_evidence.py";

export function runDigest(repoPath: string, policyId: string, maxCommits = 300, precedentsFile?: string | null): EvidenceDigest {
  const script = path.join(resolvePaths().python, EVIDENCE_SCRIPT);
  const args = ["-I", script, repoPath, "--policy-id", policyId, "--max-commits", String(maxCommits)];
  if (precedentsFile) args.push("--precedents", precedentsFile);
  const res = spawnSync(resolvePython(), args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 300_000 });
  if (res.error) throw new Error(`evidence digest failed to start: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`evidence digest exited ${res.status}: ${(res.stderr ?? "").trim()}`);
  return JSON.parse(res.stdout) as EvidenceDigest;
}

/** The digest as the model reads it: compact text, every fact with the reference the model must cite back. */
export function renderDigest(d: EvidenceDigest, opts: { maxTests?: number; maxCommits?: number; maxStatements?: number; maxTickets?: number } = {}): string {
  const maxTests = opts.maxTests ?? 250;
  const maxCommits = opts.maxCommits ?? 120;
  const maxStatements = opts.maxStatements ?? 150;
  const maxTickets = opts.maxTickets ?? 80;
  const L: string[] = [];
  L.push(`Repository ${d.repo} at ${d.head.slice(0, 7)} (${d.language}); source directories: ${d.source_dirs.join(", ") || "(none)"}.`);
  L.push(`Counts: ${Object.entries(d.counts).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  for (const w of d.warnings) L.push(`warning: ${w}`);

  const tests = [...d.tests].sort((a, b) => Number(b.rule_like) - Number(a.rule_like));
  L.push("", `## Tests (${d.tests.length}; cite as test <path>::<name>; * marks a rule-like name)`);
  for (const t of tests.slice(0, maxTests)) L.push(`- ${t.rule_like ? "*" : " "} ${t.ref}${t.describe?.length ? ` [${t.describe.join(" > ")}]` : ""} (line ${t.line})${t.excerpt ? `: ${t.excerpt}` : ""}${t.production_paths.length ? ` → ${t.production_paths.join(", ")}` : ""}`);
  if (d.tests.length > maxTests) L.push(`- … ${d.tests.length - maxTests} more; read the test directories yourself`);

  const commits = [...d.commits].sort((a, b) => Number(b.looks_like_fix) - Number(a.looks_like_fix));
  L.push("", `## Commits (${d.commits.length} touching code; cite as commit <sha>; * marks a fix-like message)`);
  for (const c of commits.slice(0, maxCommits)) L.push(`- ${c.looks_like_fix ? "*" : " "} ${c.sha} ${c.date} ${c.subject}${c.body ? ` — ${c.body.slice(0, 160)}` : ""} [${c.source_files.slice(0, 4).join(", ")}${c.source_files.length > 4 ? ", …" : ""}]${c.tests_added.length ? ` tests added: ${c.tests_added.slice(0, 3).join(", ")}` : ""}`);
  if (d.commits.length > maxCommits) L.push(`- … ${d.commits.length - maxCommits} more in git log`);

  L.push("", `## Documents (${d.documents.length} must/never sentences; cite as doc <path>:<line>)`);
  for (const s of d.documents.slice(0, maxStatements)) L.push(`- ${s.path}:${s.line}${s.heading ? ` (${s.heading})` : ""}: ${s.sentence}`);
  if (d.documents.length > maxStatements) L.push(`- … ${d.documents.length - maxStatements} more`);

  L.push("", `## ADRs (${d.adrs.length}; cite as adr <path>)`);
  for (const a of d.adrs) L.push(`- ${a.path} [${a.status_raw}] ${a.title}${a.decision ? `: ${a.decision.slice(0, 240)}` : ""}${a.supersedes ? ` (supersedes ${a.supersedes})` : ""}`);

  L.push("", `## Import edges between directories (${d.imports.length}; cite as import <path>:<line>; ← marks an edge whose reverse also exists)`);
  for (const e of d.imports) L.push(`- ${e.from_dir} → ${e.to_dir} ×${e.count}${e.reverse_exists ? " ←" : ""} e.g. ${e.examples.map((x) => `${x.path}:${x.line}`).join(", ")}`);

  L.push("", `## Directories that look frozen (${d.stale_dirs.length}; cite as history <dir>)`);
  for (const s of d.stale_dirs) L.push(`- ${s.dir} (${s.files} files, last commit ${s.last_commit ?? "?"} vs repository ${s.repo_last_commit ?? "?"}${s.name_suggests_legacy ? ", legacy name" : ""})`);

  L.push("", `## Changelog entries announcing change (${d.changelog.length}; cite as changelog <path>:<line>)`);
  for (const c of d.changelog) L.push(`- ${c.path}:${c.line}${c.version ? ` [${c.version}]` : ""}: ${c.text}`);

  const notes = d.code_notes ?? [];
  L.push("", `## Code notes (${notes.length} must/never sentences in docstrings and comments of production code; cite as code <path>:<line>)`);
  for (const n of notes.slice(0, maxStatements)) L.push(`- ${n.ref}${n.symbol ? ` (${n.symbol})` : ""} [${n.kind}]: ${n.sentence}`);
  if (notes.length > maxStatements) L.push(`- … ${notes.length - maxStatements} more`);

  const tickets = [...(d.tickets ?? [])].sort((a, b) => Number(b.rule_like) - Number(a.rule_like));
  L.push("", `## Resolved tickets (${tickets.length}${tickets.length ? "" : "; run intentos precedents sync to add them"}; cite as ticket #<number>; * marks a rule-like title or body)`);
  for (const t of tickets.slice(0, maxTickets)) L.push(`- ${t.rule_like ? "*" : " "} ${t.ref} ${t.title}${t.closed_at ? ` (${t.closed_at})` : ""}${t.pull?.number ? ` → PR #${t.pull.number}${t.pull.merge_sha ? ` ${t.pull.merge_sha.slice(0, 7)}` : ""}` : ""}${t.files.length ? `; files ${t.files.slice(0, 4).join(", ")}${t.files.length > 4 ? "…" : ""}` : ""}${t.tests_added.length ? `; tests added ${t.tests_added.slice(0, 3).join(", ")}` : ""}${t.excerpt ? `: ${t.excerpt.slice(0, 200)}` : ""}`);
  if (tickets.length > maxTickets) L.push(`- … ${tickets.length - maxTickets} more; the precedents tool lists them`);
  return redact(L.join("\n"));
}

/** What a candidate list file carries besides the candidates. */
export interface CandidateList {
  repo: string;
  head: string;
  policy_id: string;
  candidates: Candidate[];
  counts: Record<string, number>;
  warnings: string[];
}

function evidenceLine(e: CandidateEvidence): string {
  const where = e.path ? `${e.path}${e.line ? `:${e.line}` : ""}` : "";
  return `${e.type} ${e.ref}${where && where !== e.ref ? ` (${where})` : ""}: ${redact(e.excerpt)}`;
}

/** Human-readable review document: one section per candidate with its evidence, the policy block and the hidden-test draft. */
export function renderCandidatesMarkdown(out: CandidateList, author: string): string {
  const L: string[] = [];
  L.push(`# Policy candidates for ${out.policy_id}`);
  L.push("");
  L.push(`Stated by ${author} from ${out.repo} at ${out.head.slice(0, 12)} on ${nowIso().slice(0, 10)}, checked and tested by IntentOS. **These are proposals with no authority.**`);
  L.push(`Review each one, delete what is wrong, edit the rest, and paste the blocks you accept into \`policies/${out.policy_id}.yaml\` with your name in \`approved_by\`.`);
  L.push("");
  L.push(`Counts: ${Object.entries(out.counts).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  for (const w of out.warnings) L.push(`- warning: ${w}`);
  for (const c of out.candidates) {
    L.push("");
    L.push(`## ${c.id} · ${c.kind} · ${c.title}`);
    L.push("");
    L.push(`${c.category.replace("_", " ")} · relevance ${c.relevance} · confidence ${c.confidence}`);
    L.push("");
    L.push(c.statement);
    if (c.rationale) L.push("", `Rationale: ${c.rationale}`);
    L.push("");
    L.push("Evidence:");
    for (const e of c.evidence) L.push(`- ${evidenceLine(e)}`);
    if (c.applies_to_paths?.length) L.push(`- applies to: ${c.applies_to_paths.join(", ")}`);
    L.push("");
    L.push("Policy block (edit before use):");
    L.push("```yaml");
    L.push(YAML.stringify(c.policy_block).trimEnd());
    L.push("```");
    if (c.suggested_hidden_test) {
      const t = c.suggested_hidden_test;
      L.push("");
      L.push(`Hidden test from \`${t.from}\`${t.standalone ? " (self-contained)" : " (INCOMPLETE, see notes)"}; it goes under \`benchmarks/hidden_tests/${out.policy_id}/invariants/\` when the candidate is approved:`);
      for (const n of t.notes) L.push(`- note: ${n}`);
      L.push(t.language === "typescript" ? "```ts" : "```python");
      L.push(t.source.trimEnd());
      L.push("```");
    }
  }
  L.push("");
  return L.join("\n");
}

/** Paste-ready YAML with the candidate blocks grouped the way the policy file expects them. */
export function renderCandidatesYaml(out: CandidateList): string {
  const annotate = (c: Candidate) => ({ ...c.policy_block, _candidate: c.id, _category: c.category, _confidence: c.confidence });
  const invariants = out.candidates.filter((c) => c.kind === "invariant").map(annotate);
  const rules = out.candidates.filter((c) => c.kind === "architecture_rule" || c.kind === "frozen_paths").map(annotate);
  const decisions = out.candidates.filter((c) => c.kind === "decision").map(annotate);
  const header = [
    `# Policy candidates for ${out.policy_id} — PROPOSALS, no authority. Checked by IntentOS at ${out.head.slice(0, 12)}.`,
    `# Every block needs a real id (INV-/ARCH-/DEC-nnn), a person in approved_by, and sources that exist in the repository.`,
    `# Remove the _candidate/_category/_confidence keys when pasting into policies/${out.policy_id}.yaml.`,
    "",
  ];
  return header.join("\n") + YAML.stringify({ invariants, architecture_rules: rules, decisions });
}

/** Read a candidate list file written by `ingestProposals` (null when there is none). */
export function readCandidateFile<T = unknown>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}
