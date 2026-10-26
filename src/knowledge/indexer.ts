import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePaths, resolvePython, type IntentosPaths } from "../config.ts";
import { evidenceId, nowIso, sha256, shortHash } from "../util/ids.ts";
import { git, headSha, isDirty, isGitRepo, repoToplevel } from "../util/git.ts";
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
  /** Set by `--only-files` runs: only `only_files` were parsed; `files`/`modules` still describe the whole tree. */
  partial?: boolean;
  only_files?: string[];
}

export function repoIdFor(repoPath: string): string {
  return `repo-${shortHash(fs.realpathSync(repoPath), 12)}`;
}

export interface PythonIndexerOptions {
  /** Parse only these repository-relative paths (partial extraction used by incremental indexing). */
  onlyFiles?: string[];
}

export function runPythonIndexer(repoPath: string, paths: IntentosPaths = resolvePaths(), opts: PythonIndexerOptions = {}): RawIndex {
  const script = path.join(paths.python, "index_repo.py");
  const args = ["-I", script, repoPath];
  let tmpDir: string | null = null;
  if (opts.onlyFiles) {
    // The file list travels through a JSON file, never through the command line.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "intentos-only-files-"));
    const listFile = path.join(tmpDir, "only_files.json");
    fs.writeFileSync(listFile, JSON.stringify(opts.onlyFiles));
    args.push("--only-files", listFile);
  }
  try {
    const res = spawnSync(resolvePython(paths), args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (res.error) throw new Error(`Failed to start Python indexer: ${res.error.message}`);
    if (res.status !== 0) throw new Error(`Python indexer exited ${res.status}: ${res.stderr.trim() || res.stdout.trim()}`);
    const parsed = JSON.parse(res.stdout) as RawIndex | { error: string };
    if ("error" in parsed) throw new Error(`Python indexer error: ${parsed.error}`);
    if (opts.onlyFiles && parsed.partial !== true) throw new Error("Python indexer ignored --only-files (no partial marker in its output)");
    return parsed;
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---- incremental indexing: raw extraction cache + blob diff -----------------

/** Mirrors the extractor: only these files are parsed, and these basenames are never read. */
const IGNORED_BASENAMES = new Set([".env", ".env.local", ".env.production", "id_rsa", "credentials.json"]);
const isIndexedFile = (p: string): boolean => (p.endsWith(".py") || p.toLowerCase().endsWith(".md")) && !IGNORED_BASENAMES.has(path.posix.basename(p));

const INDEX_CACHE_VERSION = 1;
/** Fraction of indexed files above which an incremental run is not worth it. */
const INCREMENTAL_MAX_CHANGED_RATIO = 0.6;

export interface IndexCacheFile {
  version: number;
  repo_id: string;
  revision: string;
  written_at: string;
  /** git blob id per indexed file at `revision` (from `git ls-tree -r`). */
  blobs: Record<string, string>;
  /** Complete (never partial) raw extraction for `revision`. */
  raw: RawIndex;
}

export interface IncrementalPlan {
  previous: string;
  changed: string[];
  deleted: string[];
  carried: string[];
}

/** Blob ids of the indexable files (`.py`, `.md`) at a revision. */
export function listIndexedBlobs(repoPath: string, revision: string): Record<string, string> {
  const blobs: Record<string, string> = {};
  for (const entry of git(repoPath, ["ls-tree", "-r", "-z", revision]).stdout.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, sha] = entry.slice(0, tab).split(" ");
    const file = entry.slice(tab + 1);
    if (!mode || type !== "blob" || !sha || !isIndexedFile(file)) continue;
    blobs[file] = sha;
  }
  return blobs;
}

export function indexCacheFile(paths: IntentosPaths, repoId: string, revision: string): string {
  return path.join(paths.indexCache, repoId, `${revision}.json`);
}

export function readIndexCache(file: string, repoId: string, revision: string): IndexCacheFile | null {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<IndexCacheFile>;
    if (parsed.version !== INDEX_CACHE_VERSION || parsed.repo_id !== repoId || parsed.revision !== revision) return null;
    if (!parsed.blobs || typeof parsed.blobs !== "object" || !parsed.raw || parsed.raw.partial) return null;
    return parsed as IndexCacheFile;
  } catch {
    return null;
  }
}

/** Compare the blobs of `previous` (from its cache) with HEAD's; null when the change is too large to be worth it. */
export function planIncremental(prevBlobs: Record<string, string>, headBlobs: Record<string, string>, previous: string): IncrementalPlan | { tooLarge: { changed: number; total: number } } {
  const changed: string[] = [];
  const carried: string[] = [];
  const deleted: string[] = [];
  for (const [file, sha] of Object.entries(headBlobs)) (prevBlobs[file] === sha ? carried : changed).push(file);
  for (const file of Object.keys(prevBlobs)) if (!(file in headBlobs)) deleted.push(file);
  const total = Object.keys(headBlobs).length;
  if (total > 0 && changed.length > INCREMENTAL_MAX_CHANGED_RATIO * total) return { tooLarge: { changed: changed.length, total } };
  return { previous, changed: changed.sort(), deleted: deleted.sort(), carried: carried.sort() };
}

/**
 * Merge the cached raw extraction of the previous revision with a partial extraction of the changed files.
 * Carried entries are taken from the cache only for files whose blob id is unchanged; everything from a changed
 * or deleted file comes from the partial run (or is dropped). The result is ordered like a full extraction
 * (all `.py` files, then all `.md` files, in `git ls-files` order), so the graph builder sees identical input.
 */
export function mergeRawIndex(prevRaw: RawIndex, partialRaw: RawIndex, plan: IncrementalPlan): RawIndex {
  const carried = new Set(plan.carried);
  const deleted = new Set(plan.deleted);
  const keep = <T extends { path: string }>(rows: T[]): T[] => rows.filter((r) => carried.has(r.path) && !deleted.has(r.path));
  const order = new Map<string, number>();
  [...partialRaw.files.filter((f) => f.endsWith(".py")), ...partialRaw.files.filter((f) => f.toLowerCase().endsWith(".md"))].forEach((f, i) => order.set(f, i));
  const rank = (file: string): number => order.get(file) ?? Number.MAX_SAFE_INTEGER;
  const inExtractionOrder = <T extends { path: string }>(rows: T[]): T[] =>
    rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r.path) - rank(b.r.path) || a.i - b.i).map((x) => x.r);
  return {
    repo: partialRaw.repo,
    files: partialRaw.files,
    modules: partialRaw.modules,
    symbols: inExtractionOrder([...keep(prevRaw.symbols), ...partialRaw.symbols]),
    imports: inExtractionOrder([...keep(prevRaw.imports), ...partialRaw.imports]),
    calls: inExtractionOrder([...keep(prevRaw.calls), ...partialRaw.calls]),
    docs: inExtractionOrder([...keep(prevRaw.docs), ...partialRaw.docs]),
    tests: inExtractionOrder([...keep(prevRaw.tests), ...partialRaw.tests]),
    skipped: inExtractionOrder([...keep(prevRaw.skipped), ...partialRaw.skipped]),
    limitations: [
      ...partialRaw.limitations,
      `incremental: ${plan.carried.length} file(s) carried from ${plan.previous.slice(0, 7)} after blob-id checks; ${plan.changed.length} re-extracted, ${plan.deleted.length} deleted`,
    ],
  };
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
  sources: Array<
    SourceRef & {
      evidence_id: string | null;
      resolved: boolean;
      status: EpistemicStatus;
      /** Hash of the section text at this revision (null when the section was not found). */
      content_hash: string | null;
      /** Hash the section had when it was last approved (policy pin, or the hash first bound); the source is `conflicted` while it differs. */
      approved_content_hash: string | null;
    }
  >;
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
  /** `incremental` when only changed files were re-extracted and the rest carried from the previous revision's cache. */
  mode: "full" | "incremental";
  previous_revision: string | null;
  /** Files (re-)extracted this run; in full mode every indexed file. */
  changed_files: string[];
  deleted_files: string[];
  carried_files: string[];
  /** Raw extraction cache written for this revision (null when the working tree was dirty). */
  cache_file: string | null;
}

export interface IndexOptions {
  paths?: IntentosPaths;
  policy?: Policy | null;
  /** Force a full re-extraction even when an incremental run is possible. */
  full?: boolean;
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

/**
 * Index a repository at HEAD and persist the graph bound to the trusted policy.
 *
 * When the repository was indexed before, its raw extraction is cached and the working tree is clean, only files
 * whose git blob id changed are re-extracted; unchanged files are carried from the cache (explicitly, after the
 * blob-id check) and the graph is rebuilt for HEAD from the merged extraction. Policy-bound sections are
 * re-validated against the hash bound at the previous revision: a changed section becomes `conflicted` until a
 * human re-approves it (spec §6.4 — never transfer an assertion as current without checking its source).
 */
export function indexRepository(store: KnowledgeStore, repoPathInput: string, opts: IndexOptions = {}): IndexSummary {
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
  const repoId = repoIdFor(repoPath);
  const existing = store.getRepository(repoId);
  // The previous revision is only usable when its graph is still stored.
  const previous = existing && store.indexedRevisions(repoId).includes(existing.head_sha) ? existing.head_sha : null;
  const dirtyNow = isDirty(repoPath);
  const headBlobs = listIndexedBlobs(repoPath, revision);

  // --- decide between incremental and full extraction
  const fallbackNotes: string[] = [];
  let plan: IncrementalPlan | null = null;
  let prevCache: IndexCacheFile | null = null;
  if (opts.full) fallbackNotes.push("full re-index: requested with --full");
  else if (!previous) fallbackNotes.push("full index: no previous revision indexed for this repository (incremental mode needs one)");
  else if (dirtyNow) fallbackNotes.push("full re-index: working tree has uncommitted changes (incremental mode needs a clean tree)");
  else {
    prevCache = readIndexCache(indexCacheFile(paths, repoId, previous), repoId, previous);
    if (!prevCache) fallbackNotes.push(`full re-index: no extraction cache for previous revision ${previous.slice(0, 7)}`);
    else {
      const planned = planIncremental(prevCache.blobs, headBlobs, previous);
      if ("tooLarge" in planned) {
        fallbackNotes.push(`full re-index: ${planned.tooLarge.changed} of ${planned.tooLarge.total} indexed files changed since ${previous.slice(0, 7)} (over ${Math.round(INCREMENTAL_MAX_CHANGED_RATIO * 100)}%)`);
      } else plan = planned;
    }
  }

  let raw: RawIndex;
  if (plan && prevCache) {
    const partial = runPythonIndexer(repoPath, paths, { onlyFiles: plan.changed });
    if (partial.repo.head_sha !== revision) throw new Error(`HEAD moved during indexing (${revision} -> ${partial.repo.head_sha}); retry.`);
    raw = mergeRawIndex(prevCache.raw, partial, plan);
  } else {
    raw = runPythonIndexer(repoPath, paths);
    if (raw.repo.head_sha !== revision) throw new Error(`HEAD moved during indexing (${revision} -> ${raw.repo.head_sha}); retry.`);
    raw.limitations.push(...fallbackNotes);
  }

  // Register the repository row first (decisions reference it); head_sha is finalized after the graph is stored.
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
  /** Sources of the same constraint as bound at the previous revision (for change detection across revisions). */
  const previousSources = (ownerId: string): ConstraintAttributes["sources"] | null => {
    if (!previous) return null;
    const row = store.node(repoId, previous, ownerId);
    if (!row) return null;
    try {
      const attrs = JSON.parse(row.attributes_json) as Partial<ConstraintAttributes>;
      return Array.isArray(attrs.sources) ? attrs.sources : null;
    } catch {
      return null;
    }
  };
  const sameSource = (a: SourceRef, b: SourceRef): boolean =>
    a.path === b.path && (a.heading ?? null) === (b.heading ?? null) && (a.line_start ?? null) === (b.line_start ?? null);
  const resolveSources = (owner: string, sources: SourceRef[], authority: Authority) => {
    const out: ConstraintAttributes["sources"] = [];
    const prevSources = previousSources(owner);
    for (const src of sources) {
      const prevSrc = prevSources?.find((p) => sameSource(p, src)) ?? null;
      // Carry the approved hash through a "not found" period so a section that reappears is still checked.
      const carriedApproval = { approved_content_hash: prevSrc?.approved_content_hash ?? null };
      const sections = sectionsByPath.get(src.path);
      if (!sections) {
        unresolved.push({ owner, path: src.path, heading: src.heading, reason: "document not found in repository at this revision" });
        out.push({ ...src, evidence_id: null, resolved: false, status: "conflicted", content_hash: null, ...carriedApproval });
        continue;
      }
      let sec: RawDocSection | undefined;
      if (src.heading) sec = sections.find((s) => s.heading.toLowerCase() === src.heading!.toLowerCase());
      else if (src.line_start) sec = sections.find((s) => s.line_start <= src.line_start! && s.line_end >= src.line_start!);
      else sec = sections[0];
      if (!sec) {
        unresolved.push({ owner, path: src.path, heading: src.heading, reason: "heading not found at this revision" });
        out.push({ ...src, evidence_id: null, resolved: false, status: "conflicted", content_hash: null, ...carriedApproval });
        continue;
      }
      const evId = sectionEvidence.get(sec.id)!;
      let status: EpistemicStatus = "confirmed";
      let changedSinceApproval = false;
      let approvedHash: string | null = sec.content_hash;
      if (src.content_sha256) {
        // A policy pin is the human's approval; it wins over anything recorded at earlier revisions.
        approvedHash = src.content_sha256;
        if (src.content_sha256 !== sec.content_hash) {
          status = "conflicted";
          unresolved.push({ owner, path: src.path, heading: src.heading, reason: "section content changed since the policy pinned it" });
        }
      } else if (carriedApproval.approved_content_hash) {
        approvedHash = carriedApproval.approved_content_hash;
        if (approvedHash !== sec.content_hash) {
          // Never transfer an assertion as current when its source changed: conflicted until re-approved
          // (pin the new content_sha256 in the policy, or edit the section back).
          status = "conflicted";
          changedSinceApproval = true;
          unresolved.push({ owner, path: src.path, heading: src.heading, reason: `section content changed since ${(previous ?? revision).slice(0, 7)}; re-approve or pin content_sha256` });
        }
      }
      // Upgrade the bound section's evidence authority: it is now backed by trusted policy.
      const row = evidence.find((e) => e.id === evId);
      if (row && status === "confirmed") {
        row.authority = authority;
        row.status = row.status === "superseded" ? "superseded" : "confirmed";
      } else if (row && status === "conflicted") {
        row.status = "conflicted";
        if (changedSinceApproval) row.authority = authority;
      }
      out.push({ ...src, evidence_id: evId, resolved: true, status, content_hash: sec.content_hash, approved_content_hash: approvedHash });
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

  // Cache the complete raw extraction for the next incremental run. Only a clean tree is cached: the extractor
  // reads the working copy, and a cache must describe exactly the blobs recorded for `revision`.
  const dirty = raw.repo.dirty || dirtyNow;
  let cacheFile: string | null = null;
  if (!dirty) {
    cacheFile = indexCacheFile(paths, repoId, revision);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const cache: IndexCacheFile = { version: INDEX_CACHE_VERSION, repo_id: repoId, revision, written_at: nowIso(), blobs: headBlobs, raw: { ...raw, partial: false, only_files: [] } };
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  }

  return {
    repo_id: repoId,
    repo_path: repoPath,
    head_sha: revision,
    branch: raw.repo.branch,
    dirty,
    policy_id: policy.policy_id,
    counts,
    skipped: raw.skipped,
    limitations: raw.limitations,
    unresolved_sources: unresolved,
    mode: plan ? "incremental" : "full",
    previous_revision: previous,
    changed_files: plan ? plan.changed : Object.keys(headBlobs).sort(),
    deleted_files: plan ? plan.deleted : [],
    carried_files: plan ? plan.carried : [],
    cache_file: cacheFile,
  };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
}
