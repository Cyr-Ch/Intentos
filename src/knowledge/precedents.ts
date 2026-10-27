import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolvePaths, type IntentosPaths } from "../config.ts";
import { git } from "../util/git.ts";
import { nowIso } from "../util/ids.ts";
import { moduleNameFor } from "../verification/surprise.ts";

/**
 * Precedents: resolved tickets and the pull requests that resolved them.
 *
 * A precedent answers "when this repository last faced a task like this, where was the change made, which tests
 * were added, and what did the ticket ask for". It is *evidence of kind historical_precedent*: it informs the
 * planner and the review signals, it never binds a run (only a policy does that). Precedents are fetched from a
 * tracker with `intentos precedents sync`, stored outside the target repository under
 * `<INTENTOS_HOME>/precedents/<repo-id>.json`, and linked to the current graph at every `index`, so a precedent
 * whose touched symbols no longer exist is marked stale at the revision the planner works on.
 */

export const PRECEDENTS_FILE_VERSION = 1;

export interface PrecedentPull {
  number: number;
  url: string;
  title: string;
  body: string | null;
  author: string | null;
  merged_at: string | null;
  merge_sha: string | null;
  /** Computed from the local git history at sync time (null when the merge commit was not available). */
  diff: PullDiff | null;
}

export interface PullDiff {
  /** Revision range the diff was computed from (`<base>..<merge_sha>`). */
  base_sha: string;
  files: Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed" }>;
  /** Qualified names of Python definitions (module.Class.method) that contain changed lines. */
  symbols: string[];
  /** Test functions added by the pull request. */
  tests_added: Array<{ path: string; name: string }>;
}

export interface PrecedentRecord {
  id: string;
  number: number;
  url: string;
  title: string;
  body: string | null;
  labels: string[];
  author: string | null;
  created_at: string | null;
  closed_at: string | null;
  pull: PrecedentPull | null;
}

export interface PrecedentsFile {
  version: number;
  repo_id: string;
  source: { issues: string | null; pulls: string | null; synced_at: string; tool: string };
  precedents: PrecedentRecord[];
}

export function precedentsFile(paths: IntentosPaths, repoId: string): string {
  return path.join(paths.precedents, `${repoId}.json`);
}

export function readPrecedentsFile(file: string): PrecedentsFile | null {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PrecedentsFile>;
  if (parsed.version !== PRECEDENTS_FILE_VERSION || !Array.isArray(parsed.precedents)) throw new Error(`${file}: unsupported precedents file (version ${String(parsed.version)})`);
  return parsed as PrecedentsFile;
}

export function writePrecedentsFile(file: string, data: PrecedentsFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---- diff analysis (local git, no network) ----------------------------------

const PY_DEF = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;

/** Enclosing definitions (outermost first) of a 1-based line in a Python source. */
export function enclosingDefinitions(lines: string[], line: number): string[] {
  const chain: Array<{ indent: number; name: string }> = [];
  let maxIndent = Number.POSITIVE_INFINITY;
  // Is the changed line itself a definition header? Then it belongs to that definition.
  const self = PY_DEF.exec(lines[line - 1] ?? "");
  if (self) {
    chain.push({ indent: self[1]!.length, name: self[3]! });
    maxIndent = self[1]!.length;
  } else {
    const own = /^(\s*)\S/.exec(lines[line - 1] ?? "");
    if (own) maxIndent = own[1]!.length;
    else {
      // Blank line: use the indentation of the next non-blank line below (it is inside the same block or closes it).
      for (let j = line; j < lines.length; j++) {
        const m = /^(\s*)\S/.exec(lines[j]!);
        if (m) {
          maxIndent = m[1]!.length;
          break;
        }
      }
    }
  }
  for (let i = line - 2; i >= 0; i--) {
    const m = PY_DEF.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.length;
    if (indent < maxIndent) {
      chain.push({ indent, name: m[3]! });
      maxIndent = indent;
      if (indent === 0) break;
    }
  }
  return chain.reverse().map((c) => c.name);
}

/** New-file line ranges of every hunk in a unified diff (`@@ -a,b +c,d @@`). */
export function hunkRanges(diff: string): Array<{ start: number; count: number }> {
  const out: Array<{ start: number; count: number }> = [];
  for (const line of diff.split("\n")) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) out.push({ start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) });
  }
  return out;
}

const isTestPath = (p: string): boolean => /(^|\/)tests?\//.test(p) || /(^|\/)test_[^/]*\.py$/.test(p) || /_test\.py$/.test(p);

/**
 * What a merged pull request changed, read from the local object store: files, the Python definitions that
 * contain changed lines (at the merge revision), and the test functions it added. Returns null when the merge
 * commit is not present locally.
 */
export function analyzePullDiff(repoPath: string, mergeSha: string): PullDiff | null {
  if (git(repoPath, ["cat-file", "-e", `${mergeSha}^{commit}`], { allowFail: true }).status !== 0) return null;
  const parents = git(repoPath, ["rev-list", "--parents", "-n", "1", mergeSha]).stdout.trim().split(/\s+/).slice(1);
  const base = parents[0];
  if (!base) return null; // root commit
  const files: PullDiff["files"] = [];
  const status = git(repoPath, ["diff", "--name-status", "-z", "-M", base, mergeSha]).stdout.split("\0").filter(Boolean);
  for (let i = 0; i < status.length; i++) {
    const code = status[i]!;
    if (code.startsWith("R") || code.startsWith("C")) {
      files.push({ path: status[i + 2]!, status: "renamed" });
      i += 2;
      continue;
    }
    const p = status[i + 1]!;
    i += 1;
    files.push({ path: p, status: code === "A" ? "added" : code === "D" ? "deleted" : "modified" });
  }
  const symbols = new Set<string>();
  const testsAdded: PullDiff["tests_added"] = [];
  for (const f of files) {
    if (!f.path.endsWith(".py") || f.status === "deleted") continue;
    const patch = git(repoPath, ["diff", "-U0", base, mergeSha, "--", f.path], { allowFail: true }).stdout;
    if (!patch) continue;
    const sourceRes = git(repoPath, ["show", `${mergeSha}:${f.path}`], { allowFail: true });
    if (sourceRes.status !== 0) continue;
    const lines = sourceRes.stdout.split("\n");
    const module = moduleNameFor(f.path);
    if (isTestPath(f.path)) {
      for (const l of patch.split("\n")) {
        const m = /^\+\s*(?:async\s+)?def\s+(test_[A-Za-z0-9_]*)/.exec(l);
        if (m) testsAdded.push({ path: f.path, name: m[1]! });
      }
      continue;
    }
    for (const h of hunkRanges(patch)) {
      const probe = h.count === 0 ? [h.start] : Array.from({ length: Math.min(h.count, 400) }, (_, k) => h.start + k);
      for (const ln of probe) {
        const chain = enclosingDefinitions(lines, ln);
        if (chain.length) symbols.add(`${module}.${chain.join(".")}`);
      }
    }
  }
  return { base_sha: base, files, symbols: [...symbols].sort(), tests_added: dedupe(testsAdded, (t) => `${t.path}::${t.name}`) };
}

/** Files renamed between two revisions (`old path` → `new path`), as git's rename detection sees them. */
export function renamesBetween(repoPath: string, from: string, to: string): Map<string, string> {
  const out = new Map<string, string>();
  const res = git(repoPath, ["diff", "-M", "--name-status", "-z", "--diff-filter=R", from, to], { allowFail: true });
  if (res.status !== 0) return out;
  const parts = res.stdout.split("\0").filter(Boolean);
  for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i]!.startsWith("R")) out.set(parts[i + 1]!, parts[i + 2]!);
  return out;
}

function dedupe<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    const k = key(it);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---- GitHub sync via the gh CLI ----------------------------------------------

export interface SyncOptions {
  /** `owner/name` of the repository whose closed issues are the tickets. */
  issues: string;
  /** `owner/name` where the pull requests live when it differs from `issues` (a fork whose PRs were merged upstream). */
  pulls?: string | null;
  /** Maximum number of closed issues to fetch (newest first). */
  limit?: number;
  /** Also walk each issue's timeline for cross-referenced pull requests (one API call per issue). */
  timeline?: boolean;
  ghBin?: string;
}

interface GhIssue {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  labels: Array<{ name: string } | string>;
  user: { login: string } | null;
  created_at: string;
  closed_at: string | null;
  state: string;
  pull_request?: unknown;
}

interface GhPull {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  user: { login: string } | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  base?: { repo?: { full_name?: string } };
}

export function ghJsonLines<T>(args: string[], ghBin = "gh"): T[] {
  const res = spawnSync(ghBin, ["api", ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (res.error) throw new Error(`gh failed to start: ${res.error.message} (install the GitHub CLI or pass --gh <path>)`);
  if (res.status !== 0) throw new Error(`gh api ${args.slice(0, 2).join(" ")} exited ${res.status}: ${res.stderr.trim().split("\n")[0] ?? ""}`);
  return res.stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

const PULL_URL = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

/** Pull request references in free text: full URLs, plus `#123` when a default repository is given. */
export function pullRefsInText(text: string | null | undefined, defaultRepo: string | null): Array<{ repo: string; number: number }> {
  if (!text) return [];
  const out = new Map<string, { repo: string; number: number }>();
  for (const m of text.matchAll(PULL_URL)) out.set(`${m[1]}#${m[2]}`, { repo: m[1]!, number: Number(m[2]) });
  if (defaultRepo) {
    // Only "#n" that the text itself presents as a pull request (resolved by / PR / pull request #n).
    for (const m of text.matchAll(/(?:pull request|PR|resolved (?:upstream )?by|merged (?:in|as))\s*\[?#(\d+)/gi)) out.set(`${defaultRepo}#${m[1]}`, { repo: defaultRepo, number: Number(m[1]) });
  }
  return [...out.values()];
}

const truncate = (s: string | null | undefined, max: number): string | null => (s == null ? null : s.length > max ? `${s.slice(0, max)}…` : s);

/**
 * Fetch closed issues (tickets) and the merged pull requests that resolved them; analyse each pull request's
 * diff against the local repository. The result is a {@link PrecedentsFile}; nothing is written here.
 */
export function syncPrecedents(repoPath: string, repoId: string, opts: SyncOptions, log: (line: string) => void = () => {}): PrecedentsFile {
  const gh = opts.ghBin ?? "gh";
  const limit = opts.limit ?? 500;
  const pullsRepo = opts.pulls ?? opts.issues;
  log(`fetching closed issues from ${opts.issues}…`);
  const issues = ghJsonLines<GhIssue>(["--paginate", `repos/${opts.issues}/issues?state=closed&per_page=100`, "-q", ".[] | select(.pull_request == null)"], gh).slice(0, limit);
  log(`${issues.length} closed issue(s)`);
  const pullCache = new Map<string, GhPull | null>();
  const fetchPull = (repo: string, number: number): GhPull | null => {
    const key = `${repo}#${number}`;
    if (pullCache.has(key)) return pullCache.get(key)!;
    let pull: GhPull | null = null;
    try {
      pull = ghJsonLines<GhPull>([`repos/${repo}/pulls/${number}`], gh)[0] ?? null;
    } catch (e) {
      log(`  pull ${key}: ${(e as Error).message}`);
    }
    pullCache.set(key, pull);
    return pull;
  };
  const precedents: PrecedentRecord[] = [];
  for (const issue of issues) {
    const refs = pullRefsInText(issue.body, pullsRepo);
    if (opts.timeline !== false) {
      try {
        const linked = ghJsonLines<{ html_url: string; merged_at?: string | null }>(["--paginate", `repos/${opts.issues}/issues/${issue.number}/timeline?per_page=100`, "-q", '.[] | select(.event == "cross-referenced") | .source.issue | select(.pull_request != null) | {html_url: .html_url}'], gh);
        for (const l of linked) for (const r of pullRefsInText(l.html_url, null)) if (!refs.some((x) => x.repo === r.repo && x.number === r.number)) refs.push(r);
      } catch (e) {
        log(`  issue #${issue.number}: timeline unavailable (${(e as Error).message})`);
      }
    }
    // The resolving pull request: the first merged one among the references (ticket footers list it first).
    let pull: PrecedentPull | null = null;
    for (const r of refs) {
      const p = fetchPull(r.repo, r.number);
      if (!p?.merged_at) continue;
      const diff = p.merge_commit_sha ? analyzePullDiff(repoPath, p.merge_commit_sha) : null;
      pull = { number: p.number, url: p.html_url, title: p.title, body: truncate(p.body, 3000), author: p.user?.login ?? null, merged_at: p.merged_at, merge_sha: p.merge_commit_sha, diff };
      break;
    }
    precedents.push({
      id: `PREC-${issue.number}`,
      number: issue.number,
      url: issue.html_url,
      title: issue.title,
      body: truncate(issue.body, 4000),
      labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
      author: issue.user?.login ?? null,
      created_at: issue.created_at,
      closed_at: issue.closed_at,
      pull,
    });
    log(`  #${issue.number} ${issue.title}${pull ? ` ← PR #${pull.number}${pull.diff ? ` (${pull.diff.files.length} file(s), ${pull.diff.symbols.length} definition(s), ${pull.diff.tests_added.length} test(s) added)` : " (merge commit not in local history)"}` : " (no merged pull request found)"}`);
  }
  precedents.sort((a, b) => a.number - b.number);
  return { version: PRECEDENTS_FILE_VERSION, repo_id: repoId, source: { issues: opts.issues, pulls: opts.pulls ?? null, synced_at: nowIso(), tool: "gh" }, precedents };
}

// ---- linking to the graph at a revision --------------------------------------

export type Staleness = "current" | "partially_stale" | "stale" | "unlinked";

export interface PrecedentAttributes {
  number: number;
  url: string;
  title: string;
  excerpt: string | null;
  labels: string[];
  author: string | null;
  closed_at: string | null;
  pull: { number: number; url: string; title: string; merged_at: string | null; merge_sha: string | null; author: string | null } | null;
  /** `renamed_to`: where the file lives at this revision when git traces a rename from the merge commit. */
  files: Array<{ path: string; status: string; current: boolean; is_test: boolean; renamed_to: string | null }>;
  symbols: Array<{ qualified_name: string; symbol_id: string | null; path: string | null; line_start: number | null; current: boolean; match: "exact" | "renamed" | "name" | "none" }>;
  tests_added: Array<{ path: string; name: string; test_id: string | null; current: boolean }>;
  staleness: Staleness;
  staleness_reasons: string[];
  evidence_id: string;
  source: string;
}

export interface GraphLookup {
  /** Repository-relative files tracked at the revision. */
  files: Set<string>;
  /** Symbol node id by qualified name. */
  symbolByQn: Map<string, { id: string; path: string; line_start: number; name: string }>;
  /** Symbol node ids by (path, bare name) for renamed-container fallbacks. */
  symbolsByPathName: Map<string, string[]>;
  /** Test node id by `path::name`. */
  testByKey: Map<string, string>;
  /** Module node id by path. */
  moduleByPath: Map<string, string>;
}

/**
 * Resolve one precedent against the graph of the current revision; pure, no I/O. `renames` maps a path at the merge
 * commit to its path at this revision (from `git diff -M` between the two), so a precedent survives a package rename.
 */
export function linkPrecedent(rec: PrecedentRecord, lookup: GraphLookup, evidenceIdValue: string, renames: Map<string, string> = new Map()): PrecedentAttributes {
  const diff = rec.pull?.diff ?? null;
  const files: PrecedentAttributes["files"] = (diff?.files ?? []).map((f) => {
    let renamedTo = renames.get(f.path) ?? null;
    if (renamedTo && !lookup.files.has(renamedTo)) renamedTo = null;
    // git's rename detection gives up when a file changed too much since the merge; a package move keeps the
    // path tail (`bdew/elec_slp.py`), so a unique file with the longest shared tail is taken as the same file.
    if (!renamedTo && f.status !== "deleted" && !lookup.files.has(f.path) && f.path.endsWith(".py")) renamedTo = sameFileByTail(f.path, lookup.files);
    const current = f.status === "deleted" ? false : lookup.files.has(f.path) || renamedTo !== null;
    return { path: f.path, status: f.status, current, is_test: isTestPath(f.path), renamed_to: renamedTo };
  });
  const byId = new Map([...lookup.symbolByQn.values()].map((s) => [s.id, s]));
  /** The diff file a qualified name was extracted from: the longest module prefix among the touched Python files. */
  const fileOf = (qn: string): PrecedentAttributes["files"][number] | null => {
    let best: PrecedentAttributes["files"][number] | null = null;
    let bestLen = -1;
    for (const f of files) {
      if (!f.path.endsWith(".py")) continue;
      const mod = moduleNameFor(f.path);
      if ((qn === mod || qn.startsWith(`${mod}.`)) && mod.length > bestLen) {
        best = f;
        bestLen = mod.length;
      }
    }
    return best;
  };
  const symbols: PrecedentAttributes["symbols"] = (diff?.symbols ?? []).map((qn) => {
    const exact = lookup.symbolByQn.get(qn);
    if (exact) return { qualified_name: qn, symbol_id: exact.id, path: exact.path, line_start: exact.line_start, current: true, match: "exact" };
    const origin = fileOf(qn);
    const home = origin?.renamed_to ?? origin?.path ?? null;
    if (origin?.renamed_to) {
      // Same definition under the file's new module name.
      const moved = `${moduleNameFor(origin.renamed_to)}${qn.slice(moduleNameFor(origin.path).length)}`;
      const hit = lookup.symbolByQn.get(moved);
      if (hit) return { qualified_name: qn, symbol_id: hit.id, path: hit.path, line_start: hit.line_start, current: true, match: "renamed" };
    }
    // Container renamed or the function moved within the file: same bare name in the file the precedent touched.
    const bare = qn.split(".").pop()!;
    for (const p of home ? [home] : files.map((f) => f.renamed_to ?? f.path)) {
      const first = (lookup.symbolsByPathName.get(`${p}\0${bare}`) ?? [])[0];
      if (first) {
        const sym = byId.get(first);
        return { qualified_name: qn, symbol_id: first, path: sym?.path ?? p, line_start: sym?.line_start ?? null, current: true, match: "name" };
      }
    }
    return { qualified_name: qn, symbol_id: null, path: null, line_start: null, current: false, match: "none" };
  });
  const tests = (diff?.tests_added ?? []).map((t) => {
    const id = lookup.testByKey.get(`${t.path}::${t.name}`) ?? null;
    return { path: t.path, name: t.name, test_id: id, current: id !== null };
  });
  const reasons: string[] = [];
  let staleness: Staleness;
  if (!diff) {
    staleness = "unlinked";
    reasons.push(rec.pull ? "merge commit not available locally; precedent is text-only" : "no merged pull request linked; precedent is text-only");
  } else {
    const codeFiles = files.filter((f) => !f.is_test && f.status !== "deleted");
    const missingFiles = codeFiles.filter((f) => !f.current);
    const missingSymbols = symbols.filter((s) => !s.current);
    if (codeFiles.length && missingFiles.length === codeFiles.length) {
      staleness = "stale";
      reasons.push(`none of the files it changed exist at this revision (${missingFiles.map((f) => f.path).join(", ")})`);
    } else if (symbols.length && missingSymbols.length === symbols.length) {
      staleness = "stale";
      reasons.push(`none of the definitions it changed exist at this revision (${missingSymbols.map((s) => s.qualified_name).join(", ")})`);
    } else if (missingFiles.length || missingSymbols.length) {
      staleness = "partially_stale";
      if (missingFiles.length) reasons.push(`file(s) no longer present: ${missingFiles.map((f) => f.path).join(", ")}`);
      if (missingSymbols.length) reasons.push(`definition(s) no longer present: ${missingSymbols.map((s) => s.qualified_name).join(", ")}`);
    } else staleness = "current";
    const moved = files.filter((f) => f.renamed_to);
    if (moved.length) reasons.push(`file(s) renamed since the pull request: ${moved.map((f) => `${f.path} → ${f.renamed_to}`).join(", ")}`);
    const byName = symbols.filter((s) => s.match === "name");
    if (byName.length) reasons.push(`matched by bare name only (container renamed or moved): ${byName.map((s) => s.qualified_name).join(", ")}`);
  }
  return {
    number: rec.number,
    url: rec.url,
    title: rec.title,
    excerpt: rec.body ? firstParagraphs(rec.body, 500) : null,
    labels: rec.labels,
    author: rec.author,
    closed_at: rec.closed_at,
    pull: rec.pull ? { number: rec.pull.number, url: rec.pull.url, title: rec.pull.title, merged_at: rec.pull.merged_at, merge_sha: rec.pull.merge_sha, author: rec.pull.author } : null,
    files,
    symbols,
    tests_added: tests,
    staleness,
    staleness_reasons: reasons,
    evidence_id: evidenceIdValue,
    source: rec.url,
  };
}

/** The unique current file sharing the longest path tail with `p` (at least `<dir>/<name>`), or null. */
export function sameFileByTail(p: string, files: Set<string>): string | null {
  const parts = p.split("/");
  for (let n = parts.length; n >= 2; n--) {
    const tail = `/${parts.slice(-n).join("/")}`;
    const hits = [...files].filter((f) => f.endsWith(tail) || f === tail.slice(1));
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) return null; // ambiguous at every shorter tail too
  }
  return null;
}

/** Qualified name a resolved symbol has now (its node id without the `SY:` prefix), or the recorded one. */
export function currentName(sym: PrecedentAttributes["symbols"][number]): string {
  return sym.symbol_id?.startsWith("SY:") ? sym.symbol_id.slice(3) : sym.qualified_name;
}

/** Body text without the reconstruction footer and Markdown headings, cut at a paragraph boundary. */
export function firstParagraphs(body: string, max: number): string {
  const cleaned = body
    .split(/\n-{3,}\n/)[0]!
    .replace(/^#+\s*/gm, "")
    .replace(/\r/g, "")
    .trim();
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max);
  const para = cut.lastIndexOf("\n\n");
  return `${(para > max / 2 ? cut.slice(0, para) : cut).trim()}…`;
}

export function defaultPrecedentsPath(repoId: string, paths: IntentosPaths = resolvePaths()): string {
  return precedentsFile(paths, repoId);
}
