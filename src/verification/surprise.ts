import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Policy } from "../knowledge/policy.ts";
import type { Finding } from "./results.ts";
import { readFilesAtRevision, trackedPythonFiles, type ChangedFile } from "../util/git.ts";
import { resolvePaths, resolvePython } from "../config.ts";

/**
 * Architectural-surprise review signals (spec §7.5). Deterministic triage computed from the diff at verification
 * time by `python/architecture_surprise.py`; findings are review-only and carry `authority: "deterministic"`.
 */

export const SURPRISE_RULE_IDS = {
  new_dependency: "SURPRISE-NEW-DEPENDENCY",
  duplicate_helper: "SURPRISE-DUPLICATE-HELPER",
  api_domain_construction: "SURPRISE-API-DOMAIN-CONSTRUCTION",
} as const;

/** Above this many tracked Python files at base, only the changed files' top-level packages are compared. */
export const MAX_BASE_FILES = 2000;

export interface SurpriseInput {
  snapshot: string;
  /** Repository (or worktree sharing its object store) used to read sources at `baseSha`. */
  repoPath: string;
  baseSha: string;
  changed: ChangedFile[];
  policy: Policy;
}

export interface SurpriseOutput {
  findings: Finding[];
  errors: Array<{ path: string; error: string }>;
  checked_files: number;
  limitations: string[];
}

interface ScriptFinding {
  kind: keyof typeof SURPRISE_RULE_IDS;
  path: string;
  line: number;
  message: string;
  expected: string;
  observed: string;
}

export function moduleNameFor(p: string): string {
  const parts = p.replace(/\.py$/, "").split("/");
  if (parts[parts.length - 1] === "__init__") parts.pop();
  return parts.join(".");
}

export function runArchitecturalSurprise(input: SurpriseInput): SurpriseOutput {
  const limitations: string[] = [];
  const changedPy = input.changed.filter((c) => c.path.endsWith(".py") && c.status !== "deleted").map((c) => c.path);
  if (!changedPy.length) return { findings: [], errors: [], checked_files: 0, limitations };

  const candidate: Record<string, string> = {};
  for (const rel of changedPy) {
    const file = path.join(input.snapshot, rel);
    if (fs.existsSync(file)) candidate[rel] = fs.readFileSync(file, "utf8");
  }

  let basePaths = trackedPythonFiles(input.repoPath, input.baseSha);
  const internalModules = [...new Set(basePaths.map(moduleNameFor))];
  if (basePaths.length > MAX_BASE_FILES) {
    const tops = new Set(changedPy.map((p) => p.split("/")[0]!));
    basePaths = basePaths.filter((p) => tops.has(p.split("/")[0]!));
    limitations.push(`architectural surprise: base revision has more than ${MAX_BASE_FILES} Python files; duplicate-helper comparison limited to the changed files' top-level packages (${[...tops].sort().join(", ")})`);
  }
  const base = Object.fromEntries(readFilesAtRevision(input.repoPath, input.baseSha, [...new Set([...basePaths, ...changedPy])]));

  const payload = JSON.stringify({ base, candidate, changed_paths: Object.keys(candidate), internal_modules: internalModules, config: input.policy.architecture_surprise });
  const script = path.join(resolvePaths().python, "architecture_surprise.py");
  const res = spawnSync(resolvePython(), ["-I", script], { input: payload, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
  if (res.error || res.status !== 0) {
    const error = res.error ? `architecture_surprise.py failed to start: ${res.error.message}` : `architecture_surprise.py exited ${res.status}: ${(res.stderr ?? "").trim()}`;
    limitations.push(`architectural surprise signals not computed: ${error}`);
    return { findings: [], errors: [{ path: "", error }], checked_files: Object.keys(candidate).length, limitations };
  }
  const out = JSON.parse(res.stdout) as { findings: ScriptFinding[]; errors: Array<{ path: string; error: string }> };
  let n = 0;
  const findings: Finding[] = out.findings.map((f) => ({
    id: `F-SURPRISE-${String(++n).padStart(3, "0")}`,
    category: "architecture",
    severity: "review",
    rule_id: SURPRISE_RULE_IDS[f.kind] ?? `SURPRISE-${String(f.kind).toUpperCase().replace(/_/g, "-")}`,
    source_evidence_ids: [],
    test: null,
    expected: f.expected,
    observed: f.observed,
    message: f.message,
    location: `${f.path}:${f.line}`,
    log_path: null,
    authority: "deterministic",
  }));
  return { findings, errors: out.errors, checked_files: Object.keys(candidate).length, limitations };
}
