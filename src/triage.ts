import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { LiveCodexEngine, type CodingEngine } from "./codex/adapter.ts";
import { ensureHome, resolvePaths } from "./config.ts";
import { repoIdFor } from "./knowledge/indexer.ts";
import { loadIndexedRepo, type IndexedRepo } from "./knowledge/repo.ts";
import type { Policy } from "./knowledge/policy.ts";
import { buildEvidencePack, type EvidencePack } from "./knowledge/retrieval.ts";
import type { KnowledgeStore } from "./knowledge/storage.ts";
import type { PrecedentAttributes } from "./knowledge/precedents.ts";
import { renderEvidencePack } from "./reports/explain.ts";
import { git, isGitRepo, trackedFiles } from "./util/git.ts";
import { nowIso } from "./util/ids.ts";
import { redact } from "./util/redact.ts";
import { appendRoleSkills, captureAgentSnapshot } from "./agent-skills.ts";

/**
 * Ticket QA: is a ticket specified well enough for the planner to write a contract and for a coding agent to
 * implement it without guessing?
 *
 * A side thread (read-only, in the repository) gets the ticket, its labels and comments, the evidence pack from the
 * index (symbols, tests, documents, approved invariants and decisions, deterministic conflicts, precedents) and a few
 * facts IntentOS computed about the ticket itself, and answers with findings as structured output. Every finding is
 * a gap the ticket leaves, and either the repository fills it (`filled`, with evidence) or only the team can
 * (`ask`, with the question, the options and the default). A contradiction between the ticket and what the
 * repository knows (an approved invariant, a decision, a document, a test asserting the opposite, how a precedent
 * settled the same point) is a finding of kind `contradiction`, always a question.
 *
 * IntentOS trusts none of it until checked: every evidence reference must exist at the current revision (file, symbol,
 * test, policy id, precedent number, commit); a detail "filled from the repository" without a verifiable reference is
 * sent back once and, if still unbacked, becomes a question for the team instead of a fact in the ticket. The verdict
 * follows from the findings that survive, not from the model's own word.
 *
 * Labels carry the workflow: `unfinished` → (this agent) → `ready for planning` → (the planner) → `planned` → the
 * coding agent. The agent never touches a `planned` ticket unless forced, and never sets `planned` itself.
 */

export const TRIAGE_FILE_VERSION = 1;

export interface TriageLabels {
  unfinished: string;
  ready: string;
  planned: string;
}
export const DEFAULT_LABELS: TriageLabels = { unfinished: "unfinished", ready: "ready for planning", planned: "planned" };

export type Stage = "none" | "unfinished" | "ready" | "planned";
export type Verdict = "ready" | "needs_input" | "already_done";
export type Resolution = "filled" | "ask";
export const FINDING_KINDS = ["acceptance_criteria", "scope", "interface", "behaviour", "edge_case", "unknown_reference", "contradiction", "already_done", "other"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];
export const TRIAGE_EVIDENCE_TYPES = ["code", "test", "doc", "policy", "decision", "precedent", "commit", "ticket"] as const;
export type TriageEvidenceType = (typeof TRIAGE_EVIDENCE_TYPES)[number];

export interface TriageEvidence {
  type: TriageEvidenceType;
  ref: string;
  excerpt: string;
}

export interface TriageFinding {
  id: string;
  kind: FindingKind;
  title: string;
  /** What the ticket leaves open, or what it contradicts. */
  detail: string;
  resolution: Resolution;
  /** The text that completes the ticket (resolution `filled`). */
  filled: string | null;
  /** For `filled`: where the answer comes from. For `contradiction`: the knowledge the ticket contradicts. */
  evidence: TriageEvidence[];
  /** For `ask`: the question, written so one answer closes the gap. */
  question: string | null;
  options: string[];
  suggested_default: string | null;
  /** The planner cannot proceed without the answer. */
  blocking: boolean;
  /** What IntentOS verified or changed about this finding. */
  checks: string[];
}

export interface TicketComment {
  author: string | null;
  created_at: string | null;
  body: string;
}

export interface TicketInput {
  id: string;
  title: string | null;
  body: string;
  labels: string[];
  comments: TicketComment[];
  url: string | null;
  source: { kind: "text" } | { kind: "file"; file: string } | { kind: "github"; repo: string; number: number };
}

export interface TicketReference {
  name: string;
  found: "symbol" | "file" | "test" | "none";
}

export interface TicketSignals {
  words: number;
  has_acceptance_criteria: boolean;
  has_examples: boolean;
  references: TicketReference[];
  matched_symbols: number;
  matched_tests: number;
  invariants_in_scope: string[];
  conflicts: string[];
  precedents: Array<{ number: number; title: string; staleness: string; relevance: number }>;
  stage: Stage;
}

export interface TriageRound {
  round: number;
  proposed: number;
  accepted: number;
  rejected: Array<{ id: string; title: string; reasons: string[] }>;
  usage: unknown;
}

export interface LabelPlan {
  current: string[];
  add: string[];
  remove: string[];
}

export interface PostOutcome {
  comment_url: string | null;
  labels_added: string[];
  labels_removed: string[];
}

export interface TriageResult {
  version: number;
  repo_path: string;
  repo_id: string;
  policy_id: string;
  head: string;
  ticket: { id: string; title: string | null; url: string | null; labels: string[]; source: TicketInput["source"] };
  stage: Stage;
  model: string | null;
  engine: string;
  thread_id: string | null;
  verdict: Verdict;
  /** What the model said before IntentOS reconciled the verdict with the surviving findings. */
  model_verdict: Verdict;
  summary: string;
  findings: TriageFinding[];
  completed_ticket: string;
  signals: TicketSignals;
  rounds: TriageRound[];
  notes: string[];
  labels: LabelPlan;
  dir: string;
  report_file: string;
  posted: PostOutcome | null;
  generated_at: string;
}

export interface TriageOptions {
  /** Model for the side thread; default INTENTOS_TRIAGE_MODEL, then INTENTOS_MINING_MODEL, then the session's model. */
  model?: string | null;
  reasoningEffort?: string | null;
  /** Rounds at most, the first included (default 2: one answer, one fix of what was rejected). */
  rounds?: number;
  engine?: CodingEngine;
  store: KnowledgeStore;
  outDir?: string;
  labels?: Partial<TriageLabels>;
  /** Triage a ticket that is already `planned` (its plan may be stale). */
  force?: boolean;
}

// ---- labels and stage ---------------------------------------------------------

export function resolveLabels(partial?: Partial<TriageLabels>): TriageLabels {
  return { ...DEFAULT_LABELS, ...Object.fromEntries(Object.entries(partial ?? {}).filter(([, v]) => typeof v === "string" && v.trim())) };
}

const sameLabel = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export function stageOf(labels: string[], cfg: TriageLabels = DEFAULT_LABELS): Stage {
  if (labels.some((l) => sameLabel(l, cfg.planned))) return "planned";
  if (labels.some((l) => sameLabel(l, cfg.ready))) return "ready";
  if (labels.some((l) => sameLabel(l, cfg.unfinished))) return "unfinished";
  return "none";
}

/** Which labels the verdict adds and removes. `planned` is never touched here: only the planner sets or clears it. */
export function labelPlan(verdict: Verdict, current: string[], cfg: TriageLabels = DEFAULT_LABELS): LabelPlan {
  const has = (l: string) => current.some((c) => sameLabel(c, l));
  const add: string[] = [];
  const remove: string[] = [];
  if (verdict === "ready") {
    if (!has(cfg.ready)) add.push(cfg.ready);
    if (has(cfg.unfinished)) remove.push(cfg.unfinished);
  } else {
    // needs_input and already_done: the ticket as written is not ready for a plan; the team decides what it becomes.
    if (!has(cfg.unfinished)) add.push(cfg.unfinished);
    if (has(cfg.ready)) remove.push(cfg.ready);
  }
  return { current: [...current], add, remove };
}

// ---- deterministic signals about the ticket -----------------------------------

interface RepoLookup {
  files: Set<string>;
  symbols: Set<string>;
  /** Bare symbol names (last segment of a qualified name). */
  bareNames: Set<string>;
  tests: Set<string>;
  precedents: Set<number>;
}

function buildLookup(store: KnowledgeStore, indexed: IndexedRepo): RepoLookup {
  const files = new Set(trackedFiles(indexed.repoPath));
  const symbols = new Set<string>();
  const bareNames = new Set<string>();
  for (const n of store.nodes(indexed.repo.id, indexed.revision, "symbol")) {
    if (!n.qualified_name) continue;
    symbols.add(n.qualified_name);
    bareNames.add(n.qualified_name.split(".").pop()!);
  }
  const tests = new Set<string>();
  for (const n of store.nodes(indexed.repo.id, indexed.revision, "test")) if (n.qualified_name) tests.add(n.qualified_name);
  const precedents = new Set<number>();
  for (const n of store.nodes(indexed.repo.id, indexed.revision, "precedent")) {
    try {
      precedents.add((JSON.parse(n.attributes_json) as PrecedentAttributes).number);
    } catch {
      /* a malformed row is not a precedent anyone can cite */
    }
  }
  return { files, symbols, bareNames, tests, precedents };
}

const CRITERIA_WORDS = /\b(should|must|shall|expected|acceptance|given|when|then|returns?|raises?)\b/gi;
const EXAMPLE_WORDS = /(```|\be\.g\.|for example|example:|for instance)/i;
const STOP_WORDS = new Set(["e.g", "i.e", "etc", "vs", "a.k.a"]);

/** Names the ticket mentions: backticked tokens, dotted names, snake_case words; checked against the index and the tree. */
export function ticketReferences(text: string, lookup: Pick<RepoLookup, "files" | "symbols" | "bareNames" | "tests">): TicketReference[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) names.add(m[1]!.trim().replace(/\(.*\)$/, "").replace(/^[-$]\s*/, ""));
  for (const m of text.matchAll(/\b([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)+)\b/g)) names.add(m[1]!);
  for (const m of text.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) names.add(m[1]!);
  const fileBase = new Map<string, number>();
  for (const f of lookup.files) fileBase.set(path.basename(f), (fileBase.get(path.basename(f)) ?? 0) + 1);
  const out: TicketReference[] = [];
  for (const raw of names) {
    const name = raw.replace(/^\.\//, "");
    if (!name || STOP_WORDS.has(name.toLowerCase()) || /^\d/.test(name) || /\.(com|org|io|net|dev|edu|gov)$/i.test(name)) continue;
    const bare = name.includes("::") ? name.split("::").pop()! : name.split(".").pop()!;
    let found: TicketReference["found"] = "none";
    if (lookup.files.has(name) || fileBase.has(name)) found = "file";
    else if (lookup.tests.has(name) || (bare.startsWith("test_") && [...lookup.tests].some((t) => t.endsWith(`::${bare}`)))) found = "test";
    else if (lookup.symbols.has(name) || lookup.bareNames.has(bare)) found = "symbol";
    out.push({ name, found });
    if (out.length >= 40) break;
  }
  return out;
}

export function ticketSignals(ticket: TicketInput, pack: EvidencePack, lookup: RepoLookup, cfg: TriageLabels): TicketSignals {
  const text = ticketText(ticket);
  return {
    words: text.split(/\s+/).filter(Boolean).length,
    // A list, or several sentences in the should/must/when/then register; one "should" in prose is not a criterion.
    has_acceptance_criteria: /^\s*(?:[-*]|\d+\.)\s+\S/m.test(ticket.body) || (ticket.body.match(CRITERIA_WORDS) ?? []).length >= 3,
    has_examples: EXAMPLE_WORDS.test(ticket.body),
    references: ticketReferences(text, lookup),
    matched_symbols: pack.reusable_symbols.length,
    matched_tests: pack.tests.length,
    invariants_in_scope: pack.invariants.map((i) => i.id),
    conflicts: pack.conflicts.map((c) => `${c.kind}: ${c.summary}`),
    precedents: pack.precedents.slice(0, 5).map((p) => ({ number: p.number, title: p.title, staleness: p.staleness, relevance: p.relevance })),
    stage: stageOf(ticket.labels, cfg),
  };
}

export const ticketText = (t: TicketInput): string => [t.title, t.body].filter((s): s is string => !!s && !!s.trim()).join("\n\n").trim();

// ---- the side thread's contract ------------------------------------------------

/** Strict structured output: every field present, null or empty where it does not apply. */
export const TRIAGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings", "completed_ticket"],
  properties: {
    verdict: { type: "string", enum: ["ready", "needs_input", "already_done"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "title", "detail", "resolution", "filled", "evidence", "question", "options", "suggested_default", "blocking"],
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: [...FINDING_KINDS] },
          title: { type: "string" },
          detail: { type: "string" },
          resolution: { type: "string", enum: ["filled", "ask"] },
          filled: { type: ["string", "null"] },
          evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["type", "ref", "excerpt"], properties: { type: { type: "string", enum: [...TRIAGE_EVIDENCE_TYPES] }, ref: { type: "string" }, excerpt: { type: "string" } } } },
          question: { type: ["string", "null"] },
          options: { type: "array", items: { type: "string" } },
          suggested_default: { type: ["string", "null"] },
          blocking: { type: "boolean" },
        },
      },
    },
    completed_ticket: { type: "string" },
  },
};

export function buildTriagePrompt(a: { repoPath: string; policyId: string; ticket: TicketInput; pack: EvidencePack; signals: TicketSignals; labels: TriageLabels }): string {
  const t = a.ticket;
  const L: string[] = [];
  L.push("# IntentOS ticket QA");
  L.push("");
  L.push(`You check whether a ticket for the repository at ${a.repoPath} (IntentOS policy \`${a.policyId}\`, ticket \`${t.id}\`) is specified well enough that a planner can write an implementation contract from it and a coding agent can implement it without guessing. You are in a read-only sandbox in the repository: read the code, the tests, the documents, run git log and git show; modify nothing.`);
  L.push("");
  L.push(`Workflow the labels carry: \`${a.labels.unfinished}\` → you → \`${a.labels.ready}\` → the planner → \`${a.labels.planned}\` → the coding agent. Your answer decides whether this ticket moves to \`${a.labels.ready}\` or stays \`${a.labels.unfinished}\` with questions for the team.`);
  L.push("");
  L.push("## The ticket");
  L.push("");
  if (t.title) L.push(`Title: ${t.title}`);
  if (t.labels.length) L.push(`Labels: ${t.labels.join(", ")}`);
  if (t.url) L.push(`URL: ${t.url}`);
  L.push("");
  L.push(t.body.trim() || "(empty body)");
  if (t.comments.length) {
    L.push("");
    L.push(`### Comments (${t.comments.length}; the team may already have answered something here)`);
    for (const c of t.comments.slice(-20)) {
      L.push("");
      L.push(`— ${c.author ?? "someone"}${c.created_at ? ` on ${c.created_at.slice(0, 10)}` : ""}:`);
      L.push(c.body.trim().split("\n").map((l) => `  ${l}`).join("\n"));
    }
  }
  L.push("");
  L.push("## What to produce");
  L.push("");
  L.push("A list of findings. A finding is a gap: something the planner or the implementer would have to guess (what exactly happens, for which inputs, through which interface, what stays unchanged, how it is verified), a name the ticket uses that the repository does not have, a contradiction, or the fact that the repository already does what is asked. It is not an improvement you would like; stay with what the ticket asks for.");
  L.push("");
  L.push("For every gap, first look for the answer in the repository: the code and its docstrings, the tests (they say what holds today), the documents, the approved invariants and decisions below, the resolved precedents (how the same question was settled before), the git history.");
  L.push("- `filled`: the repository answers it. Put the detail that completes the ticket in `filled` and cite the evidence. Every reference is checked at the current revision; a filled detail with no reference that checks out comes back to you once and then becomes a question for the team, so cite precisely.");
  L.push("- `ask`: only the team can answer: a product choice, a name the ticket leaves open that no convention settles, a priority between goals, behaviour of a system you cannot see. Write `question` so that one answer closes the gap, list the `options` you see and the `suggested_default` you would take if nobody answers, and say in `detail` why it matters. `blocking` is true when the planner cannot write a sound contract without the answer.");
  L.push("- `contradiction`: the ticket asks for something that an approved invariant, a decision, a document with authority, a test asserting the opposite, or a precedent contradicts. Always `ask`, with the contradicting knowledge as evidence and a question asking which should win. An approved invariant or decision wins unless the team changes the policy; say so in the question.");
  L.push("- `already_done`: the repository already behaves as the ticket asks. Cite the test or code that proves it; the verdict is then `already_done`.");
  L.push("- `unknown_reference`: the ticket names a function, class, file, option or concept the repository does not have. Fill it when the ticket clearly means something that exists under another name; ask otherwise.");
  L.push("");
  L.push("Verdict: `ready` when no blocking question remains (non-blocking ones travel with the ticket as open points for the planner), `needs_input` when at least one does, `already_done` when the repository already does it. IntentOS recomputes the verdict from the findings that survive its checks.");
  L.push("");
  L.push("`completed_ticket`: the ticket rewritten complete, in Markdown, as the planner should receive it: title, context, requested behaviour, acceptance criteria as a checklist, what stays unchanged, out of scope. Filled details go inline; where a question is open, write `[TEAM: <finding id>]` at that point and nothing else. Keep the author's wording where it is precise.");
  L.push("");
  L.push("## Evidence references (checked at the current revision)");
  L.push("");
  L.push("- `code`: a repository-relative path (`app/domain/money.py`, optionally `:line`) or a dotted symbol name as the index lists it (`app.domain.money.Money.half`).");
  L.push("- `test`: `path::test_name` as the index lists it.");
  L.push("- `doc`: a repository-relative path, optionally `#heading`.");
  L.push("- `policy`: an `INV-` or `ARCH-` id from the policy below; `decision`: a `DEC-` id.");
  L.push("- `precedent`: `#<number>` of a resolved ticket listed below; `commit`: a sha from git log.");
  L.push("- `ticket`: a quote from the ticket itself (ref `ticket`), for the gap's own words; it never backs a filled detail on its own.");
  L.push("`excerpt` is the sentence or line that carries the fact, quoted, at most 300 characters.");
  L.push("");
  L.push('Output: a JSON object {"verdict": "ready|needs_input|already_done", "summary": "<two or three sentences for the team>", "findings": [{"id": "F1", "kind": "...", "title": "...", "detail": "...", "resolution": "filled|ask", "filled": "...|null", "evidence": [{"type": "...", "ref": "...", "excerpt": "..."}], "question": "...|null", "options": ["..."], "suggested_default": "...|null", "blocking": true|false}], "completed_ticket": "<markdown>"} and nothing else. Ids F1, F2, … in the order a reader should meet them (contradictions and blocking questions first).');
  L.push("");
  L.push("## What IntentOS found before asking you (facts, not conclusions)");
  L.push("");
  const s = a.signals;
  L.push(`- ${s.words} words; ${s.has_acceptance_criteria ? "has a list or several sentences that read like criteria" : "no list and hardly a sentence that reads like an acceptance criterion"}; ${s.has_examples ? "has an example" : "no example"}.`);
  const unknown = s.references.filter((r) => r.found === "none");
  const known = s.references.filter((r) => r.found !== "none");
  if (known.length) L.push(`- Names the ticket uses that exist in the repository: ${known.map((r) => `${r.name} (${r.found})`).join(", ")}.`);
  if (unknown.length) L.push(`- Names the ticket uses that the index does not know (a new thing the ticket introduces, a typo, or a concept under another name; decide which): ${unknown.map((r) => r.name).join(", ")}.`);
  L.push(`- The index matched ${s.matched_symbols} symbol(s) and ${s.matched_tests} test(s) to the ticket's terms${s.matched_symbols === 0 ? " — the ticket may be too vague to locate, or about something new" : ""}.`);
  if (s.invariants_in_scope.length) L.push(`- Approved invariants in scope: ${s.invariants_in_scope.join(", ")} (the verifier enforces them whatever the ticket says).`);
  for (const c of s.conflicts) L.push(`- Deterministic conflict: ${c}`);
  if (s.precedents.length) L.push(`- Closest resolved tickets: ${s.precedents.map((p) => `#${p.number} "${p.title}" (${p.staleness}, relevance ${p.relevance})`).join("; ")}.`);
  L.push(`- Workflow stage from the labels: ${s.stage}.`);
  L.push("");
  L.push("## Evidence pack from the index (starting points; read the code behind them)");
  L.push("");
  L.push(renderEvidencePack(a.pack));
  return redact(L.join("\n"));
}

export function buildTriageFixPrompt(rejected: TriageRound["rejected"], head: string): string {
  const L: string[] = [];
  L.push(`IntentOS checked your findings at ${head.slice(0, 7)} and could not accept ${rejected.length}:`);
  L.push("");
  for (const r of rejected) L.push(`- ${r.id} ${r.title}: ${r.reasons.join(" | ")}`);
  L.push("");
  L.push('Fix what can be fixed: a reference that exists at the current revision (read the file, find the test or symbol as the index names it), a question for a finding you cannot back with evidence (then it is the team\'s to answer, not a fact), the missing field. Return only the fixed findings with the same ids, in the same JSON shape ({"verdict": ..., "summary": ..., "findings": [...], "completed_ticket": ...}; verdict, summary and completed_ticket may repeat what you sent), and an empty findings list if none can be fixed. Do not resend the accepted ones.');
  return L.join("\n");
}

interface RawAnswer {
  verdict: Verdict;
  summary: string;
  findings: Array<Omit<TriageFinding, "checks">>;
  completed_ticket: string;
}

function parseAnswer(text: string): RawAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("the model's answer is not JSON");
    parsed = JSON.parse(m[0]);
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  const verdict: Verdict = o.verdict === "ready" || o.verdict === "already_done" ? o.verdict : "needs_input";
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const findings = (Array.isArray(o.findings) ? o.findings : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f, i) => ({
      id: str(f.id) ?? `F${i + 1}`,
      kind: (FINDING_KINDS as readonly string[]).includes(String(f.kind)) ? (f.kind as FindingKind) : "other",
      title: str(f.title) ?? str(f.detail)?.slice(0, 80) ?? `finding ${i + 1}`,
      detail: str(f.detail) ?? "",
      resolution: (f.resolution === "filled" ? "filled" : "ask") as Resolution,
      filled: str(f.filled),
      evidence: (Array.isArray(f.evidence) ? f.evidence : [])
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && typeof e.ref === "string")
        .map((e) => ({ type: ((TRIAGE_EVIDENCE_TYPES as readonly string[]).includes(String(e.type)) ? e.type : "code") as TriageEvidenceType, ref: String(e.ref).trim(), excerpt: (str(e.excerpt) ?? "").slice(0, 300) })),
      question: str(f.question),
      options: Array.isArray(f.options) ? f.options.filter((x): x is string => typeof x === "string" && !!x.trim()) : [],
      suggested_default: str(f.suggested_default),
      blocking: f.blocking !== false,
    }));
  return { verdict, summary: str(o.summary) ?? "", findings, completed_ticket: str(o.completed_ticket) ?? "" };
}

// ---- checks: nothing the model says about the repository is taken on its word ----

interface CheckContext {
  repoPath: string;
  policy: Policy;
  lookup: RepoLookup;
}

/** Why a reference does not check out at the current revision, or null when it does. */
export function checkEvidence(e: TriageEvidence, ctx: CheckContext): string | null {
  const ref = e.ref.trim().replace(/^\.\//, "");
  if (!ref) return "empty reference";
  switch (e.type) {
    case "ticket":
      return null;
    case "code": {
      const p = ref.split(":")[0]!;
      if (ctx.lookup.files.has(p)) return null;
      if (ctx.lookup.symbols.has(ref)) return null;
      const bare = ref.split(".").pop()!;
      if (!ref.includes("/") && ctx.lookup.bareNames.has(bare) && [...ctx.lookup.symbols].some((s) => s === ref || s.endsWith(`.${ref}`))) return null;
      return `code ${ref}: no such file or symbol at the current revision`;
    }
    case "test": {
      if (ctx.lookup.tests.has(ref)) return null;
      const file = ref.split("::")[0]!;
      const name = ref.split("::").slice(1).join("::");
      if (name && [...ctx.lookup.tests].some((t) => t.endsWith(`::${name}`) && (t.startsWith(file) || path.basename(t.split("::")[0]!) === path.basename(file)))) return null;
      if (!name && ctx.lookup.files.has(file)) return null;
      return `test ${ref}: not in the index (use path::test_name as the index lists it)`;
    }
    case "doc": {
      const p = ref.split("#")[0]!;
      return ctx.lookup.files.has(p) ? null : `doc ${ref}: no such file at the current revision`;
    }
    case "policy": {
      const id = ref.match(/\b((?:INV|ARCH)-\d{3,})\b/)?.[1];
      if (!id) return `policy ${ref}: not an INV- or ARCH- id`;
      const hit = id.startsWith("INV-") ? ctx.policy.invariants.some((i) => i.id === id) : ctx.policy.architecture_rules.some((r) => r.id === id);
      return hit ? null : `policy ${id}: not in policy ${ctx.policy.policy_id}`;
    }
    case "decision": {
      const id = ref.match(/\b(DEC-\d{3,})\b/)?.[1];
      if (!id) return `decision ${ref}: not a DEC- id`;
      return ctx.policy.decisions.some((d) => d.id === id) ? null : `decision ${id}: not in policy ${ctx.policy.policy_id}`;
    }
    case "precedent": {
      const n = Number(ref.match(/(?:#|issues\/|pull\/|^)(\d+)\s*$/)?.[1]);
      if (!Number.isFinite(n)) return `precedent ${ref}: not a ticket number`;
      return ctx.lookup.precedents.has(n) ? null : `precedent #${n}: not among the synced precedents`;
    }
    case "commit": {
      if (!/^[0-9a-f]{7,40}$/i.test(ref)) return `commit ${ref}: not a sha`;
      return git(ctx.repoPath, ["cat-file", "-e", `${ref}^{commit}`], { allowFail: true }).status === 0 ? null : `commit ${ref}: not in the local history`;
    }
    default:
      return `unknown evidence type ${String(e.type)}`;
  }
}

export interface FindingVerdict {
  finding: TriageFinding;
  /** Reasons the finding cannot be accepted as submitted (sent back to the model). */
  reasons: string[];
}

/** Check one finding: references that do not exist are dropped; a filled detail or contradiction without a surviving reference is rejected. */
export function checkFinding(raw: Omit<TriageFinding, "checks">, ctx: CheckContext): FindingVerdict {
  const checks: string[] = [];
  const reasons: string[] = [];
  const valid: TriageEvidence[] = [];
  const dropped: string[] = [];
  for (const e of raw.evidence) {
    const why = checkEvidence(e, ctx);
    if (why) {
      checks.push(`dropped reference: ${why}`);
      dropped.push(why);
    } else valid.push(e);
  }
  // A reference that does not exist is dropped; the finding is only sent back when nothing verifiable is left for it.
  const repoBacked = valid.filter((e) => e.type !== "ticket");
  const unbacked = (what: string) => `${what} without a reference that checks out (code, test, doc, policy, decision, precedent or commit)${dropped.length ? `: ${dropped.join("; ")}` : ""}`;
  if (raw.resolution === "filled") {
    if (!raw.filled) reasons.push("resolution is filled but `filled` is empty");
    if (!repoBacked.length) reasons.push(unbacked("filled from the repository"));
    else checks.push(`verified ${repoBacked.length} reference(s) at the current revision`);
  }
  if (raw.kind === "contradiction") {
    if (!repoBacked.length) reasons.push(unbacked("a contradiction needs the contradicting knowledge as evidence,"));
    if (raw.resolution !== "ask") reasons.push("a contradiction is always a question for the team (resolution ask)");
  }
  if (raw.kind === "already_done" && !repoBacked.some((e) => e.type === "test" || e.type === "code")) reasons.push("already_done needs the test or code that proves the behaviour exists");
  if (raw.resolution === "ask" && !raw.question) reasons.push("resolution is ask but `question` is empty");
  if (!raw.detail) reasons.push("`detail` is empty");
  return { finding: { ...raw, evidence: valid, checks }, reasons };
}

/** A finding still unbacked after the last round is kept as a question, never as a fact. */
export function downgradeToQuestion(f: TriageFinding, reasons: string[]): TriageFinding {
  const question = f.question ?? (f.kind === "already_done" ? `Does the repository already do this (${f.detail})? If so, this ticket can be closed.` : f.resolution === "filled" && f.filled ? `Confirm or correct: ${f.filled}` : `Please answer: ${f.detail}`);
  return {
    ...f,
    resolution: "ask",
    filled: null,
    question,
    blocking: f.kind === "already_done" ? true : f.blocking,
    checks: [...f.checks, `not verifiable after the last round (${reasons.join("; ")}); turned into a question for the team`],
  };
}

export function reconcileVerdict(modelVerdict: Verdict, findings: TriageFinding[]): { verdict: Verdict; notes: string[] } {
  const notes: string[] = [];
  const blocking = findings.filter((f) => f.resolution === "ask" && f.blocking);
  const done = findings.filter((f) => f.kind === "already_done" && f.resolution === "filled");
  let verdict: Verdict;
  if (done.length && !blocking.length) verdict = "already_done";
  else if (blocking.length) verdict = "needs_input";
  else verdict = "ready";
  if (modelVerdict === "already_done" && verdict !== "already_done") notes.push(done.length ? "the model said already done, but blocking questions remain" : "the model said already done without a verified test or code reference; the team must confirm");
  else if (modelVerdict === "ready" && verdict === "needs_input") notes.push(`the model said ready, but ${blocking.length} blocking question(s) remain: ${blocking.map((f) => f.id).join(", ")}`);
  else if (modelVerdict === "needs_input" && verdict === "ready") notes.push("the model said needs input, but no blocking question survived the checks");
  return { verdict, notes };
}

// ---- the report --------------------------------------------------------------------

export const VERDICT_LABEL: Record<Verdict, string> = { ready: "ready for planning", needs_input: "needs input from the team", already_done: "already done" };

export function renderTriageReport(r: TriageResult, cfg: TriageLabels = DEFAULT_LABELS): string {
  const L: string[] = [];
  const asks = r.findings.filter((f) => f.resolution === "ask" && f.kind !== "contradiction");
  const contradictions = r.findings.filter((f) => f.kind === "contradiction");
  const filled = r.findings.filter((f) => f.resolution === "filled");
  L.push(`## Ticket QA: ${VERDICT_LABEL[r.verdict]}`);
  L.push("");
  L.push(`_IntentOS triage by ${r.model ?? r.engine} at ${r.head.slice(0, 10)}, ${r.generated_at.slice(0, 16).replace("T", " ")}. Labels: ${r.labels.current.join(", ") || "none"}${r.labels.add.length || r.labels.remove.length ? ` → ${r.labels.add.map((l) => `+${l}`).concat(r.labels.remove.map((l) => `−${l}`)).join(" ")}` : " (unchanged)"}._`);
  L.push("");
  if (r.summary) {
    L.push(r.summary);
    L.push("");
  }
  if (contradictions.length) {
    L.push(`### Contradictions with what the repository knows (${contradictions.length})`);
    L.push("");
    for (const f of contradictions) L.push(...findingBlock(f));
  }
  if (asks.length) {
    const blocking = asks.filter((f) => f.blocking);
    const open = asks.filter((f) => !f.blocking);
    if (blocking.length) {
      L.push(`### Questions for the team (${blocking.length} blocking)`);
      L.push("");
      for (const f of blocking) L.push(...findingBlock(f));
    }
    if (open.length) {
      L.push(`### Open points the planner can carry (${open.length}, not blocking)`);
      L.push("");
      for (const f of open) L.push(...findingBlock(f));
    }
  }
  if (filled.length) {
    L.push(`### Filled in from the repository (${filled.length}, references verified at ${r.head.slice(0, 7)})`);
    L.push("");
    for (const f of filled) {
      L.push(`- **${f.id} ${f.title}** — ${f.filled}`);
      for (const e of f.evidence) L.push(`  - ${e.type} \`${e.ref}\`${e.excerpt ? `: ${e.excerpt}` : ""}`);
    }
    L.push("");
  }
  if (!r.findings.length) {
    L.push("No gaps found: the ticket names what changes, for which inputs, through which interface, and how it is verified.");
    L.push("");
  }
  if (r.completed_ticket.trim()) {
    L.push("### Proposed ticket text");
    L.push("");
    L.push(r.verdict === "ready" ? "The ticket as the planner will read it; edit the issue body if anything is off." : `Placeholders \`[TEAM: …]\` mark the answers still needed. Once answered, edit the issue body and remove the \`${cfg.unfinished}\` label, or run the QA again.`);
    L.push("");
    L.push(r.completed_ticket.trim());
    L.push("");
  }
  if (r.notes.length) {
    L.push("### Checks");
    L.push("");
    for (const n of r.notes) L.push(`- ${n}`);
    L.push("");
  }
  L.push(`<!-- intentos-triage repo=${r.repo_id} head=${r.head} verdict=${r.verdict} ticket=${r.ticket.id} -->`);
  return L.join("\n");
}

function findingBlock(f: TriageFinding): string[] {
  const L: string[] = [];
  L.push(`**${f.id} ${f.title}**${f.blocking && f.resolution === "ask" ? " (blocking)" : ""}`);
  if (f.detail) L.push(`${f.detail}`);
  if (f.evidence.length) for (const e of f.evidence) L.push(`- ${e.type} \`${e.ref}\`${e.excerpt ? `: ${e.excerpt}` : ""}`);
  if (f.question) L.push(`- **Question:** ${f.question}`);
  if (f.options.length) L.push(`- Options: ${f.options.map((o, i) => `(${String.fromCharCode(97 + i)}) ${o}`).join("; ")}`);
  if (f.suggested_default) L.push(`- Default if no answer: ${f.suggested_default}`);
  L.push("");
  return L;
}

// ---- GitHub: read the ticket, post the result ---------------------------------------

export type GhRunner = (args: string[], input?: string) => { status: number; stdout: string; stderr: string };

export function ghCli(bin = "gh"): GhRunner {
  return (args, input) => {
    const res = spawnSync(bin, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
    if (res.error) throw new Error(`gh failed to start: ${res.error.message} (install the GitHub CLI or pass --gh <path>)`);
    return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  };
}

function ghJson<T>(gh: GhRunner, args: string[], input?: string): T {
  const r = gh(["api", ...args], input);
  if (r.status !== 0) throw new Error(`gh api ${args.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ")} exited ${r.status}: ${r.stderr.trim().split("\n")[0] ?? ""}`);
  return (r.stdout.trim() ? JSON.parse(r.stdout) : null) as T;
}

/** `owner/name#12`, `https://github.com/owner/name/issues/12`, or `12` with a default repository. */
export function parseIssueRef(input: string, defaultRepo: string | null = null): { repo: string; number: number } {
  const s = input.trim();
  let m = s.match(/^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/);
  if (m) return { repo: m[1]!, number: Number(m[2]) };
  m = s.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (m) return { repo: m[1]!, number: Number(m[2]) };
  m = s.match(/^#?(\d+)$/);
  if (m && defaultRepo) return { repo: defaultRepo, number: Number(m[1]) };
  throw new Error(`cannot read an issue reference from "${input}": use owner/name#N, an issue URL, or N with --issues owner/name`);
}

export const githubTicketId = (repo: string, number: number): string => `${repo.split("/")[1]!.replace(/[^A-Za-z0-9._-]+/g, "-")}-${number}`;

export function readGithubIssue(ref: { repo: string; number: number }, gh: GhRunner = ghCli()): TicketInput {
  const issue = ghJson<{ number: number; html_url: string; title: string; body: string | null; labels: Array<{ name: string } | string>; state: string; pull_request?: unknown }>(gh, [`repos/${ref.repo}/issues/${ref.number}`]);
  if (!issue) throw new Error(`${ref.repo}#${ref.number}: not found`);
  if (issue.pull_request) throw new Error(`${ref.repo}#${ref.number} is a pull request, not a ticket`);
  let comments: TicketComment[] = [];
  try {
    const raw = ghJson<Array<{ user: { login: string } | null; created_at: string; body: string | null }>>(gh, ["--paginate", `repos/${ref.repo}/issues/${ref.number}/comments?per_page=100`]) ?? [];
    comments = raw.filter((c) => c.body && !/<!-- intentos-triage /.test(c.body)).map((c) => ({ author: c.user?.login ?? null, created_at: c.created_at ?? null, body: c.body!.slice(0, 4000) }));
  } catch {
    /* comments are context, not a requirement */
  }
  return { id: githubTicketId(ref.repo, ref.number), title: issue.title, body: issue.body ?? "", labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)), comments, url: issue.html_url, source: { kind: "github", repo: ref.repo, number: ref.number } };
}

/** Comment the report on the issue and move the workflow labels as the verdict says. `planned` is never added or removed. */
export function postTriage(result: TriageResult, gh: GhRunner = ghCli(), log: (line: string) => void = () => {}): PostOutcome {
  if (result.ticket.source.kind !== "github") throw new Error("only a GitHub issue can receive the result; read the ticket with --issue");
  const { repo, number } = result.ticket.source;
  const base = `repos/${repo}/issues/${number}`;
  const body = fs.readFileSync(result.report_file, "utf8");
  const comment = ghJson<{ html_url?: string }>(gh, ["--method", "POST", `${base}/comments`, "--input", "-"], JSON.stringify({ body }));
  log(`commented on ${repo}#${number}${comment?.html_url ? `: ${comment.html_url}` : ""}`);
  const added: string[] = [];
  const removed: string[] = [];
  for (const l of result.labels.remove) {
    const r = gh(["api", "--method", "DELETE", `${base}/labels/${encodeURIComponent(l)}`]);
    if (r.status === 0) removed.push(l);
    else log(`could not remove label "${l}": ${r.stderr.trim().split("\n")[0] ?? `exit ${r.status}`}`);
  }
  if (result.labels.add.length) {
    try {
      ghJson(gh, ["--method", "POST", `${base}/labels`, "--input", "-"], JSON.stringify({ labels: result.labels.add }));
      added.push(...result.labels.add);
    } catch (e) {
      log(`could not add label(s) ${result.labels.add.join(", ")}: ${(e as Error).message}`);
    }
  }
  if (added.length || removed.length) log(`labels: ${added.map((l) => `+${l}`).concat(removed.map((l) => `−${l}`)).join(" ")}`);
  return { comment_url: comment?.html_url ?? null, labels_added: added, labels_removed: removed };
}

// ---- ticket files -------------------------------------------------------------------

/** Tickets from a YAML list (benchmarks/demandlib/tickets.yaml shape: id, title, issue, labels). */
export function loadTicketsYaml(file: string): TicketInput[] {
  const data = YAML.parse(fs.readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
  if (!Array.isArray(data)) throw new Error(`${file} is not a list of tickets`);
  return data.map((t) => ({ id: String(t.id), title: t.title ? String(t.title) : null, body: String(t.issue ?? t.body ?? ""), labels: Array.isArray(t.labels) ? t.labels.map(String) : [], comments: [], url: null, source: { kind: "file", file } }));
}

// ---- the agent ----------------------------------------------------------------------

export function resolveTriageModel(explicit?: string | null): string | null {
  return explicit ?? process.env.INTENTOS_TRIAGE_MODEL ?? process.env.INTENTOS_MINING_MODEL ?? process.env.INTENTOS_CODEX_MODEL ?? null;
}

export async function triageTicket(repoInput: string, ticket: TicketInput, opts: TriageOptions, log: (line: string) => void = () => {}): Promise<TriageResult> {
  const repoPath = path.resolve(repoInput);
  if (!fs.existsSync(repoPath) || !isGitRepo(repoPath)) throw new Error(`${repoPath} is not a Git repository`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ticket.id)) throw new Error("ticket id must be a plain token (letters, digits, . _ -)");
  if (ticketText(ticket).length < 8) throw new Error("the ticket text is empty or too short");
  const cfg = resolveLabels(opts.labels);
  const stage = stageOf(ticket.labels, cfg);
  if (stage === "planned" && !opts.force) throw new Error(`${ticket.id} is labelled "${cfg.planned}": a plan exists for it. Re-triaging would invalidate that plan; pass --force if that is intended`);
  const paths = ensureHome(resolvePaths());
  const indexed = loadIndexedRepo(opts.store, repoPath);
  const policy = indexed.policy;
  const policyId = policy.policy_id.replace(/^fallback:/, "");
  const agentConfig = captureAgentSnapshot();
  const role = agentConfig.roles.triage;
  const model = resolveTriageModel(opts.model ?? role.model);
  const reasoning = opts.reasoningEffort ?? role.reasoning;
  if (!opts.engine && !model) throw new Error("no model named for ticket QA: pass --model <slug> or set INTENTOS_TRIAGE_MODEL (INTENTOS_MINING_MODEL and INTENTOS_CODEX_MODEL are taken as fallbacks)");
  const engine = opts.engine ?? new LiveCodexEngine({ model, reasoningEffort: reasoning });
  const dir = path.resolve(opts.outDir ?? path.join(paths.home, "triage", repoIdFor(repoPath), ticket.id));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agent_config.json"), JSON.stringify({ role: { ...role, model, reasoning }, captured_at: agentConfig.captured_at }, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "ticket.json"), JSON.stringify(ticket, null, 2) + "\n");

  const pack = buildEvidencePack(opts.store, indexed, ticketText(ticket));
  fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(pack, null, 2));
  const lookup = buildLookup(opts.store, indexed);
  const signals = ticketSignals(ticket, pack, lookup, cfg);
  const ctx: CheckContext = { repoPath, policy, lookup };
  log(`${ticket.id}: ${signals.words} words, ${signals.references.filter((r) => r.found === "none").length} unknown name(s), ${signals.matched_symbols} symbol(s) matched, ${signals.invariants_in_scope.length} invariant(s) in scope, ${signals.conflicts.length} conflict(s); asking ${model ?? engine.name}…`);

  const maxRounds = Math.max(1, Math.min(opts.rounds ?? 2, 4));
  let prompt = appendRoleSkills(buildTriagePrompt({ repoPath, policyId, ticket, pack, signals, labels: cfg }), role);
  let threadId: string | null = null;
  let resolvedModel: string | null = model;
  let engineName = engine.name;
  const rounds: TriageRound[] = [];
  const kept = new Map<string, TriageFinding>();
  const pending = new Map<string, { finding: TriageFinding; reasons: string[] }>();
  let modelVerdict: Verdict = "needs_input";
  let summary = "";
  let completed = "";
  for (let round = 1; round <= maxRounds; round++) {
    fs.writeFileSync(path.join(dir, `prompt-${round}.txt`), prompt);
    const res = await engine.plan({ cwd: repoPath, prompt, outputSchema: TRIAGE_SCHEMA, threadId, onThreadStarted: (id) => { threadId = id; } });
    threadId = res.threadId ?? threadId;
    resolvedModel = res.model ?? resolvedModel;
    engineName = res.engine;
    fs.writeFileSync(path.join(dir, `round-${round}.json`), res.text);
    const answer = parseAnswer(res.text);
    if (answer.summary) summary = answer.summary;
    if (answer.completed_ticket) completed = answer.completed_ticket;
    if (round === 1) modelVerdict = answer.verdict;
    const rejected: TriageRound["rejected"] = [];
    let accepted = 0;
    for (const raw of answer.findings) {
      if (round > 1 && !pending.has(raw.id) && kept.has(raw.id)) continue; // an accepted finding resent: the first version stands
      const v = checkFinding(raw, ctx);
      if (v.reasons.length) {
        pending.set(raw.id, v);
        rejected.push({ id: raw.id, title: raw.title, reasons: v.reasons });
      } else {
        kept.set(raw.id, v.finding);
        pending.delete(raw.id);
        accepted++;
      }
    }
    rounds.push({ round, proposed: answer.findings.length, accepted, rejected, usage: res.usage });
    log(`round ${round}: ${answer.findings.length} finding(s), ${accepted} accepted${rejected.length ? `, ${rejected.length} sent back: ${rejected.map((r) => `${r.id} (${r.reasons[0]})`).join("; ")}` : ""}`);
    if (!rejected.length || round === maxRounds) break;
    prompt = appendRoleSkills(buildTriageFixPrompt(rejected, indexed.revision), role);
  }
  const notes: string[] = [];
  for (const [id, p] of pending) {
    kept.set(id, downgradeToQuestion(p.finding, p.reasons));
    notes.push(`${id} could not be backed by the repository and is a question for the team`);
  }
  const order = (id: string) => Number(id.replace(/\D+/g, "")) || Number.MAX_SAFE_INTEGER;
  const findings = [...kept.values()].sort((a, b) => order(a.id) - order(b.id));
  const reconciled = reconcileVerdict(modelVerdict, findings);
  notes.push(...reconciled.notes);
  const verdict = reconciled.verdict;
  const labels = labelPlan(verdict, ticket.labels, cfg);
  if (stage === "planned") notes.push(`the ticket was "${cfg.planned}"; the plan should be redone if the ticket text changes`);
  const reportFile = path.join(dir, "report.md");
  const result: TriageResult = {
    version: TRIAGE_FILE_VERSION,
    repo_path: repoPath,
    repo_id: indexed.repo.id,
    policy_id: policyId,
    head: indexed.revision,
    ticket: { id: ticket.id, title: ticket.title, url: ticket.url, labels: ticket.labels, source: ticket.source },
    stage,
    model: resolvedModel,
    engine: engineName,
    thread_id: threadId,
    verdict,
    model_verdict: modelVerdict,
    summary,
    findings,
    completed_ticket: completed,
    signals,
    rounds,
    notes,
    labels,
    dir,
    report_file: reportFile,
    posted: null,
    generated_at: nowIso(),
  };
  fs.writeFileSync(reportFile, renderTriageReport(result, cfg) + "\n");
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2) + "\n");
  const asks = findings.filter((f) => f.resolution === "ask");
  log(`verdict: ${VERDICT_LABEL[verdict]}${verdict !== modelVerdict ? ` (the model said ${modelVerdict})` : ""}; ${findings.filter((f) => f.resolution === "filled").length} filled from the repository, ${asks.length} question(s) (${asks.filter((f) => f.blocking).length} blocking); report ${reportFile}`);
  return result;
}
