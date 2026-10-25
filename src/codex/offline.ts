import fs from "node:fs";
import path from "node:path";
import type { CodingEngine, ImplementRequest, ImplementResult, PlanRequest, PlanResult } from "./adapter.ts";
import type { EvidencePack } from "../knowledge/retrieval.ts";
import type { ChangeContract } from "../contracts/schemas.ts";
import { applyPatch } from "../util/git.ts";

export interface OfflineOptions {
  /** Route the simulated planner should take. */
  route: "implement" | "clarify" | "abstain";
  /** Unified diff applied to the worktree by the simulated implementer (relative to cwd). */
  patchFile: string | null;
  /** Make the simulated implementer claim success in its final message regardless of reality. */
  claimSuccess: boolean;
  /** Inject a fabricated evidence id to exercise compiler rejection. */
  fabricateEvidence: boolean;
  /** Patch applied on the first simulated repair (simulates a successful fix); later repairs are no-ops. */
  repairPatchFile: string | null;
  taskId: string;
}

/**
 * Deterministic stand-in for Codex used when no credentials/budget are available.
 * Everything it produces is labelled `simulated: true`; its outputs are orchestration
 * fixtures, never a measurement of agent performance.
 */
export class OfflineEngine implements CodingEngine {
  readonly name = "offline-simulated";
  readonly simulated = true;
  private readonly opts: OfflineOptions;
  private readonly pack: EvidencePack;
  private implementCalls = 0;
  constructor(opts: OfflineOptions, pack: EvidencePack) {
    this.opts = opts;
    this.pack = pack;
  }

  async plan(req: PlanRequest): Promise<PlanResult> {
    req.onEvent?.({ timestamp: new Date().toISOString(), type: "simulated.plan", payload: { route: this.opts.route } });
    const contract = buildOfflineContract(this.pack, this.opts);
    return { text: JSON.stringify(contract), usage: null, threadId: null, simulated: true, engine: this.name, model: null, items: [] };
  }

  async implement(req: ImplementRequest): Promise<ImplementResult> {
    const changes: string[] = [];
    this.implementCalls++;
    const isRepair = this.implementCalls > 1 || !!req.threadId;
    let message = "[simulated offline implementer] no patch supplied; working tree unchanged.";
    const patchFile = isRepair ? (this.implementCalls === 2 ? this.opts.repairPatchFile : null) : this.opts.patchFile;
    if (isRepair && !patchFile) message = "[simulated offline implementer] repair attempt: no repair patch configured; working tree unchanged.";
    if (patchFile) {
      const patch = path.resolve(patchFile);
      if (!fs.existsSync(patch)) throw new Error(`offline patch not found: ${patch}`);
      const res = applyPatch(req.cwd, patch);
      if (!res.ok) throw new Error(`offline patch failed to apply: ${res.stderr.trim()}`);
      for (const m of fs.readFileSync(patch, "utf8").matchAll(/^\+\+\+ b\/(.+)$/gm)) changes.push(m[1]!);
      message = `[simulated offline implementer] applied ${path.basename(patch)} touching ${changes.join(", ")}.`;
    }
    if (this.opts.claimSuccess) message += " All tests pass and every business invariant is preserved. Implementation complete and verified.";
    req.onEvent?.({ timestamp: new Date().toISOString(), type: isRepair ? "simulated.repair" : "simulated.implement", payload: { patch: patchFile, changes } });
    return { finalResponse: message, usage: null, threadId: null, simulated: true, engine: this.name, model: null, items: [], reportedChanges: changes };
  }
}

/** Builds a contract from the evidence pack alone (no model): includes every applicable trusted constraint. */
export function buildOfflineContract(pack: EvidencePack, opts: Pick<OfflineOptions, "route" | "fabricateEvidence" | "taskId">): ChangeContract {
  const topSymbols = pack.reusable_symbols.slice(0, 5);
  const affected = pack.impact.probable_files.filter((f) => !f.path.startsWith("tests/")).slice(0, 6).map((f) => f.path);
  const requirementEvidence = topSymbols.slice(0, 2).map((s) => s.evidence_id);
  if (opts.fabricateEvidence) requirementEvidence.push("EV-deadbeef00");
  const contract: ChangeContract = {
    schema_version: "1.0",
    task_id: opts.taskId,
    goal: pack.task,
    decision: opts.route,
    base_revision: pack.revision,
    requirements: [
      { id: "REQ-001", statement: pack.task, evidence_ids: [], certainty: "hypothesized" },
      ...(requirementEvidence.length ? [{ id: "REQ-002", statement: `Build on existing components: ${topSymbols.slice(0, 2).map((s) => s.qualified_name).join(", ")}`, evidence_ids: requirementEvidence, certainty: "supported" as const }] : []),
    ],
    business_invariants: pack.invariants.filter((i) => i.binding).map((i) => ({ id: i.id, evidence_ids: [...i.evidence_ids], enforcement: "blocking" as const })),
    reuse_candidates: topSymbols.map((s) => ({ symbol_id: s.symbol_id, action: s.reuse_recommendation === "required" ? ("must_reuse" as const) : ("consider_reuse" as const), evidence_ids: [s.evidence_id], rationale: s.recommendation_basis })),
    architecture_constraints: pack.architecture_rules.filter((r) => r.binding).map((r) => ({ id: r.id, evidence_ids: [...r.evidence_ids], enforcement: "blocking" as const })),
    affected_modules: affected,
    allowed_paths: [...pack.allowed_path_universe],
    protected_paths: [...pack.protected_paths],
    verification: pack.commands.filter((c) => !c.requires_task_tests).map((c, i) => ({ id: `VER-${String(i + 1).padStart(3, "0")}`, command_id: c.command_id, origin: "trusted_config" as const })),
    open_questions: opts.route === "clarify" ? [{ id: "Q-001", question: "The task requires a business policy decision not present in approved sources.", blocking: true }] : [],
    rationale: `[simulated offline planner] route=${opts.route}; constraints taken verbatim from trusted policy.`,
    max_repairs: 2,
  };
  return contract;
}
