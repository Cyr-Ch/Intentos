import { logForPaths } from "../util/git.ts";
import { matchesAny, GLOBAL_PROTECTED_PATTERNS } from "../util/paths.ts";
import type { KnowledgeStore, NodeRow, EdgeRow, EvidenceRow } from "./storage.ts";
import type { ConstraintAttributes, DocSectionAttributes, SymbolAttributes, TestAttributes } from "./indexer.ts";
import type { Policy } from "./policy.ts";
import type { IndexedRepo } from "./repo.ts";
import { detectConflicts, type Conflict } from "./conflicts.ts";

const STOPWORDS = new Set(
  "a an the to for of in on and or with without add adds adding new make support supports allow allows enable enables implement implementation feature request please should must that this those these which when where our we it its is are be by as at from into via using use so can could".split(" "),
);

const BUILTIN_SYNONYMS: Record<string, string[]> = {
  promotion: ["promo", "promotional", "discount"],
  promotional: ["promotion", "promo", "discount"],
  promo: ["promotion", "discount"],
  discount: ["promotion", "promo"],
  upgrade: ["upgrades", "subscription", "plan", "tier"],
  subscription: ["subscriptions", "upgrade", "plan"],
  export: ["exports", "exporter", "invoice"],
  invoice: ["invoices", "export"],
  bug: ["fix", "regression", "test"],
  fix: ["bug", "regression"],
  entitlement: ["entitlements"],
  payment: ["payments", "charge", "gateway"],
};

export function tokenize(text: string): string[] {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-./:]/g, " ");
  const tokens = spaced.toLowerCase().split(/[^a-z0-9%]+/).filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return [...new Set(tokens.map(singular))];
}

function singular(t: string): string {
  if (t.endsWith("ies") && t.length > 4) return `${t.slice(0, -3)}y`;
  if (t.endsWith("es") && t.length > 4 && /(s|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss") && t.length > 3) return t.slice(0, -1);
  return t;
}

export interface QueryTerms {
  primary: string[];
  expanded: string[];
}

export function expandQuery(task: string, policy: Policy): QueryTerms {
  const primary = tokenize(task);
  const expanded = new Set<string>();
  const dict: Record<string, string[]> = { ...BUILTIN_SYNONYMS };
  for (const [k, v] of Object.entries(policy.synonyms)) dict[singular(k.toLowerCase())] = [...(dict[singular(k.toLowerCase())] ?? []), ...v];
  for (const t of primary) for (const s of dict[t] ?? []) for (const st of tokenize(s)) if (!primary.includes(st)) expanded.add(st);
  return { primary, expanded: [...expanded] };
}

function scoreText(text: string | null | undefined, terms: QueryTerms, weight: number): number {
  if (!text) return 0;
  const toks = new Set(tokenize(text));
  let s = 0;
  for (const t of terms.primary) if (toks.has(t)) s += weight;
  for (const t of terms.expanded) if (toks.has(t)) s += weight * 0.5;
  return s;
}

export interface SymbolHit {
  symbol_id: string;
  qualified_name: string;
  kind: string;
  path: string;
  line_start: number;
  line_end: number;
  signature: string | null;
  docstring_excerpt: string | null;
  evidence_id: string;
  relevance: number;
  reasons: string[];
  reuse_recommendation: "required" | "consider";
  recommendation_basis: string;
  basis: "fact";
}
export interface TestHit {
  test_id: string;
  path: string;
  name: string;
  line: number;
  evidence_id: string;
  validates: string[];
  relevance: number;
  basis: "fact";
}
export interface DocHit {
  doc_id: string;
  path: string;
  heading: string;
  line_start: number;
  line_end: number;
  evidence_id: string;
  authority: string;
  status: string;
  adr_status: string | null;
  relevance: number;
  excerpt: string;
  basis: "fact";
}
export interface ConstraintHit {
  id: string;
  kind: "invariant" | "architecture_rule" | "decision";
  statement: string;
  authority: string;
  status: string;
  enforcement: "blocking" | "advisory";
  evidence_ids: string[];
  sources: ConstraintAttributes["sources"];
  verified_by: string[];
  approved_by: string | null;
  applicability: "scope_match" | "token_match" | "both" | "always";
  decision_status?: string;
  supersedes?: string | null;
  superseded_by?: string | null;
  rule_kind?: string;
  rule?: Record<string, unknown>;
  binding: boolean;
  basis: "trusted_policy";
}
export interface ImpactEntry {
  path: string;
  module_id: string;
  reason: string;
  confidence: number;
}
export interface EvidencePack {
  repo_id: string;
  repo_path: string;
  revision: string;
  task: string;
  generated_at: string;
  policy_id: string;
  query: QueryTerms;
  reusable_symbols: SymbolHit[];
  tests: TestHit[];
  docs: DocHit[];
  invariants: ConstraintHit[];
  architecture_rules: ConstraintHit[];
  decisions: ConstraintHit[];
  conflicts: Conflict[];
  impact: { probable_files: ImpactEntry[]; method: string; limitations: string[] };
  history: Array<{ sha: string; date: string; subject: string; paths: string[] }>;
  suggestions: Array<{ text: string; basis: "heuristic" }>;
  allowed_path_universe: string[];
  protected_paths: string[];
  commands: Array<{ command_id: string; description: string; track: string; enforcement: string; requires_task_tests: boolean }>;
  evidence_index: Record<string, { source_type: string; path: string | null; line_start: number | null; line_end: number | null; authority: string; status: string; summary: string | null }>;
  limitations: string[];
}

function parseAttrs<T>(n: NodeRow): T {
  return JSON.parse(n.attributes_json) as T;
}

export function buildEvidencePack(store: KnowledgeStore, indexed: IndexedRepo, task: string, opts: { maxSymbols?: number; maxDocs?: number; maxTests?: number } = {}): EvidencePack {
  const { repo, revision, policy, repoPath } = indexed;
  const terms = expandQuery(task, policy);
  const allNodes = store.nodes(repo.id, revision);
  const allEdges = store.edges(repo.id, revision);
  const evidenceRows = store.evidence(repo.id, revision);
  const evidenceById = new Map(evidenceRows.map((e) => [e.id, e]));
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));
  const edgesFrom = groupBy(allEdges, (e) => e.from_node);
  const edgesTo = groupBy(allEdges, (e) => e.to_node);

  // --- symbols
  const modules = allNodes.filter((n) => n.kind === "module");
  const symbolNodes = allNodes.filter((n) => n.kind === "symbol");
  const decisionNodes = allNodes.filter((n) => n.kind === "decision");
  const approvedDecisionText = decisionNodes
    .map((n) => ({ n, a: parseAttrs<ConstraintAttributes>(n) }))
    .filter(({ a }) => a.decision_status === "approved");

  const scoredSymbols: SymbolHit[] = [];
  for (const n of symbolNodes) {
    const a = parseAttrs<SymbolAttributes>(n);
    if (a.is_test || a.name.startsWith("__")) continue;
    const reasons: string[] = [];
    let s = 0;
    const nameScore = scoreText(a.name, terms, 4);
    if (nameScore) {
      s += nameScore;
      reasons.push("name matches task terms");
    }
    const qnScore = scoreText(n.qualified_name, terms, 1.5);
    if (qnScore) s += qnScore;
    const docScore = Math.min(scoreText(a.docstring, terms, 1), 4);
    if (docScore) {
      s += docScore;
      reasons.push("docstring mentions task terms");
    }
    const pathScore = Math.min(scoreText(a.path, terms, 1), 3);
    if (pathScore) {
      s += pathScore;
      reasons.push("module path matches task terms");
    }
    if (a.kind === "class") s *= 1.25;
    if (a.kind === "method") s *= 0.8;
    if (s <= 0) continue;
    const mentionedBy = approvedDecisionText.filter(({ a: d }) => new RegExp(`\\b${escapeRe(a.name)}\\b`).test(d.statement));
    scoredSymbols.push({
      symbol_id: n.id,
      qualified_name: n.qualified_name ?? a.name,
      kind: a.kind,
      path: a.path,
      line_start: a.line_start,
      line_end: a.line_end,
      signature: a.signature,
      docstring_excerpt: a.docstring ? a.docstring.split("\n")[0]!.slice(0, 200) : null,
      evidence_id: a.evidence_id,
      relevance: s,
      reasons,
      reuse_recommendation: mentionedBy.length ? "required" : "consider",
      recommendation_basis: mentionedBy.length ? `named in approved decision ${mentionedBy.map((m) => m.n.id).join(", ")}` : "lexical relevance only (model-free heuristic)",
      basis: "fact",
    });
  }
  scoredSymbols.sort((x, y) => y.relevance - x.relevance || x.qualified_name.localeCompare(y.qualified_name));
  const maxRel = scoredSymbols[0]?.relevance ?? 1;
  for (const h of scoredSymbols) h.relevance = Math.round((h.relevance / maxRel) * 100) / 100;
  const symbols = scoredSymbols.slice(0, opts.maxSymbols ?? 12);

  // --- modules touched by top symbols, then 1-hop reverse import neighbours
  const topModuleIds = new Set<string>();
  for (const h of symbols.slice(0, 8)) {
    const mod = modules.find((m) => parseAttrs<SymbolAttributes>(m).path === h.path);
    if (mod) topModuleIds.add(mod.id);
  }
  const impact: ImpactEntry[] = [];
  const seenImpact = new Set<string>();
  const pushImpact = (modId: string, reason: string, confidence: number) => {
    const mod = nodeById.get(modId);
    if (!mod || seenImpact.has(modId)) return;
    seenImpact.add(modId);
    impact.push({ path: parseAttrs<SymbolAttributes>(mod).path, module_id: modId, reason, confidence });
  };
  for (const id of topModuleIds) pushImpact(id, "defines a task-relevant symbol", 0.9);
  for (const id of [...topModuleIds]) {
    for (const e of edgesTo.get(id) ?? []) if (e.relation === "IMPORTS") pushImpact(e.from_node, `imports ${nodeById.get(id)?.qualified_name ?? id} (static import graph)`, 0.6);
  }

  // --- tests validating impacted modules/symbols + lexical test hits
  const testHits = new Map<string, TestHit>();
  const addTest = (testId: string, validates: string, rel: number) => {
    const t = nodeById.get(testId);
    if (!t) return;
    const a = parseAttrs<TestAttributes>(t);
    const existing = testHits.get(testId);
    if (existing) {
      if (!existing.validates.includes(validates)) existing.validates.push(validates);
      existing.relevance = Math.max(existing.relevance, rel);
      return;
    }
    testHits.set(testId, { test_id: testId, path: a.path, name: a.name, line: a.line, evidence_id: a.evidence_id, validates: [validates], relevance: rel, basis: "fact" });
  };
  for (const h of symbols.slice(0, 8)) for (const e of edgesFrom.get(h.symbol_id) ?? []) if (e.relation === "VALIDATED_BY") addTest(e.to_node, h.qualified_name, 0.9);
  for (const id of topModuleIds) for (const e of edgesFrom.get(id) ?? []) if (e.relation === "VALIDATED_BY") addTest(e.to_node, nodeById.get(id)?.qualified_name ?? id, 0.7);
  for (const t of allNodes.filter((n) => n.kind === "test")) {
    const a = parseAttrs<TestAttributes>(t);
    const s = scoreText(a.name, terms, 1);
    if (s > 0) addTest(t.id, "test name matches task terms", Math.min(1, 0.5 + s / 8));
  }
  const tests = [...testHits.values()].sort((x, y) => y.relevance - x.relevance).slice(0, opts.maxTests ?? 15);

  // --- docs
  const docs: DocHit[] = [];
  for (const n of allNodes.filter((x) => x.kind === "doc_section")) {
    const a = parseAttrs<DocSectionAttributes>(n);
    const s = scoreText(a.heading, terms, 3) + Math.min(scoreText(a.excerpt, terms, 0.75), 4) + scoreText(a.path, terms, 1);
    if (s <= 0) continue;
    const ev = evidenceById.get(a.evidence_id);
    docs.push({
      doc_id: n.id,
      path: a.path,
      heading: a.heading,
      line_start: a.line_start,
      line_end: a.line_end,
      evidence_id: a.evidence_id,
      authority: ev?.authority ?? "historical_precedent",
      status: ev?.status ?? "supported",
      adr_status: a.adr?.status ?? null,
      relevance: s,
      excerpt: a.excerpt.slice(0, 400),
      basis: "fact",
    });
  }
  docs.sort((x, y) => y.relevance - x.relevance);
  const maxDoc = docs[0]?.relevance ?? 1;
  for (const d of docs) d.relevance = Math.round((d.relevance / maxDoc) * 100) / 100;
  const docHits = docs.slice(0, opts.maxDocs ?? 8);

  // --- constraints: invariants / architecture rules / decisions with applicability
  const impactedPaths = impact.map((i) => i.path);
  const impactedScope = new Set<string>();
  for (const p of impactedPaths) for (const [glob, tags] of Object.entries(policy.scope_tags)) if (matchesAny(p, [glob])) tags.forEach((t) => impactedScope.add(t));
  const termSet = new Set([...terms.primary, ...terms.expanded]);
  const applicability = (a: ConstraintAttributes, pathsRule: string[] | undefined): ConstraintHit["applicability"] | null => {
    const scopeMatch = a.scope.some((s) => impactedScope.has(singular(s.toLowerCase())) || impactedScope.has(s)) || (pathsRule?.length ? impactedPaths.some((p) => matchesAny(p, pathsRule)) : false);
    const tokenMatch = a.scope.some((s) => termSet.has(singular(s.toLowerCase()))) || tokenize(a.statement).filter((t) => termSet.has(t)).length >= 2;
    if (scopeMatch && tokenMatch) return "both";
    if (scopeMatch) return "scope_match";
    if (tokenMatch) return "token_match";
    return null;
  };
  const toHit = (n: NodeRow, kind: ConstraintHit["kind"], app: ConstraintHit["applicability"]): ConstraintHit => {
    const a = parseAttrs<ConstraintAttributes>(n);
    const binding = kind !== "decision" && a.enforcement === "blocking" && a.status === "confirmed" && ["approved_policy", "approved_decision", "executable_contract"].includes(a.authority);
    return {
      id: n.id,
      kind,
      statement: a.statement,
      authority: a.authority,
      status: a.status,
      enforcement: a.enforcement,
      evidence_ids: a.evidence_ids,
      sources: a.sources,
      verified_by: a.verified_by,
      approved_by: a.approved_by,
      applicability: app,
      decision_status: a.decision_status,
      supersedes: a.supersedes ?? null,
      superseded_by: a.superseded_by ?? null,
      rule_kind: a.kind,
      rule: a.rule,
      binding,
      basis: "trusted_policy",
    };
  };
  const invariants: ConstraintHit[] = [];
  for (const n of allNodes.filter((x) => x.kind === "invariant")) {
    const a = parseAttrs<ConstraintAttributes>(n);
    const app = applicability(a, (a.rule?.applies_to_paths as string[] | undefined) ?? []);
    if (app) invariants.push(toHit(n, "invariant", app));
  }
  const rules: ConstraintHit[] = [];
  for (const n of allNodes.filter((x) => x.kind === "architecture_rule")) {
    const a = parseAttrs<ConstraintAttributes>(n);
    const app = applicability(a, (a.rule?.paths as string[] | undefined) ?? []);
    // Architecture rules are cheap deterministic checks: always run them, but mark applicability.
    rules.push(toHit(n, "architecture_rule", app ?? "always"));
  }
  const decisions: ConstraintHit[] = [];
  for (const n of decisionNodes) {
    const a = parseAttrs<ConstraintAttributes>(n);
    const app = applicability(a, []);
    if (app) decisions.push(toHit(n, "decision", app));
  }
  // Human-approved decisions recorded via the CLI (not from policy) live in the decisions table.
  for (const row of store.decisions(repo.id)) {
    if (nodeById.has(row.id)) continue;
    const scope = JSON.parse(row.scope_json) as string[];
    const tokenMatch = scope.some((s) => termSet.has(singular(s.toLowerCase()))) || tokenize(row.statement).filter((t) => termSet.has(t)).length >= 2;
    const scopeMatch = scope.some((s) => impactedScope.has(s));
    if (!tokenMatch && !scopeMatch) continue;
    decisions.push({
      id: row.id,
      kind: "decision",
      statement: row.statement,
      authority: row.authority,
      status: row.status === "approved" ? "confirmed" : row.status === "superseded" ? "superseded" : "hypothesized",
      enforcement: "advisory",
      evidence_ids: JSON.parse(row.evidence_ids_json) as string[],
      sources: [],
      verified_by: [],
      approved_by: row.approved_by,
      applicability: scopeMatch && tokenMatch ? "both" : scopeMatch ? "scope_match" : "token_match",
      decision_status: row.status,
      supersedes: row.supersedes,
      superseded_by: store.decisions(repo.id).find((d) => d.supersedes === row.id)?.id ?? null,
      binding: false,
      basis: "trusted_policy",
    });
  }

  const conflicts = detectConflicts([...invariants, ...rules, ...decisions], docHits);

  // --- history for impacted files (scoped git log)
  const history = impactedPaths.length
    ? logForPaths(repoPath, impactedPaths.slice(0, 8), 8).map((c) => ({ ...c, paths: impactedPaths.slice(0, 8) }))
    : [];

  // --- suggestions (clearly labelled heuristics, not facts)
  const suggestions: EvidencePack["suggestions"] = [];
  const required = symbols.filter((s) => s.reuse_recommendation === "required");
  if (required.length) suggestions.push({ text: `Approved decisions name ${required.map((s) => s.qualified_name).join(", ")}; route new behaviour through them rather than adding parallel logic.`, basis: "heuristic" });
  if (!invariants.length) suggestions.push({ text: "No approved business invariant matched this task; business correctness cannot be verified beyond functional tests.", basis: "heuristic" });
  const superseded = decisions.filter((d) => d.status === "superseded");
  if (superseded.length) suggestions.push({ text: `Decision(s) ${superseded.map((d) => d.id).join(", ")} are superseded; do not treat their documents as current instructions.`, basis: "heuristic" });

  const evidenceIndex: EvidencePack["evidence_index"] = {};
  const collectEv = (id: string) => {
    const e = evidenceById.get(id);
    if (e) evidenceIndex[id] = { source_type: e.source_type, path: e.path, line_start: e.line_start, line_end: e.line_end, authority: e.authority, status: e.status, summary: e.summary };
  };
  symbols.forEach((s) => collectEv(s.evidence_id));
  tests.forEach((t) => collectEv(t.evidence_id));
  docHits.forEach((d) => collectEv(d.evidence_id));
  [...invariants, ...rules, ...decisions].forEach((c) => c.evidence_ids.forEach(collectEv));

  return {
    repo_id: repo.id,
    repo_path: repoPath,
    revision,
    task,
    generated_at: new Date().toISOString(),
    policy_id: policy.policy_id,
    query: terms,
    reusable_symbols: symbols,
    tests,
    docs: docHits,
    invariants,
    architecture_rules: rules,
    decisions,
    conflicts,
    impact: {
      probable_files: impact,
      method: "static_imports_only",
      limitations: ["Impact is computed from module-level static imports (1 hop) and lexical symbol matches; runtime side effects, dynamic dispatch and data flow are not analysed."],
    },
    history,
    suggestions,
    allowed_path_universe: policy.default_allowed_paths,
    protected_paths: [...policy.protected_paths, ...GLOBAL_PROTECTED_PATTERNS],
    commands: Object.entries(policy.commands).map(([id, c]) => ({ command_id: id, description: c.description, track: c.track, enforcement: c.enforcement, requires_task_tests: c.requires_task_tests })),
    evidence_index: evidenceIndex,
    limitations: [
      "Retrieval is lexical + graph-based; relevance scores are heuristic rankings, not probabilities.",
      "Symbols listed are facts about the indexed revision; reuse recommendations are `required` only when an approved decision names the symbol.",
    ],
  };
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return m;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type { EvidenceRow, EdgeRow };
