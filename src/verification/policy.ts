import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Policy, PolicyArchitectureRule } from "../knowledge/policy.ts";
import type { ChangeContract } from "../contracts/schemas.ts";
import type { Finding } from "./results.ts";
import { matchesAny } from "../util/paths.ts";
import type { ChangedFile } from "../util/git.ts";
import { resolvePaths, resolvePython } from "../config.ts";

export interface ArchitectureCheckOutput {
  findings: Finding[];
  checked_files: number;
  errors: Array<{ path: string; error: string }>;
}

/**
 * Runs the deterministic architecture rules bound in the contract against the snapshot.
 * Rule definitions come from trusted policy, never from the repository or the model.
 */
export function runArchitectureRules(snapshot: string, policy: Policy, contract: ChangeContract, changed: ChangedFile[], evidenceFor: (id: string) => string[]): ArchitectureCheckOutput {
  const findings: Finding[] = [];
  const bound = new Map(contract.architecture_constraints.map((c) => [c.id, c.enforcement]));
  const rules: PolicyArchitectureRule[] = policy.architecture_rules.filter((r) => bound.has(r.id));
  const changedPaths = changed.map((c) => c.path);
  let counter = 0;
  const nextId = () => `F-ARCH-${String(++counter).padStart(3, "0")}`;

  // frozen_paths: evaluated from the Git diff.
  for (const rule of rules.filter((r) => r.kind === "frozen_paths")) {
    for (const c of changed) {
      if (matchesAny(c.path, rule.paths)) {
        findings.push({
          id: nextId(),
          category: "architecture",
          severity: bound.get(rule.id) === "blocking" ? "blocking" : "review",
          rule_id: rule.id,
          source_evidence_ids: evidenceFor(rule.id),
          test: null,
          expected: `no changes under ${rule.paths.join(", ")}`,
          observed: `${c.status} ${c.path}`,
          message: `${rule.statement} (${c.status}: ${c.path})`,
          location: c.path,
          log_path: null,
          authority: "trusted_policy",
        });
      }
    }
  }

  const astRules = rules.filter((r) => r.kind !== "frozen_paths");
  let checked = 0;
  const errors: ArchitectureCheckOutput["errors"] = [];
  if (astRules.length) {
    const script = path.join(resolvePaths().python, "architecture_rules.py");
    const payload = JSON.stringify({ root: snapshot, rules: astRules, changed_files: changedPaths });
    const res = spawnSync(resolvePython(), ["-I", script], { input: payload, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0) {
      errors.push({ path: "", error: `architecture_rules.py exited ${res.status}: ${res.stderr.trim()}` });
    } else {
      const out = JSON.parse(res.stdout) as { findings: Array<{ rule_id: string; kind: string; path: string; line: number; message: string; in_changed_file: boolean }>; checked_files: number; errors: ArchitectureCheckOutput["errors"] };
      checked = out.checked_files;
      errors.push(...out.errors);
      for (const f of out.findings) {
        findings.push({
          id: nextId(),
          category: "architecture",
          severity: bound.get(f.rule_id) === "blocking" ? "blocking" : "review",
          rule_id: f.rule_id,
          source_evidence_ids: evidenceFor(f.rule_id),
          test: null,
          expected: policy.architecture_rules.find((r) => r.id === f.rule_id)?.statement ?? null,
          observed: f.message,
          message: f.message + (f.in_changed_file ? "" : " [pre-existing: file not changed in this run]"),
          location: `${f.path}:${f.line}`,
          log_path: null,
          authority: "trusted_policy",
        });
      }
    }
  }
  return { findings, checked_files: checked, errors };
}

/** Scope check: every change must be inside allowed paths and outside protected paths; test removals are flagged for review. */
export function runScopeCheck(changed: ChangedFile[], contract: ChangeContract, diffText: string): { findings: Finding[]; changed_files: Array<{ path: string; status: string; in_scope: boolean; protected: boolean }> } {
  const findings: Finding[] = [];
  let counter = 0;
  const nextId = () => `F-SCOPE-${String(++counter).padStart(3, "0")}`;
  const rows = changed.map((c) => {
    const inScope = matchesAny(c.path, contract.allowed_paths);
    const prot = matchesAny(c.path, contract.protected_paths);
    if (prot) {
      findings.push({ id: nextId(), category: "scope", severity: "blocking", rule_id: "SCOPE-PROTECTED", source_evidence_ids: [], test: null, expected: "protected path untouched", observed: `${c.status} ${c.path}`, message: `protected path modified: ${c.path}`, location: c.path, log_path: null, authority: "deterministic" });
    } else if (!inScope) {
      findings.push({ id: nextId(), category: "scope", severity: "blocking", rule_id: "SCOPE-ALLOWLIST", source_evidence_ids: [], test: null, expected: `changes within ${contract.allowed_paths.join(", ")}`, observed: `${c.status} ${c.path}`, message: `file outside the contract's allowed paths: ${c.path}`, location: c.path, log_path: null, authority: "deterministic" });
    }
    if (/(^|\/)tests?\//.test(c.path) && c.status === "deleted") {
      findings.push({ id: nextId(), category: "process", severity: "review", rule_id: "TESTS-DELETED", source_evidence_ids: [], test: null, expected: "existing tests preserved", observed: `deleted ${c.path}`, message: `existing test file deleted: ${c.path}`, location: c.path, log_path: null, authority: "deterministic" });
    }
    return { path: c.path, status: c.status, in_scope: inScope, protected: prot };
  });
  // Removed lines inside pre-existing test files indicate weakened tests.
  for (const file of diffFiles(diffText)) {
    if (!/(^|\/)tests?\//.test(file.path) || file.isNew) continue;
    const removedAsserts = file.removed.filter((l) => /^\s*(assert|def test_|@pytest\.mark)/.test(l));
    if (removedAsserts.length) {
      findings.push({ id: nextId(), category: "process", severity: "review", rule_id: "TESTS-WEAKENED", source_evidence_ids: [], test: null, expected: "existing assertions preserved", observed: `${removedAsserts.length} assertion/test line(s) removed in ${file.path}`, message: `existing test lines removed in ${file.path}: ${removedAsserts.slice(0, 3).map((l) => l.trim()).join(" | ")}`, location: file.path, log_path: null, authority: "deterministic" });
    }
  }
  return { findings, changed_files: rows };
}

function diffFiles(diff: string): Array<{ path: string; isNew: boolean; removed: string[] }> {
  const out: Array<{ path: string; isNew: boolean; removed: string[] }> = [];
  let current: { path: string; isNew: boolean; removed: string[] } | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/ b\/(.+)$/);
      current = { path: m?.[1] ?? "", isNew: false, removed: [] };
      out.push(current);
    } else if (current && line.startsWith("new file mode")) current.isNew = true;
    else if (current && line.startsWith("-") && !line.startsWith("---")) current.removed.push(line.slice(1));
  }
  return out;
}
