import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { PROJECT_ROOT, ensureHome, resolvePaths } from "./config.ts";
import type { KnowledgeStore } from "./knowledge/storage.ts";
import { indexRepository, repoIdFor, type IndexSummary } from "./knowledge/indexer.ts";
import { loadPolicyFile } from "./knowledge/policy.ts";
import type { Candidate, HiddenTestDraft } from "./candidates.ts";
import type { Author } from "./propose.ts";
import { nowIso } from "./util/ids.ts";

/**
 * `intentos review <repo>`: a local one-page UI to approve or reject policy candidates one by one.
 * Every approval lands where it belongs: the block goes into `policies/<id>.yaml` with a real id and the reviewer's
 * name (comments preserved), the hidden-test draft becomes a file under `benchmarks/hidden_tests/<id>/invariants/`,
 * and a candidate without a document source gets a section in `docs/intentos-policy.md` of the repository so the
 * policy can cite it. Rejections are recorded with their reason in review-decisions.json.
 * The server binds to 127.0.0.1 only and every API call needs the token baked into the page URL.
 */

export interface ReviewOptions {
  policyId?: string;
  outDir?: string;
  /** Policy file to append to (default `policies/<policy-id>.yaml`); must exist (run `intentos onboard` first). */
  policyFile?: string;
  /** Where hidden tests are written (default `benchmarks/hidden_tests`). */
  hiddenTestsRoot?: string;
  /** Repository-relative Markdown file that receives sections for candidates without a document source. */
  docFile?: string;
  /** Who approves (goes into `approved_by`). */
  by: string;
  store: KnowledgeStore;
  log?: (line: string) => void;
}

export interface AcceptResult {
  assigned_id: string;
  policy_file: string;
  hidden_test: string | null;
  hidden_test_complete: boolean;
  doc_section: { path: string; heading: string } | null;
  warnings: string[];
}

export interface Decision {
  id: string;
  title: string;
  /** `merge`: folded into another candidate's approval (its hidden test joined that invariant's `verified_by`). */
  action: "accept" | "reject" | "skip" | "merge";
  statement?: string;
  reason?: string;
  /** For `merge`: the candidate whose approval absorbed this one. */
  merged_into?: string;
  /** For `accept`: candidates folded into this approval. */
  merged_ids?: string[];
  by: string;
  at: string;
  result?: AcceptResult;
}

export interface FinishResult {
  accepted: number;
  merged: number;
  rejected: number;
  skipped: number;
  pending: number;
  assigned: string[];
  hidden_tests_needing_attention: string[];
  index: { mode: IndexSummary["mode"]; policy_id: string; unresolved_sources: IndexSummary["unresolved_sources"] } | null;
  index_error: string | null;
  decisions_file: string;
}

export interface ReviewState {
  repo_path: string;
  repo_id: string;
  policy_id: string;
  policy_file: string;
  suggestions_file: string;
  decisions_file: string;
  hidden_tests_dir: string;
  doc_file: string;
  by: string;
  candidates: Candidate[];
  decisions: Decision[];
  finished: FinishResult | null;
  /** Who authored the list: the host agent or the independent side thread (null for a list written before authors were recorded). */
  author: Author | null;
  opts: ReviewOptions;
}

export async function loadReviewState(repoInput: string, opts: ReviewOptions): Promise<ReviewState> {
  const repoPath = path.resolve(repoInput);
  const paths = ensureHome(resolvePaths());
  const repoId = repoIdFor(repoPath);
  const outDir = path.resolve(opts.outDir ?? path.join(paths.home, "onboard", repoId));
  const suggestionsFile = path.join(outDir, "suggestions.json");
  const notOnboarded = (file: string) => new Error(`${file} not found; run intentos onboard ${repoPath} first so there is a policy to append to`);
  if (opts.policyFile && !fs.existsSync(path.resolve(opts.policyFile))) throw notOnboarded(path.resolve(opts.policyFile));
  if (!fs.existsSync(suggestionsFile)) throw new Error(`no candidates for ${repoPath} yet: mine the rules first (follow the intentos-policy-mining skill and call propose, or run intentos mine), then review`);
  const previous = JSON.parse(fs.readFileSync(suggestionsFile, "utf8")) as { policy_id: string; candidates: Candidate[]; authored_by?: string; author?: Author };
  const policyId = opts.policyId ?? previous.policy_id;
  const policyFile = path.resolve(opts.policyFile ?? path.join(paths.policies, `${policyId}.yaml`));
  if (!fs.existsSync(policyFile)) throw notOnboarded(policyFile);
  const decisionsFile = path.join(outDir, "review-decisions.json");
  const decisions: Decision[] = fs.existsSync(decisionsFile) ? (JSON.parse(fs.readFileSync(decisionsFile, "utf8")) as Decision[]) : [];
  const candidates = previous.candidates;
  return {
    repo_path: repoPath,
    repo_id: repoId,
    policy_id: policyId,
    policy_file: policyFile,
    suggestions_file: suggestionsFile,
    decisions_file: decisionsFile,
    hidden_tests_dir: path.join(path.resolve(opts.hiddenTestsRoot ?? path.join(PROJECT_ROOT, "benchmarks", "hidden_tests")), policyId, "invariants"),
    doc_file: opts.docFile ?? "docs/intentos-policy.md",
    by: opts.by,
    candidates,
    decisions,
    finished: null,
    author: previous.authored_by === "codex" ? (previous.author ?? { via: "host", model: null }) : null,
    opts,
  };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50) || "rule";
}

/** Next free id with a prefix, scanning every list of the policy document. */
export function nextPolicyId(doc: YAML.Document, prefix: "INV" | "ARCH" | "DEC"): string {
  let max = 0;
  for (const key of ["invariants", "architecture_rules", "decisions"]) {
    const seq = doc.get(key);
    if (!YAML.isSeq(seq)) continue;
    for (const item of seq.items) {
      const id = YAML.isMap(item) ? String(item.get("id") ?? "") : "";
      const m = id.match(new RegExp(`^${prefix}-(\\d+)$`));
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

function appendToPolicy(policyFile: string, key: "invariants" | "architecture_rules" | "decisions", block: Record<string, unknown>): void {
  const before = fs.readFileSync(policyFile, "utf8");
  const doc = YAML.parseDocument(before);
  let seq = doc.get(key);
  if (!YAML.isSeq(seq)) {
    doc.set(key, doc.createNode([]));
    seq = doc.get(key);
  }
  const node = seq as YAML.YAMLSeq;
  node.flow = false;
  node.add(doc.createNode(block));
  fs.writeFileSync(policyFile, doc.toString({ lineWidth: 0 }));
  try {
    loadPolicyFile(policyFile);
  } catch (e) {
    fs.writeFileSync(policyFile, before);
    throw new Error(`the policy would not validate after adding ${String(block.id)}: ${(e as Error).message}`);
  }
}

/** Make sure `docs/intentos-policy.md` (or the configured file) in the repository has a section the policy can cite. */
function ensureDocSection(repoPath: string, docFile: string, heading: string, body: string, evidence: string[]): { path: string; heading: string; created: boolean } {
  const file = path.join(repoPath, docFile);
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (!text.trim()) text = "# IntentOS policy notes\n\nRules the trusted policy cites. Headings are stable identifiers: `policies/*.yaml` binds sections by heading, so edit the text, not the titles.\n";
  const exists = text.split("\n").some((l) => l.replace(/^#+\s*/, "").trim().toLowerCase() === heading.trim().toLowerCase() && /^#{1,6}\s/.test(l));
  if (!exists) {
    const section = [`## ${heading}`, "", body.trim(), "", ...(evidence.length ? ["Evidence recorded at approval:", ...evidence.map((e) => `- ${e}`), ""] : [])].join("\n");
    text = `${text.replace(/\s*$/, "")}\n\n${section}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return { path: docFile, heading, created: !exists };
}

/** Write the hidden test: `test_inv_001_<slug>.py` (pytest) or `inv_001_<slug>.test.ts` (vitest/jest), with a header saying where it came from. */
/** Two candidates are related when they govern a common production path or share a scope tag (the fold-related offer in hosts). */
export function relatedCandidates(a: Candidate, b: Candidate): boolean {
  const norm = (p: string) => p.replace(/\/\*\*$/, "");
  const pa = (a.applies_to_paths ?? []).map(norm);
  const pb = (b.applies_to_paths ?? []).map(norm);
  if (pa.some((x) => pb.some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)))) return true;
  const sa = new Set(a.scope ?? []);
  return (b.scope ?? []).some((t) => sa.has(t));
}

export function writeHiddenTest(dir: string, assignedId: string, title: string, draft: HiddenTestDraft): { file: string; complete: boolean } {
  fs.mkdirSync(dir, { recursive: true });
  const ts = draft.language === "typescript";
  const base = `${ts ? "" : "test_"}${assignedId.toLowerCase().replace("-", "_")}_${slug(title)}`;
  const ext = ts ? ".test.ts" : ".py";
  let file = path.join(dir, `${base}${ext}`);
  let n = 2;
  while (fs.existsSync(file)) file = path.join(dir, `${base}_${n++}${ext}`);
  const lines = [`Hidden invariant test for ${assignedId}: ${title}.`, "", `${draft.from.startsWith("codex:") ? "Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision" : `Lifted from ${draft.from}`} by intentos review. Hidden tests run from the verification snapshot and must check behaviour`, "through interfaces the task description implies, never names only one change introduces.", ...(draft.notes.length ? ["", "TODO before relying on this test:", ...draft.notes.map((n) => `- ${n}`)] : [])];
  const header = ts ? ["/**", ...lines.map((l) => ` * ${l}`.trimEnd()), " */", ""] : ['"""' + lines[0], ...lines.slice(1), '"""', ""];
  fs.writeFileSync(file, header.join("\n") + draft.source.trimEnd() + "\n");
  return { file, complete: draft.standalone };
}

/**
 * Apply an approval: policy block with a real id, hidden test file(s), document section. `merged` are related invariant
 * candidates folded into the same rule: each contributes its hidden test, paths, scope and sources to the one entry.
 * Throws (and leaves the policy untouched) when the result would not validate.
 */
export function acceptCandidate(state: ReviewState, c: Candidate, statement: string | undefined, by: string, merged: Candidate[] = []): AcceptResult {
  const warnings: string[] = [];
  const text = (statement ?? c.statement).trim();
  if (!text) throw new Error("a rule needs a statement");
  if (merged.length && (c.kind !== "invariant" || merged.some((m) => m.kind !== "invariant"))) throw new Error("only invariant candidates can be folded into one approval");
  const group = [c, ...merged];
  const doc = YAML.parseDocument(fs.readFileSync(state.policy_file, "utf8"));
  const evidence = group.flatMap((g) => g.evidence.map((e) => `${e.type} ${e.ref}: ${e.excerpt}`.slice(0, 200))).slice(0, 12);
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];
  const docSources = uniq(group.flatMap((g) => (g.sources ?? []).filter((s) => s.path.toLowerCase().endsWith(".md") && s.heading).map((s) => JSON.stringify({ path: s.path, heading: s.heading })))).map((j) => JSON.parse(j) as { path: string; heading: string });
  let docSection: AcceptResult["doc_section"] = null;
  const sources: Array<{ path: string; heading?: string }> = [...docSources];
  if (!sources.length && c.kind !== "decision") {
    const body = merged.length ? `${text}\n\nCovers: ${group.map((g) => g.title).join("; ")}.` : text;
    const section = ensureDocSection(state.repo_path, state.doc_file, c.title, body, evidence);
    docSection = { path: section.path, heading: section.heading };
    sources.push({ path: section.path, heading: section.heading });
    if (section.created) warnings.push(`added section "${section.heading}" to ${section.path} in the repository; commit it so the policy can bind it`);
  }
  let assigned: string;
  let hiddenTest: AcceptResult["hidden_test"] = null;
  let hiddenComplete = true;
  if (c.kind === "invariant") {
    assigned = nextPolicyId(doc, "INV");
    const verifiedBy: string[] = [];
    for (const g of group) {
      if (!g.suggested_hidden_test) continue;
      const written = writeHiddenTest(state.hidden_tests_dir, assigned, g.title, g.suggested_hidden_test);
      hiddenTest = hiddenTest ?? written.file;
      hiddenComplete = hiddenComplete && written.complete;
      verifiedBy.push(path.relative(PROJECT_ROOT, written.file).split(path.sep).join("/"));
      if (!written.complete) warnings.push(`hidden test ${path.basename(written.file)} is not self-contained; see its TODO header`);
    }
    if (!verifiedBy.length) warnings.push("no hidden test: the invariant is shown to the planner and implementer but the verifier cannot execute it (listed under unverified areas)");
    if (merged.length) warnings.push(`folded ${merged.map((m) => m.id).join(", ")} into this rule: ${verifiedBy.length} hidden test(s) on one invariant`);
    appendToPolicy(state.policy_file, "invariants", { id: assigned, statement: text, scope: uniq(group.flatMap((g) => g.scope ?? [])), applies_to_paths: uniq(group.flatMap((g) => g.applies_to_paths ?? [])), authority: "approved_policy", approved_by: by, sources, verified_by: verifiedBy, enforcement: "blocking" });
  } else if (c.kind === "architecture_rule" || c.kind === "frozen_paths") {
    assigned = nextPolicyId(doc, "ARCH");
    const rule = (c.rule ?? {}) as { kind?: string; paths?: string[]; forbidden_modules?: string[] };
    const block: Record<string, unknown> = { id: assigned, kind: rule.kind ?? "forbidden_import", statement: text, paths: rule.paths ?? c.applies_to_paths ?? [], authority: "approved_policy", approved_by: by, sources, enforcement: "blocking", scope: c.scope ?? [] };
    if (rule.forbidden_modules?.length) block.forbidden_modules = rule.forbidden_modules;
    if (!(block.paths as string[]).length) throw new Error("an architecture rule needs at least one path glob");
    appendToPolicy(state.policy_file, "architecture_rules", block);
  } else {
    assigned = nextPolicyId(doc, "DEC");
    const block: Record<string, unknown> = { id: assigned, statement: text, status: c.status ?? "approved", scope: c.scope ?? [], approved_by: by, sources: (c.sources ?? []).map((s) => (s.heading ? { path: s.path, heading: s.heading } : { path: s.path })) };
    if (c.supersedes) warnings.push(`"supersedes: ${c.supersedes}" was not carried over: point it at the DEC id of the superseded decision once both are in the policy`);
    appendToPolicy(state.policy_file, "decisions", block);
  }
  return { assigned_id: assigned, policy_file: state.policy_file, hidden_test: hiddenTest, hidden_test_complete: hiddenComplete, doc_section: docSection, warnings };
}

function saveDecisions(state: ReviewState): void {
  fs.mkdirSync(path.dirname(state.decisions_file), { recursive: true });
  fs.writeFileSync(state.decisions_file, JSON.stringify(state.decisions, null, 2));
}

const settled = (state: ReviewState, id: string): Decision | undefined => state.decisions.find((d) => d.id === id && (d.action === "accept" || d.action === "merge"));

export function decide(state: ReviewState, input: { id: string; action: "accept" | "reject" | "skip"; statement?: string; reason?: string; merge_ids?: string[] }): Decision {
  const c = state.candidates.find((x) => x.id === input.id);
  if (!c) throw new Error(`unknown candidate ${input.id}`);
  if (state.finished) throw new Error("this review is finished; start a new one");
  const existing = settled(state, input.id);
  if (existing) throw new Error(existing.action === "accept" ? `${input.id} was already approved as ${existing.result?.assigned_id}` : `${input.id} was folded into ${existing.merged_into}`);
  const decision: Decision = { id: c.id, title: c.title, action: input.action, by: state.by, at: nowIso() };
  const mergedDecisions: Decision[] = [];
  if (input.action === "accept") {
    const mergeIds = [...new Set((input.merge_ids ?? []).filter((m) => m !== c.id))];
    const merged = mergeIds.map((m) => {
      const cand = state.candidates.find((x) => x.id === m);
      if (!cand) throw new Error(`unknown candidate ${m} in merge_ids`);
      const prior = settled(state, m);
      if (prior) throw new Error(`${m} is already ${prior.action === "accept" ? `approved as ${prior.result?.assigned_id}` : `folded into ${prior.merged_into}`}`);
      return cand;
    });
    decision.statement = (input.statement ?? c.statement).trim();
    decision.result = acceptCandidate(state, c, decision.statement, state.by, merged);
    decision.merged_ids = merged.map((m) => m.id);
    for (const m of merged) mergedDecisions.push({ id: m.id, title: m.title, action: "merge", merged_into: decision.result.assigned_id, by: state.by, at: decision.at });
  } else if (input.action === "reject") decision.reason = (input.reason ?? "").trim().slice(0, 300);
  const touched = new Set([c.id, ...mergedDecisions.map((d) => d.id)]);
  state.decisions = [...state.decisions.filter((d) => !touched.has(d.id)), decision, ...mergedDecisions];
  saveDecisions(state);
  return decision;
}

export interface AutoApproveResult {
  approved: Array<{ id: string; title: string; assigned_id: string; hidden_test: string | null }>;
  /** Invariant candidates without a hidden test: left pending, since an unverifiable rule would only confuse the verifier. */
  without_test: Array<{ id: string; title: string }>;
  failed: Array<{ id: string; title: string; error: string }>;
  finish: FinishResult;
  policy_file: string;
  by: string;
}

/**
 * Approve every pending candidate without a person in the loop: the policy file, the hidden tests and the repository's
 * policy notes are written as the review UI would write them, `approved_by` records who mined the rules
 * (`auto:<model>`), and the caller tells the user where the file is so any rule can be edited or removed.
 * An approved rule carries blocking authority, so a wrong one stops every run in its scope until the file is edited.
 */
export function autoApprove(state: ReviewState, opts: { requireTest?: boolean } = {}): AutoApproveResult {
  const result: AutoApproveResult = { approved: [], without_test: [], failed: [], finish: null as unknown as FinishResult, policy_file: state.policy_file, by: state.by };
  for (const c of state.candidates) {
    if (state.decisions.some((d) => d.id === c.id && d.action !== "skip")) continue;
    if (c.kind === "invariant" && !c.suggested_hidden_test && opts.requireTest !== false) {
      result.without_test.push({ id: c.id, title: c.title });
      state.decisions = [...state.decisions.filter((d) => d.id !== c.id), { id: c.id, title: c.title, action: "skip", reason: "no hidden test; an invariant the verifier cannot execute is not approved automatically", by: state.by, at: nowIso() }];
      continue;
    }
    try {
      const d = decide(state, { id: c.id, action: "accept" });
      result.approved.push({ id: c.id, title: c.title, assigned_id: d.result!.assigned_id, hidden_test: d.result!.hidden_test });
    } catch (e) {
      result.failed.push({ id: c.id, title: c.title, error: (e as Error).message });
    }
  }
  saveDecisions(state);
  result.finish = finishReview(state);
  return result;
}

/** How to name the automatic approver after who mined the list. */
export function autoApprover(author: Author | null): string {
  return `auto:${author?.model ?? "codex"}`;
}

export function finishReview(state: ReviewState): FinishResult {
  const accepted = state.decisions.filter((d) => d.action === "accept");
  const result: FinishResult = {
    accepted: accepted.length,
    merged: state.decisions.filter((d) => d.action === "merge").length,
    rejected: state.decisions.filter((d) => d.action === "reject").length,
    skipped: state.decisions.filter((d) => d.action === "skip").length,
    pending: state.candidates.filter((c) => !state.decisions.some((d) => d.id === c.id)).length,
    assigned: accepted.map((d) => `${d.result!.assigned_id} ${d.title}`),
    hidden_tests_needing_attention: accepted.filter((d) => d.result?.hidden_test && !d.result.hidden_test_complete).map((d) => d.result!.hidden_test!),
    index: null,
    index_error: null,
    decisions_file: state.decisions_file,
  };
  try {
    const summary = indexRepository(state.opts.store, state.repo_path);
    result.index = { mode: summary.mode, policy_id: summary.policy_id, unresolved_sources: summary.unresolved_sources };
  } catch (e) {
    result.index_error = (e as Error).message;
  }
  state.finished = result;
  saveDecisions(state);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Local server and page

export interface ReviewServer {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
  /** Resolves when the reviewer clicks Finish (after the response was sent). */
  done: Promise<FinishResult>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      if (chunks.reduce((n, b) => n + b.length, 0) > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function publicState(state: ReviewState) {
  return {
    repo_path: state.repo_path,
    policy_id: state.policy_id,
    policy_file: state.policy_file,
    hidden_tests_dir: state.hidden_tests_dir,
    doc_file: state.doc_file,
    by: state.by,
    finished: state.finished,
    author: state.author,
    candidates: state.candidates.map((c) => ({ id: c.id, kind: c.kind, title: c.title, statement: c.statement, category: c.category, rationale: c.rationale, relevance: c.relevance, confidence: c.confidence, evidence: c.evidence.map((e) => ({ type: e.type, ref: e.ref, excerpt: e.excerpt, path: e.path ?? null, line: e.line ?? null })), applies_to_paths: c.applies_to_paths ?? [], sources: c.sources ?? [], hidden_test: c.suggested_hidden_test ? { from: c.suggested_hidden_test.from, language: c.suggested_hidden_test.language, source: c.suggested_hidden_test.source, notes: c.suggested_hidden_test.notes, standalone: c.suggested_hidden_test.standalone } : null, rule: c.rule ?? null, status: c.status ?? null })),
    decisions: state.decisions,
  };
}

export function startReviewServer(state: ReviewState, opts: { port?: number; open?: boolean; log?: (line: string) => void } = {}): Promise<ReviewServer> {
  const token = crypto.randomBytes(16).toString("hex");
  let resolveDone!: (r: FinishResult) => void;
  const done = new Promise<FinishResult>((r) => (resolveDone = r));
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        if (url.searchParams.get("token") !== token) {
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("missing or wrong token; use the URL printed by intentos review");
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(reviewPage(token));
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (req.headers["x-review-token"] !== token) return json(res, 403, { error: "bad token" });
        if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, publicState(state));
        if (req.method === "POST" && url.pathname === "/api/decide") {
          const body = JSON.parse((await readBody(req)) || "{}") as { id: string; action: "accept" | "reject" | "skip"; statement?: string; reason?: string; merge_ids?: string[] };
          if (!["accept", "reject", "skip"].includes(body.action)) return json(res, 400, { error: "action must be accept, reject or skip" });
          try {
            return json(res, 200, { decision: decide(state, body) });
          } catch (e) {
            return json(res, 409, { error: (e as Error).message });
          }
        }
        if (req.method === "POST" && url.pathname === "/api/finish") {
          const result = state.finished ?? finishReview(state);
          json(res, 200, { finished: result });
          setTimeout(() => {
            server.close();
            resolveDone(result);
          }, 50);
          return;
        }
        return json(res, 404, { error: "not found" });
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const url = `http://127.0.0.1:${port}/?token=${token}`;
      opts.log?.(`review UI: ${url}`);
      if (opts.open) openBrowser(url);
      resolve({ url, port, token, close: () => new Promise((r) => server.close(() => r())), done });
    });
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    spawn(cmd[0]!, cmd.slice(1), { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

export function defaultReviewer(): string {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const name = execSync("git config user.name", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (name) return name;
  } catch {
    /* fall through */
  }
  return os.userInfo().username;
}

/** The MCP Apps browser bundle as a classic script that leaves its exports on `globalThis.__mcpApps` (no module imports in a sandboxed view). */
export function mcpAppsBundleScript(): string {
  const file = path.join(PROJECT_ROOT, "node_modules", "@modelcontextprotocol", "ext-apps", "dist", "src", "app-with-deps.js");
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
  if (!m) throw new Error(`cannot find the export clause of ${file}`);
  const pairs = m[1]!.split(",").map((e) => e.trim()).filter(Boolean).map((e) => {
    const parts = e.split(/\s+as\s+/);
    return parts.length === 2 ? `${JSON.stringify(parts[1]!.trim())}:${parts[0]!.trim()}` : `${JSON.stringify(e)}:${e}`;
  });
  return `${src.slice(0, m.index)}\nglobalThis.__mcpApps={${pairs.join(",")}};\n`;
}

export type ReviewPageMode = "http" | "widget";

/** The review page. `http`: talks to the local server with the token; `widget`: runs inside an MCP Apps host and calls the app-only tools. */
export function reviewPage(token: string | null, mode: ReviewPageMode = "http"): string {
  const bundle = mode === "widget" ? `<script>${mcpAppsBundleScript()}</script>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>IntentOS policy review</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --bg:#f6f7f9; --card:#fff; --ink:#1c2430; --muted:#6b7482; --line:#e2e6ec; --ok:#1f7a4d; --no:#b4322e; --warn:#9a6700; --accent:#2b5fd9; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14181f; --card:#1d232c; --ink:#e8ecf2; --muted:#9aa4b2; --line:#2c3440; --ok:#4cc38a; --no:#f0766f; --warn:#e3b341; --accent:#7aa2ff; } }
  * { box-sizing: border-box } body { margin:0; font: 15px/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; background:var(--bg); color:var(--ink) }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:center; flex-wrap:wrap }
  header h1 { font-size:16px; margin:0 } header .meta { color:var(--muted); font-size:13px }
  .progress { height:6px; background:var(--line); border-radius:3px; flex:1; min-width:120px; overflow:hidden } .progress i { display:block; height:100%; background:var(--accent); width:0 }
  main { display:grid; grid-template-columns: 300px 1fr; gap:16px; padding:16px 20px; max-width:1300px }
  @media (max-width: 860px) { main { grid-template-columns: 1fr } }
  aside { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:8px; max-height:calc(100vh - 110px); overflow:auto }
  aside button { display:block; width:100%; text-align:left; background:none; border:0; padding:8px 10px; border-radius:8px; color:var(--ink); cursor:pointer; font-size:13px }
  aside button.current { background:rgba(43,95,217,.12) } aside .st { font-size:11px; color:var(--muted); margin-right:6px; font-variant-numeric: tabular-nums }
  aside .acc { color:var(--ok) } aside .rej { color:var(--no) } aside .skp { color:var(--warn) }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px 22px }
  .kind { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted) }
  h2 { margin:4px 0 10px; font-size:20px }
  .row { color:var(--muted); font-size:13px; margin-bottom:12px } .row b { color:var(--ink); font-weight:600 }
  .cls { border-left:3px solid var(--accent); padding:6px 10px; margin:10px 0; font-size:14px; background:rgba(43,95,217,.06); border-radius:0 8px 8px 0 }
  label { display:block; font-size:12px; color:var(--muted); margin:14px 0 4px }
  textarea { width:100%; min-height:72px; font:14px/1.4 inherit; padding:10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); resize:vertical }
  input[type=text] { width:100%; font:14px inherit; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink) }
  ul.ev { margin:6px 0 0; padding-left:18px; font-size:13px } ul.ev li { margin:3px 0 } ul.ev code { font-size:12px }
  details { margin-top:12px } summary { cursor:pointer; color:var(--muted); font-size:13px }
  pre { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:10px; overflow:auto; font-size:12px; max-height:320px }
  .actions { display:flex; gap:10px; margin-top:18px; flex-wrap:wrap; align-items:center }
  .btn { border:1px solid var(--line); background:var(--card); color:var(--ink); padding:9px 14px; border-radius:9px; cursor:pointer; font-size:14px }
  .btn.ok { background:var(--ok); border-color:var(--ok); color:#fff } .btn.no { background:var(--no); border-color:var(--no); color:#fff } .btn.fin { background:var(--accent); border-color:var(--accent); color:#fff }
  .btn kbd { font-size:11px; opacity:.75; margin-left:6px; border:1px solid rgba(255,255,255,.4); border-radius:4px; padding:0 4px }
  .btn:not(.ok):not(.no):not(.fin) kbd { border-color:var(--line) }
  .result { margin-top:14px; font-size:13px; padding:10px 12px; border-radius:8px; background:rgba(31,122,77,.08); border:1px solid rgba(31,122,77,.25) }
  .result.err { background:rgba(180,50,46,.08); border-color:rgba(180,50,46,.3) }
  .done h2 { font-size:22px } .done li { margin:4px 0 } .warnline { color:var(--warn) }
  .empty { color:var(--muted); padding:40px; text-align:center }
</style></head>
<body>
<header><h1>IntentOS policy review</h1><div class="meta" id="meta"></div><div class="progress"><i id="bar"></i></div><div class="meta" id="count"></div></header>
<main><aside id="list"></aside><section id="card" class="card"><div class="empty">Loading…</div></section></main>
${bundle}
<script>
const MODE = ${JSON.stringify(mode)};
const TOKEN = ${JSON.stringify(token)};
let app = null, WIDGET_TOKEN = null;
const httpApi = (p, opts={}) => fetch(p, { ...opts, headers: { 'x-review-token': TOKEN, 'content-type': 'application/json', ...(opts.headers||{}) } }).then(async r => { const j = await r.json().catch(()=>({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; });
async function callTool(name, args) {
  const r = await app.callServerTool({ name, arguments: args });
  if (r.isError) throw new Error((r.content || []).map(c => c.text || '').join(' ') || ('tool ' + name + ' failed'));
  return r.structuredContent || {};
}
const api = async (p, opts={}) => {
  if (MODE === 'http') return httpApi(p, opts);
  const body = opts.body ? JSON.parse(opts.body) : {};
  if (p === '/api/state') return callTool('review_state', { token: WIDGET_TOKEN });
  if (p === '/api/decide') return callTool('review_decide', { token: WIDGET_TOKEN, ...body });
  if (p === '/api/finish') return callTool('review_finish', { token: WIDGET_TOKEN });
  throw new Error('unknown api ' + p);
};
let state = null, current = null, lastResult = null;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const decisionOf = id => (state.decisions||[]).find(d => d.id === id);
const pending = () => state.candidates.filter(c => !decisionOf(c.id));
async function load() { state = await api('/api/state'); if (!current) { const p = pending(); current = p.length ? p[0].id : (state.candidates[0]||{}).id; } render(); }
function render() {
  const total = state.candidates.length, done = total - pending().length;
  document.getElementById('meta').textContent = state.policy_id + ' · ' + state.repo_path + ' · reviewer ' + state.by + (state.author ? ' · candidates by ' + (state.author.via === 'side_thread' ? (state.author.model || 'an unnamed model') + ' (independent side thread)' : 'the host agent') + ', checked by IntentOS' : '');
  document.getElementById('count').textContent = done + ' / ' + total + ' decided';
  document.getElementById('bar').style.width = (total ? 100*done/total : 0) + '%';
  const list = document.getElementById('list');
  list.innerHTML = state.candidates.map(c => { const d = decisionOf(c.id); const cls = d ? (d.action==='accept'||d.action==='merge'?'acc':d.action==='reject'?'rej':'skp') : ''; const mark = d ? (d.action==='accept' ? '✓ ' + (d.result ? d.result.assigned_id : '') : d.action==='merge' ? '⇒ ' + d.merged_into : d.action==='reject' ? '✗' : '→') : '·';
    return '<button class="' + (c.id===current?'current':'') + '" data-id="' + c.id + '"><span class="st ' + cls + '">' + esc(mark) + '</span>' + esc(c.title) + '</button>'; }).join('');
  list.querySelectorAll('button').forEach(b => b.onclick = () => { current = b.dataset.id; lastResult = null; render(); });
  const card = document.getElementById('card');
  if (state.finished) { card.innerHTML = finishedHtml(state.finished); return; }
  const c = state.candidates.find(x => x.id === current);
  if (!c) { card.innerHTML = '<div class="empty">No candidates to review.</div>' + finishBar(); return; }
  const d = decisionOf(c.id);
  card.innerHTML = '<div class="kind">' + esc(c.kind.replace('_',' ')) + ' · ' + esc(c.id) + '</div><h2>' + esc(c.title) + '</h2>'
    + '<div class="row"><b>' + esc((c.category || 'business_rule').replace('_',' ')) + '</b> · relevance <b>' + esc(c.relevance) + '</b> · evidence confidence <b>' + esc(c.confidence) + '</b></div>'
    + relatedHtml(c, d)
    + (c.rationale ? '<div class="cls">' + esc(c.rationale) + '</div>' : '')
    + '<label>Rule statement (edit before approving)</label><textarea id="stmt">' + esc((d && d.statement) || c.statement) + '</textarea>'
    + '<label>Evidence</label><ul class="ev">' + c.evidence.map(e => '<li><code>' + esc(e.type) + ' ' + esc(e.ref) + '</code> ' + esc(e.excerpt) + '</li>').join('') + '</ul>'
    + (c.applies_to_paths.length ? '<div class="row" style="margin-top:8px">applies to: <b>' + esc(c.applies_to_paths.join(', ')) + '</b></div>' : '')
    + (c.sources.length ? '<div class="row">source: <b>' + esc(c.sources.map(s => s.path + (s.heading ? '#' + s.heading : '')).join(', ')) + '</b></div>' : '<div class="row">no document source: approving adds a section to <b>' + esc(state.doc_file) + '</b> in the repository</div>')
    + (c.hidden_test ? '<details><summary>Hidden test that will be written (' + (c.hidden_test.standalone ? 'self-contained' : 'needs attention: ' + esc(c.hidden_test.notes.join('; '))) + ')</summary><pre>' + esc(c.hidden_test.source) + '</pre></details>' : (c.kind==='invariant' ? '<div class="row warnline">no hidden test draft: the verifier will not be able to execute this invariant</div>' : ''))
    + '<label>Reason (for rejections; optional)</label><input type="text" id="reason" placeholder="e.g. implementation detail, not a rule">'
    + '<div class="actions">' + (d && d.action==='accept' ? '<span class="row">approved as <b>' + esc(d.result.assigned_id) + '</b></span>' : '<button class="btn ok" id="accept">Approve<kbd>A</kbd></button><button class="btn no" id="reject">Reject<kbd>R</kbd></button><button class="btn" id="skip">Skip<kbd>S</kbd></button>') + '<span style="flex:1"></span>' + finishBar() + '</div>'
    + (lastResult ? '<div class="result' + (lastResult.error?' err':'') + '">' + esc(lastResult.error || lastResult.text) + (lastResult.warnings||[]).map(w => '<br>• ' + esc(w)).join('') + '</div>' : '');
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('accept', () => act('accept')); on('reject', () => act('reject')); on('skip', () => act('skip')); on('finish', finish);
}
function relatedHtml(c, d) {
  if (d && d.action === 'merge') return '<div class="cls">Folded into <b>' + esc(d.merged_into) + '</b> as one of its hidden tests.</div>';
  if (c.kind !== 'invariant') return '';
  const others = state.candidates.filter(m => m.id !== c.id && m.kind === 'invariant' && !decisionOf(m.id) && m.hidden_test);
  if (!others.length) return '';
  const rows = others.map(m => '<li><label style="display:inline;margin:0;font-size:13px;color:var(--ink)"><input type="checkbox" class="fold" value="' + m.id + '"> ' + esc(m.id) + ' · ' + esc(m.title) + '</label></li>').join('');
  return '<details><summary>Fold other invariant candidates into this approval (' + others.length + ' pending with a test)</summary><div class="cls">Ticked candidates become extra hidden tests of <i>one</i> invariant instead of separate entries.<ul class="ev">' + rows + '</ul></div></details>';
}
function finishBar() { return '<button class="btn fin" id="finish">Finish review' + (pending().length ? ' (' + pending().length + ' pending)' : '') + '</button>'; }
async function act(action) {
  const c = state.candidates.find(x => x.id === current); if (!c) return;
  const statement = (document.getElementById('stmt')||{}).value, reason = (document.getElementById('reason')||{}).value;
  const merge_ids = action === 'accept' ? Array.from(document.querySelectorAll('input.fold:checked')).map(i => i.value) : [];
  try { const r = await api('/api/decide', { method:'POST', body: JSON.stringify({ id: c.id, action, statement, reason, merge_ids }) });
    const d = r.decision; lastResult = d.action==='accept' ? { text: 'Approved as ' + d.result.assigned_id + (d.merged_ids && d.merged_ids.length ? ' (with ' + d.merged_ids.join(', ') + ')' : '') + ' → ' + d.result.policy_file + (d.result.hidden_test ? '; hidden test(s) under ' + d.result.hidden_test.replace(/[^/]+$/, '') : ''), warnings: d.result.warnings } : { text: d.action==='reject' ? 'Rejected' : 'Skipped' };
    await load(); const p = pending(); if (p.length) { current = p[0].id; render(); }
  } catch (e) { lastResult = { error: e.message }; render(); }
}
async function finish() { try { await api('/api/finish', { method:'POST', body:'{}' }); await load(); } catch (e) { lastResult = { error: e.message }; render(); } }
function finishedHtml(f) { return '<div class="done"><h2>Review finished</h2><ul>'
  + '<li>approved <b>' + f.accepted + '</b>' + (f.assigned.length ? ': ' + esc(f.assigned.join('; ')) : '') + (f.merged ? ' (' + f.merged + ' related candidate(s) folded in as extra hidden tests)' : '') + '</li><li>rejected <b>' + f.rejected + '</b>, skipped <b>' + f.skipped + '</b>, left pending <b>' + f.pending + '</b></li>'
  + (f.hidden_tests_needing_attention.length ? '<li class="warnline">hidden tests to finish by hand: ' + esc(f.hidden_tests_needing_attention.join(', ')) + '</li>' : '')
  + (f.index ? '<li>repository re-indexed (' + esc(f.index.mode) + ', policy ' + esc(f.index.policy_id) + ')' + (f.index.unresolved_sources.length ? '<span class="warnline"> — unresolved policy sources: ' + esc(f.index.unresolved_sources.map(u => u.owner + ' ' + u.path + (u.heading?'#'+u.heading:'')).join('; ')) + '</span>' : '') + '</li>' : (f.index_error ? '<li class="warnline">index: ' + esc(f.index_error) + '</li>' : ''))
  + '</ul><p class="row">Commit the policy, the hidden tests and any new section in the repository. You can close this tab; the local server has stopped.</p></div>'; }
document.addEventListener('keydown', e => { if (e.target && /TEXTAREA|INPUT/.test(e.target.tagName)) return; const k = e.key.toLowerCase(); if (k==='a') act('accept'); else if (k==='r') act('reject'); else if (k==='s') act('skip'); });
async function boot() {
  if (MODE === 'widget') {
    // Inside an MCP Apps host: connect to the host over postMessage, then fetch the widget token from an app-only tool.
    app = new globalThis.__mcpApps.App({ name: 'intentos-review', version: '0.1.0' });
    await app.connect(new globalThis.__mcpApps.PostMessageTransport(window.parent, window.parent));
    const session = await callTool('review_session', {});
    WIDGET_TOKEN = session.token;
  }
  await load();
}
boot().catch(e => { document.getElementById('card').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
</script></body></html>`;
}
