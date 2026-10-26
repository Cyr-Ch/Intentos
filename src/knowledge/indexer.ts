import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolvePaths, resolvePython, type IntentosPaths } from "../config.ts";
import { evidenceId, nowIso, sha256, shortHash } from "../util/ids.ts";
import { headSha, isDirty, isGitRepo, repoToplevel } from "../util/git.ts";
import { matchesAny } from "../util/paths.ts";
import type { Authority, EdgeRow, EpistemicStatus, EvidenceRow, KnowledgeStore, NodeRow } from "./storage.ts";
import { fallbackPolicy, policyForRepo, type Policy, type SourceRef } from "./policy.ts";

// ---- raw indexer output (mirrors python/index_repo.py dataclasses) ---------

export interface RawSymbol {
  id: string;
  kind: "module" | "class" | "function" | "method";
  qualified_name: string;
  name: string;
  path: string;
  line_start: number;
  line_end: number;
  docstring: string | null;
  parent: string | null;
  decorators: string[];
  bases: string[];
  is_test: boolean;
  signature: string | null;
}
export interface RawImport {
  from_module: string;
  to_module: string;
  path: string;
  line: number;
  names: string[];
  resolved_internal: boolean;
}
export interface RawCall {
  from_symbol: string;
  callee: string;
  path: string;
  line: number;
  extraction_method: string;
  confidence: number;
}
export interface RawDocSection {
  id: string;
  path: string;
  heading: string;
  level: number;
  line_start: number;
  line_end: number;
  text: string;
  content_hash: string;
}
export interface RawDoc {
  path: string;
  title: string | null;
  sections: RawDocSection[];
  adr: { status_raw: string; status: string; date: string | null; supersedes: string | null; superseded_by: string | null; title: string | null } | null;
  content_hash: string;
}
export interface RawTest {
  id: string;
  path: string;
  name: string;
  line: number;
  module: string;
}
export interface RawIndex {
  repo: { path: string; head_sha: string; branch: string | null; dirty: boolean };
  files: string[];
  modules: string[];
  symbols: RawSymbol[];
  imports: RawImport[];
  calls: RawCall[];
  docs: RawDoc[];
  tests: RawTest[];
  skipped: Array<{ path: string; reason: string }>;
  limitations: string[];
}

export function repoIdFor(repoPath: string): string {
  return `repo-${shortHash(fs.realpathSync(repoPath), 12)}`;
}

export function runPythonIndexer(repoPath: string, paths: IntentosPaths = resolvePaths()): RawIndex {
  const script = path.join(paths.python, "index_repo.py");
  const res = spawnSync(resolvePython(paths), ["-I", script, repoPath], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (res.error) throw new Error(`Failed to start Python indexer: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`Python indexer exited ${res.status}: ${res.stderr.trim() || res.stdout.trim()}`);
  const parsed = JSON.parse(res.stdout) as RawIndex | { error: string };
  if ("error" in parsed) throw new Error(`Python indexer error: ${parsed.error}`);
  return parsed;
}

// ---- node attribute shapes ------------------------------------------------

export interface SymbolAttributes {
  kind: string;
  name: string;
  path: string;
  line_start: number;
  line_end: number;
  docstring: string | null;
  signature: string | null;
  bases: string[];
  decorators: string[];
  parent: string | null;
  is_test: boolean;
  evidence_id: string;
  scope_tags: string[];
}
export interface DocSectionAttributes {
  path: string;
  heading: string;
  level: number;
  line_start: number;
  line_end: number;
  excerpt: string;
  content_hash: string;
  evidence_id: string;
  adr: RawDoc["adr"];
  doc_title: string | null;
}
export interface TestAttributes {
  path: string;
  name: string;
  line: number;
  module: string;
  evidence_id: string;
}
export interface ConstraintAttributes {
  statement: string;
  authority: Authority;
  status: EpistemicStatus;
  enforcement: "blocking" | "advisory";
  scope: string[];
  evidence_ids: string[];
  sources: Array<SourceRef & { evidence_id: string | null; resolved: boolean; status: EpistemicStatus }>;
  verified_by: string[];
  approved_by: string | null;
  kind?: string;
  rule?: Record<string, unknown>;
  decision_status?: string;
  supersedes?: string | null;
  superseded_by?: string | null;
  policy_id: string;
}

export interface IndexSummary {
  repo_id: string;
  repo_path: string;
  head_sha: string;
  branch: string | null;
  dirty: boolean;
  policy_id: string;
  counts: Record<string, number>;
  skipped: Array<{ path: string; reason: string }>;
  limitations: string[];
  unresolved_sources: Array<{ owner: string; path: string; heading?: string; reason: string }>;
}

function sectionExcerpt(text: string, max = 600): string {
  const body = text.split("\n").slice(1).join("\n").trim();
  return body.length > max ? `${body.slice(0, max)}…` : body;
}

function scopeTagsFor(policy: Policy, relPath: string): string[] {
  const tags = new Set<string>();
  for (const [glob, list] of Object.entries(policy.scope_tags)) if (matchesAny(relPath, [glob])) list.forEach((t) => tags.add(t));
  return [...tags].sort();
}

/** Index a repository at HEAD and persist the graph bound to the trusted policy. */
export function indexRepository(store: KnowledgeStore, repoPathInput: string, opts: { paths?: IntentosPaths; policy?: Policy | null } = {}): IndexSummary {
  const paths = opts.paths ?? resolvePaths();
  const repoPath = path.resolve(repoPathInput);
  if (!fs.existsSync(repoPath)) throw new Error(`Repository path does not exist: ${repoPath}`);
  if (!isGitRepo(repoPath)) {
    throw new Error(`${repoPath} is not a Git repository. IntentOS indexes tracked files at HEAD; run \`git init\` and commit first (for the demo fixture: \`npm run fixture:build\`).`);
  }
  const top = repoToplevel(repoPath);
  if (fs.realpathSync(top) !== fs.realpathSync(repoPath)) throw new Error(`Please pass the repository root (${top}), not a subdirectory.`);
  const revision = headSha(repoPath);
  const policy = opts.policy === undefined ? (policyForRepo(repoPath) ?? fallbackPolicy(repoPath)) : (opts.policy ?? fallbackPolicy(repoPath));
  const raw = runPythonIndexer(repoPath, paths);
  if (raw.repo.head_sha !== revision) throw new Error(`HEAD moved during indexing (${revision} -> ${raw.repo.head_sha}); retry.`);

  const repoId = repoIdFor(repoPath);
  // Register the repository row first (decisions reference it); head_sha is finalized after the graph is stored.
  const existing = store.getRepository(repoId);
  store.upsertRepository({ id: repoId, path: repoPath, head_sha: existing?.head_sha ?? revision, indexed_at: existing?.indexed_at ?? nowIso() });
  const nodes: NodeRow[] = [];
  const edges: EdgeRow[] = [];
  const evidence: EvidenceRow[] = [];
  const unresolved: IndexSummary["unresolved_sources"] = [];
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  const addNode = (id: string, kind: string, qualified: string | null, attrs: unknown) => {
    nodes.push({ id, repo_id: repoId, revision, kind, qualified_name: qualified, attributes_json: JSON.stringify(attrs) });
    bump(`nodes.${kind}`);
  };
  const addEdge = (from: string, relation: string, to: string, evidenceIdRef: string | null, confidence: number | null) => {
    const id = `E-${shortHash(`${from}|${relation}|${to}`)}`;
    edges.push({ id, repo_id: repoId, revision, from_node: from, relation, to_node: to, evidence_id: evidenceIdRef, confidence });
    bump(`edges.${relation}`);
  };
  const addEvidence = (row: Omit<EvidenceRow, "repo_id" | "revision">) => {
    evidence.push({ ...row, repo_id: repoId, revision });
    bump(`evidence.${row.source_type}`);
    return row.id;
  };

  // --- modules and symbols
  const symbolByQn = new Map<string, RawSymbol>();
  const moduleIds = new Set<string>();
  for (const s of raw.symbols) {
    symbolByQn.set(s.qualified_name, s);
    const ev = addEvidence({
      id: evidenceId([revision, "code", s.path, s.line_start, s.line_end, s.qualified_name]),
      source_type: "code",
      path: s.path,
      line_start: s.line_start,
      line_end: s.line_end,
      source_ref: revision,
      authority: "current_implementation",
      status: "confirmed",
      content_hash: null,
      summary: `${s.kind} ${s.qualified_name}${s.signature ?? ""} defined in ${s.path}:${s.line_start}-${s.line_end}`,
    });
    const attrs: SymbolAttributes = {
      kind: s.kind,
      name: s.name,
      path: s.path,
      line_start: s.line_start,
      line_end: s.line_end,
      docstring: s.docstring,
      signature: s.signature,
      bases: s.bases,
      decorators: s.decorators,
      parent: s.parent,
      is_test: s.is_test,
      evidence_id: ev,
      scope_tags: scopeTagsFor(policy, s.path),
    };
    if (s.kind === "module") {
      addNode(s.id, "module", s.qualified_name, attrs);
      moduleIds.add(s.id);
    } else {
      addNode(s.id, "symbol", s.qualified_name, attrs);
      const owner = s.parent && symbolByQn.get(s.parent)?.kind === "class" ? `SY:${s.parent}` : `MOD:${s.qualified_name.split(".").slice(0, -1).join(".")}`;
      if (s.kind === "method") {
        addEdge(owner, "DEFINES", s.id, ev, 1);
      } else {
        addEdge(`MOD:${s.parent ?? s.qualified_name.split(".").slice(0, -1).join(".")}`, "DEFINES", s.id, ev, 1);
      }
    }
  }

  // --- imports
  const importedNames = new Map<string, Map<string, string>>(); // module -> local name -> target qualified
  for (const imp of raw.imports) {
    if (!imp.resolved_internal) continue;
    const from = `MOD:${imp.from_module}`;
    const to = `MOD:${imp.to_module}`;
    if (!moduleIds.has(to)) continue;
    const ev = addEvidence({
      id: evidenceId([revision, "import", imp.path, imp.line, imp.to_module]),
      source_type: "import",
      path: imp.path,
      line_start: imp.line,
      line_end: imp.line,
      source_ref: revision,
      authority: "current_implementation",
      status: "confirmed",
      content_hash: null,
      summary: `${imp.from_module} imports ${imp.to_module} (${imp.names.join(", ")})`,
    });
    addEdge(from, "IMPORTS", to, ev, 1);
    const local = importedNames.get(imp.from_module) ?? new Map<string, string>();
    for (const n of imp.names) local.set(n, `${imp.to_module}.${n}`);
    importedNames.set(imp.from_module, local);
  }

  // --- tests
  const testsByModule = new Map<string, RawTest[]>();
  for (const t of raw.tests) {
    const ev = addEvidence({
      id: evidenceId([revision, "test", t.path, t.line, t.name]),
      source_type: "test",
      path: t.path,
      line_start: t.line,
      line_end: t.line,
      source_ref: revision,
      authority: "current_implementation",
      status: "confirmed",
      content_hash: null,
      summary: `test ${t.name} in ${t.path}:${t.line}`,
    });
    const attrs: TestAttributes = { path: t.path, name: t.name, line: t.line, module: t.module, evidence_id: ev };
    addNode(t.id, "test", `${t.path}::${t.name}`, attrs);
    testsByModule.set(t.module, [...(testsByModule.get(t.module) ?? []), t]);
  }
  // VALIDATED_BY: a module imported by a test module is validated by that module's tests (confidence 0.8);
  // an imported symbol name narrows it to the symbol (0.7).
  for (const imp of raw.imports) {
    if (!imp.resolved_internal) continue;
    const tests = testsByModule.get(imp.from_module);
    if (!tests?.length) continue;
    for (const t of tests) {
      if (moduleIds.has(`MOD:${imp.to_module}`)) addEdge(`MOD:${imp.to_module}`, "VALIDATED_BY", t.id, null, 0.8);
      for (const n of imp.names) {
        const qn = `${imp.to_module}.${n}`;
        if (symbolByQn.has(qn)) addEdge(`SY:${qn}`, "VALIDATED_BY", t.id, null, 0.7);
      }
    }
  }

  // --- calls (name-resolved only)
  for (const c of raw.calls) {
    const fromQn = c.from_symbol.replace(/^SY:/, "");
    const module = raw.symbols.find((s) => s.qualified_name === fromQn)?.path;
    if (!module) continue;
    const fromModule = fromQn.split(".").slice(0, fromQn.split(".").length - (symbolByQn.get(fromQn)?.kind === "method" ? 2 : 1)).join(".");
    const local = importedNames.get(fromModule);
    const [head, ...rest] = c.callee.split(".");
    let target: string | null = null;
    if (head && local?.has(head)) target = [local.get(head)!, ...rest].join(".");
    else if (symbolByQn.has(`${fromModule}.${c.callee}`)) target = `${fromModule}.${c.callee}`;
    if (target && symbolByQn.has(target) && target !== fromQn) addEdge(c.from_symbol, "CALLS", `SY:${target}`, null, c.confidence);
  }

  // --- docs
  const sectionsByPath = new Map<string, RawDocSection[]>();
  const docByPath = new Map<string, RawDoc>();
  const sectionEvidence = new Map<string, string>(); // section id -> evidence id
  for (const doc of raw.docs) {
    docByPath.set(doc.path, doc);
    sectionsByPath.set(doc.path, doc.sections);
    const adrStatus: EpistemicStatus = doc.adr?.status === "superseded" ? "superseded" : doc.adr?.status === "rejected" ? "superseded" : "supported";
    for (const sec of doc.sections) {
      const ev = addEvidence({
        id: evidenceId([revision, "doc", sec.path, sec.line_start, sec.line_end]),
        source_type: "doc",
        path: sec.path,
        line_start: sec.line_start,
        line_end: sec.line_end,
        source_ref: revision,
        authority: "historical_precedent",
        status: adrStatus,
        content_hash: sec.content_hash,
        summary: `${doc.title ?? sec.path} › ${sec.heading}`,
      });
      sectionEvidence.set(sec.id, ev);
      const attrs: DocSectionAttributes = {
        path: sec.path,
        heading: sec.heading,
        level: sec.level,
        line_start: sec.line_start,
        line_end: sec.line_end,
        excerpt: sectionExcerpt(sec.text),
        content_hash: sec.content_hash,
        evidence_id: ev,
        adr: doc.adr,
        doc_title: doc.title,
      };
      addNode(sec.id, "doc_section", `${sec.path}#${sec.heading}`, attrs);
    }
  }

  // --- policy binding (invariants, architecture rules, decisions)
  const policyFile = `policies/${policy.policy_id}.yaml`;
  const resolveSources = (owner: string, sources: SourceRef[], authority: Authority) => {
    const out: ConstraintAttributes["sources"] = [];
    for (const src of sources) {
      const sections = sectionsByPath.get(src.path);
      if (!sections) {
        unresolved.push({ owner, path: src.path, heading: src.heading, reason: "document not found in repository at this revision" });
        out.push({ ...src, evidence_id: null, resolved: false, status: "conflicted" });
        continue;
      }
      let sec: RawDocSection | undefined;
      if (src.heading) sec = sections.find((s) => s.heading.toLowerCase() === src.heading!.toLowerCase());
      else if (src.line_start) sec = sections.find((s) => s.line_start <= src.line_start! && s.line_end >= src.line_start!);
      else sec = sections[0];
      if (!sec) {
        unresolved.push({ owner, path: src.path, heading: src.heading, reason: "heading not found at this revision" });
        out.push({ ...src, evidence_id: null, resolved: false, status: "conflicted" });
        continue;
      }
      const evId = sectionEvidence.get(sec.id)!;
      let status: EpistemicStatus = "confirmed";
      if (src.content_sha256 && src.content_sha256 !== sec.content_hash) {
        status = "conflicted";
        unresolved.push({ owner, path: src.path, heading: src.heading, reason: "section content changed since the policy pinned it" });
      }
      // Upgrade the bound section's evidence authority: it is now backed by trusted policy.
      const row = evidence.find((e) => e.id === evId);
      if (row && status === "confirmed") {
        row.authority = authority;
        row.status = row.status === "superseded" ? "superseded" : "confirmed";
      } else if (row && status === "conflicted") {
        row.status = "conflicted";
      }
      out.push({ ...src, evidence_id: evId, resolved: true, status });
    }
    return out;
  };

  const policyEvidence = (ownerId: string, authority: Authority, summary: string) =>
    addEvidence({
      id: evidenceId([revision, "policy", policyFile, ownerId]),
      source_type: "policy",
      path: policyFile,
      line_start: null,
      line_end: null,
      source_ref: `${policy.policy_id}:${ownerId}`,
      authority,
      status: "confirmed",
      content_hash: sha256(summary),
      summary,
    });

  for (const inv of policy.invariants) {
    const pev = policyEvidence(inv.id, inv.authority, `${inv.id}: ${inv.statement}`);
    const sources = resolveSources(inv.id, inv.sources, inv.authority);
    const anyConflict = sources.some((s) => s.status === "conflicted");
    const attrs: ConstraintAttributes = {
      statement: inv.statement,
      authority: inv.authority,
      status: anyConflict ? "conflicted" : "confirmed",
      enforcement: inv.enforcement,
      scope: inv.scope,
      evidence_ids: [pev, ...sources.flatMap((s) => (s.evidence_id ? [s.evidence_id] : []))],
      sources,
      verified_by: inv.verified_by,
      approved_by: inv.approved_by,
      rule: { applies_to_paths: inv.applies_to_paths },
      policy_id: policy.policy_id,
    };
    addNode(inv.id, "invariant", inv.id, attrs);
    for (const s of sources) if (s.evidence_id) addEdge(inv.id, "DOCUMENTED_IN", `DOC:${s.path}#${slug(s.heading ?? docByPath.get(s.path)?.title ?? "section")}`, s.evidence_id, 1);
    for (const m of raw.symbols.filter((s) => s.kind === "module")) {
      if (inv.applies_to_paths.length && matchesAny(m.path, inv.applies_to_paths)) addEdge(inv.id, "CONSTRAINS", m.id, pev, 1);
    }
    for (const t of inv.verified_by) addEdge(inv.id, "VALIDATED_BY", `HIDDEN_TEST:${t}`, pev, 1);
  }

  for (const rule of policy.architecture_rules) {
    const pev = policyEvidence(rule.id, rule.authority, `${rule.id}: ${rule.statement}`);
    const sources = resolveSources(rule.id, rule.sources, rule.authority);
    const attrs: ConstraintAttributes = {
      statement: rule.statement,
      authority: rule.authority,
      status: sources.some((s) => s.status === "conflicted") ? "conflicted" : "confirmed",
      enforcement: rule.enforcement,
      scope: rule.scope,
      evidence_ids: [pev, ...sources.flatMap((s) => (s.evidence_id ? [s.evidence_id] : []))],
      sources,
      verified_by: ["builtin:architecture_rules"],
      approved_by: rule.approved_by,
      kind: rule.kind,
      rule: {
        paths: rule.paths,
        forbidden_modules: rule.forbidden_modules,
        forbidden_callees: rule.forbidden_callees,
        allowed_paths: rule.allowed_paths,
        required_modules: rule.required_modules,
        forbidden_names: rule.forbidden_names,
        forbidden_literals: rule.forbidden_literals,
      },
      policy_id: policy.policy_id,
    };
    addNode(rule.id, "architecture_rule", rule.id, attrs);
    for (const m of raw.symbols.filter((s) => s.kind === "module")) {
      if (rule.paths.length && matchesAny(m.path, rule.paths)) addEdge(rule.id, "CONSTRAINS", m.id, pev, 1);
    }
  }

  for (const dec of policy.decisions) {
    const authority: Authority = dec.status === "approved" ? "approved_decision" : "historical_precedent";
    const pev = policyEvidence(dec.id, authority, `${dec.id} (${dec.status}): ${dec.statement}`);
    const sources = resolveSources(dec.id, dec.sources, authority);
    const supersededBy = policy.decisions.find((d) => d.supersedes === dec.id)?.id ?? null;
    const attrs: ConstraintAttributes = {
      statement: dec.statement,
      authority,
      status: dec.status === "superseded" ? "superseded" : dec.status === "approved" ? "confirmed" : "hypothesized",
      enforcement: "advisory",
      scope: dec.scope,
      evidence_ids: [pev, ...sources.flatMap((s) => (s.evidence_id ? [s.evidence_id] : []))],
      sources,
      verified_by: [],
      approved_by: dec.approved_by ?? null,
      decision_status: dec.status,
      supersedes: dec.supersedes ?? null,
      superseded_by: supersededBy,
      policy_id: policy.policy_id,
    };
    addNode(dec.id, "decision", dec.id, attrs);
    for (const s of sources) if (s.evidence_id) addEdge(dec.id, "DECIDED_IN", `DOC:${s.path}#${slug(docByPath.get(s.path)?.title ?? "section")}`, s.evidence_id, 1);
    if (dec.supersedes) addEdge(dec.id, "SUPERSEDES", dec.supersedes, pev, 1);
    store.upsertDecision({
      id: dec.id,
      repo_id: repoId,
      statement: dec.statement,
      scope_json: JSON.stringify(dec.scope),
      status: dec.status,
      evidence_ids_json: JSON.stringify(attrs.evidence_ids),
      approved_by: dec.approved_by ?? null,
      effective_revision: revision,
      supersedes: dec.supersedes ?? null,
      authority,
      created_at: nowIso(),
      rationale: dec.rationale ?? null,
    });
  }

  // Detect ADRs whose text says "superseded" but that the policy still treats as approved (stale policy).
  for (const doc of raw.docs) {
    if (doc.adr?.status !== "superseded") continue;
    const dec = policy.decisions.find((d) => d.sources.some((s) => s.path === doc.path));
    if (dec && dec.status === "approved") {
      unresolved.push({ owner: dec.id, path: doc.path, reason: `document marks itself superseded (${doc.adr.status_raw}) but policy status is approved` });
      const node = nodes.find((n) => n.id === dec.id);
      if (node) {
        const attrs = JSON.parse(node.attributes_json) as ConstraintAttributes;
        attrs.status = "conflicted";
        node.attributes_json = JSON.stringify(attrs);
      }
    }
  }

  const seenNodeIds = new Set<string>();
  let duplicateNodes = 0;
  for (const n of nodes) {
    if (seenNodeIds.has(n.id)) duplicateNodes++;
    seenNodeIds.add(n.id);
  }
  if (duplicateNodes) raw.limitations.push(`${duplicateNodes} node id collision(s) were ignored (first definition kept).`);
  store.replaceRevision(repoId, revision, nodes, edges, evidence);
  store.upsertRepository({ id: repoId, path: repoPath, head_sha: revision, indexed_at: nowIso() });

  return {
    repo_id: repoId,
    repo_path: repoPath,
    head_sha: revision,
    branch: raw.repo.branch,
    dirty: raw.repo.dirty || isDirty(repoPath),
    policy_id: policy.policy_id,
    counts,
    skipped: raw.skipped,
    limitations: raw.limitations,
    unresolved_sources: unresolved,
  };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
}
