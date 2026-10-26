import type { EvidencePack, ConstraintHit } from "../knowledge/retrieval.ts";
import type { Policy } from "../knowledge/policy.ts";
import { ChangeContractSchema, type ChangeContract } from "./schemas.ts";
import { GLOBAL_PROTECTED_PATTERNS, globToRegExp, isSafeRelativePattern, matchesAny, normalizeRel } from "../util/paths.ts";
import { canonicalJson, sha256 } from "../util/ids.ts";

export type Route = "implement" | "clarify" | "abstain" | "reject";

export interface ValidationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
}

export interface CompiledContract {
  route: Route;
  contract: ChangeContract | null;
  contract_hash: string | null;
  issues: ValidationIssue[];
  /** Deterministic additions made by the compiler (trusted policy enforcement, not model output). */
  injected: { invariants: string[]; architecture_constraints: string[]; verification: string[]; protected_paths: string[] };
  /** Constraints the compiler will enforce as blocking regardless of what the planner said. */
  enforced_blocking: string[];
}

const TRUSTED_AUTHORITIES = new Set(["approved_policy", "approved_decision", "executable_contract"]);

/**
 * Deterministic contract compilation. Rejects fabricated IDs, stale revisions, unsafe or
 * protected paths, unknown commands and blocking constraints without trusted authority;
 * injects every applicable trusted constraint and required verification command so that
 * enforcement never depends on what the model chose to include.
 */
export function compileContract(raw: unknown, pack: EvidencePack, policy: Policy, opts: { hasTaskTests: boolean }): CompiledContract {
  const issues: ValidationIssue[] = [];
  const injected = { invariants: [] as string[], architecture_constraints: [] as string[], verification: [] as string[], protected_paths: [] as string[] };
  const parsed = ChangeContractSchema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) issues.push({ code: "schema", severity: "error", message: i.message, path: i.path.join(".") });
    return { route: "reject", contract: null, contract_hash: null, issues, injected, enforced_blocking: [] };
  }
  const c = structuredClone(parsed.data);
  const err = (code: string, message: string, path?: string) => issues.push({ code, severity: "error", message, path });
  const warn = (code: string, message: string, path?: string) => issues.push({ code, severity: "warning", message, path });

  // 1. Revision
  if (c.base_revision !== pack.revision) err("revision_mismatch", `contract base_revision ${c.base_revision} != indexed revision ${pack.revision}`, "base_revision");

  // 2. Known IDs
  const knownEvidence = new Set(Object.keys(pack.evidence_index));
  const knownSymbols = new Set(pack.reusable_symbols.map((s) => s.symbol_id));
  const invariantsById = new Map(pack.invariants.map((i) => [i.id, i]));
  const rulesById = new Map(pack.architecture_rules.map((r) => [r.id, r]));
  const checkEvidence = (ids: string[], where: string) => {
    for (const id of ids) if (!knownEvidence.has(id)) err("unknown_evidence", `evidence id ${id} is not in the evidence pack (fabricated or out of scope)`, where);
  };
  c.requirements.forEach((r, i) => {
    checkEvidence(r.evidence_ids, `requirements[${i}]`);
    if (r.certainty === "confirmed" && r.evidence_ids.length === 0) {
      warn("uncited_confirmed", `requirement ${r.id} is marked confirmed without evidence; downgraded to hypothesized`, `requirements[${i}]`);
      r.certainty = "hypothesized";
    }
  });
  c.reuse_candidates.forEach((r, i) => {
    if (!knownSymbols.has(r.symbol_id)) err("unknown_symbol", `symbol ${r.symbol_id} is not in the evidence pack`, `reuse_candidates[${i}]`);
    checkEvidence(r.evidence_ids, `reuse_candidates[${i}]`);
  });

  const checkConstraintRefs = (refs: Array<{ id: string; evidence_ids: string[]; enforcement: "blocking" | "advisory" }>, table: Map<string, ConstraintHit>, kind: string) => {
    refs.forEach((ref, i) => {
      const hit = table.get(ref.id);
      if (!hit) {
        err(`unknown_${kind}`, `${ref.id} is not an applicable ${kind} in the evidence pack`, `${kind}s[${i}]`);
        return;
      }
      for (const id of ref.evidence_ids) {
        if (!hit.evidence_ids.includes(id)) err("evidence_not_linked", `evidence ${id} is not linked to ${ref.id}`, `${kind}s[${i}]`);
      }
      if (ref.enforcement === "blocking" && !TRUSTED_AUTHORITIES.has(hit.authority)) {
        err("untrusted_blocking", `${ref.id} cannot be blocking: authority is ${hit.authority}`, `${kind}s[${i}]`);
      }
      if (ref.enforcement === "blocking" && hit.status !== "confirmed") {
        err("unconfirmed_blocking", `${ref.id} cannot be blocking: status is ${hit.status}`, `${kind}s[${i}]`);
      }
      if (ref.enforcement === "advisory" && hit.binding) {
        warn("downgrade_rejected", `${ref.id} is blocking by trusted policy; planner's advisory setting ignored`, `${kind}s[${i}]`);
        ref.enforcement = "blocking";
      }
      if (ref.evidence_ids.length === 0) ref.evidence_ids = [...hit.evidence_ids];
    });
  };
  checkConstraintRefs(c.business_invariants, invariantsById, "invariant");
  checkConstraintRefs(c.architecture_constraints, rulesById, "architecture_constraint");

  // 3. Inject applicable trusted constraints the planner omitted.
  for (const inv of pack.invariants) {
    if (!inv.binding) continue;
    if (!c.business_invariants.some((b) => b.id === inv.id)) {
      c.business_invariants.push({ id: inv.id, evidence_ids: [...inv.evidence_ids], enforcement: "blocking" });
      injected.invariants.push(inv.id);
    }
  }
  for (const rule of pack.architecture_rules) {
    if (!rule.binding) continue;
    if (!c.architecture_constraints.some((a) => a.id === rule.id)) {
      c.architecture_constraints.push({ id: rule.id, evidence_ids: [...rule.evidence_ids], enforcement: "blocking" });
      injected.architecture_constraints.push(rule.id);
    }
  }

  // 4. Paths
  const universe = policy.default_allowed_paths;
  const protectedAll = [...policy.protected_paths, ...GLOBAL_PROTECTED_PATTERNS];
  c.allowed_paths = c.allowed_paths.map(normalizeRel);
  for (const p of c.allowed_paths) {
    if (!isSafeRelativePattern(p)) {
      err("unsafe_path", `allowed path "${p}" is absolute or contains traversal`, "allowed_paths");
      continue;
    }
    if (!withinUniverse(p, universe)) err("outside_universe", `allowed path "${p}" is outside the policy allowlist (${universe.join(", ")})`, "allowed_paths");
    if (p === "**" || p === "*" || p === "**/*") {
      err("allowed_path_too_broad", `allowed path "${p}" is a catch-all; list the directories the change may touch (e.g. "pkg/**", "tests/**")`, "allowed_paths");
    } else if (matchesAny(p, protectedAll) || protectedAll.some((pp) => globToRegExp(p).test(pp.replace(/\*\*/g, "x").replace(/\*/g, "x")))) {
      err("protected_writable", `allowed path "${p}" would make a protected path writable`, "allowed_paths");
    }
  }
  if (c.allowed_paths.length === 0 && c.decision === "implement") err("no_allowed_paths", "implement decision requires at least one allowed path", "allowed_paths");
  for (const p of protectedAll) {
    if (!c.protected_paths.map(normalizeRel).includes(normalizeRel(p))) {
      c.protected_paths.push(p);
      injected.protected_paths.push(p);
    }
  }
  for (const m of c.affected_modules) if (!isSafeRelativePattern(m)) err("unsafe_path", `affected module "${m}" is not a safe relative path`, "affected_modules");

  // 5. Verification commands
  const commandIds = new Set(Object.keys(policy.commands));
  c.verification.forEach((v, i) => {
    if (!commandIds.has(v.command_id)) err("unknown_command", `command ${v.command_id} is not in the trusted allowlist`, `verification[${i}]`);
    if (v.origin !== "trusted_config") err("untrusted_command_origin", `verification ${v.id} origin must be trusted_config`, `verification[${i}]`);
  });
  for (const [id, cmd] of Object.entries(policy.commands)) {
    if (!cmd.required) continue;
    if (cmd.requires_task_tests && !opts.hasTaskTests) continue;
    if (cmd.track === "business_invariant" && !cmd.builtin && c.business_invariants.length === 0) continue;
    if (!c.verification.some((v) => v.command_id === id)) {
      c.verification.push({ id: `VER-${String(c.verification.length + 1).padStart(3, "0")}`, command_id: id, origin: "trusted_config" });
      injected.verification.push(id);
    }
  }
  if (!c.verification.some((v) => policy.commands[v.command_id]?.track === "functional")) err("no_functional_check", "contract has no functional verification command", "verification");

  // 6. Open questions and routing
  const blockingQuestions = c.open_questions.filter((q) => q.blocking);
  let route: Route = c.decision;
  if (c.decision === "implement" && blockingQuestions.length) {
    warn("blocking_questions", `implement requested but ${blockingQuestions.length} blocking question(s) unresolved; routed to clarify`, "open_questions");
    route = "clarify";
    c.decision = "clarify";
  }
  if (c.decision === "implement" && c.requirements.length === 0) err("no_requirements", "implement decision requires at least one requirement", "requirements");
  const conflicted = [...c.business_invariants, ...c.architecture_constraints].filter((r) => {
    const hit = invariantsById.get(r.id) ?? rulesById.get(r.id);
    return hit && hit.status === "conflicted";
  });
  if (conflicted.length && route === "implement") {
    warn("conflicted_constraints", `constraints ${conflicted.map((x) => x.id).join(", ")} have conflicted sources; routed to clarify`, "business_invariants");
    route = "clarify";
    c.decision = "clarify";
  }
  if (c.max_repairs > 2) c.max_repairs = 2;

  if (issues.some((i) => i.severity === "error")) {
    return { route: "reject", contract: null, contract_hash: null, issues, injected, enforced_blocking: [] };
  }
  const enforced = [...c.business_invariants, ...c.architecture_constraints].filter((x) => x.enforcement === "blocking").map((x) => x.id);
  return { route, contract: c, contract_hash: sha256(canonicalJson(c)), issues, injected, enforced_blocking: enforced };
}

/** A glob is within the universe if it is matched by, or is a sub-pattern of, some universe glob. */
function withinUniverse(pattern: string, universe: string[]): boolean {
  for (const u of universe) {
    if (u === "**") return true;
    const uRe = globToRegExp(u);
    if (uRe.test(pattern)) return true;
    // Treat the pattern's wildcard segments as concrete to test containment: app/services/*.py within app/**
    const concrete = pattern.replace(/\*\*/g, "x/x").replace(/\*/g, "x").replace(/\?/g, "x");
    if (uRe.test(concrete)) return true;
  }
  return false;
}

export function contractHash(c: ChangeContract): string {
  return sha256(canonicalJson(c));
}
