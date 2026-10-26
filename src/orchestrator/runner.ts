import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { KnowledgeStore, RunRow } from "../knowledge/storage.ts";
import { loadIndexedRepo, type IndexedRepo } from "../knowledge/repo.ts";
import { buildEvidencePack, type EvidencePack } from "../knowledge/retrieval.ts";
import { changeContractJsonSchema, type ChangeContract } from "../contracts/schemas.ts";
import { compileContract, type CompiledContract } from "../contracts/compiler.ts";
import { buildImplementationPrompt, buildPlanningPrompt, buildRepairPrompt } from "../contracts/prompts.ts";
import { codexAuthStatus, LiveCodexEngine, type CodingEngine, type ImplementResult, type Usage } from "../codex/adapter.ts";
import { OfflineEngine, type OfflineOptions } from "../codex/offline.ts";
import { verifyWorktree } from "../verification/runner.ts";
import { describeVerifier } from "../verification/sandbox.ts";
import type { VerificationResult } from "../verification/results.ts";
import { RunStore, type TaskRecord } from "./store.ts";
import { BudgetExceededError, RunBudget, defaultLimits, type RunLimits } from "./limits.ts";
import { TERMINAL_STATES, type RunState } from "./workflow.ts";
import { resolveHiddenTests } from "./tasks.ts";
import { ensureHome, resolvePaths, resolvePython, codexSettings, PROJECT_ROOT } from "../config.ts";
import { newRunId, nowIso } from "../util/ids.ts";
import { addWorktree, headSha, isDirty, diffAgainstBase, changedFiles } from "../util/git.ts";
import { generateReport } from "../reports/generate.ts";
import { redact } from "../util/redact.ts";

export interface RunOptions {
  mode: "live" | "offline";
  offline?: Partial<OfflineOptions>;
  requireApproval?: boolean;
  taskId?: string | null;
  limits?: Partial<RunLimits>;
  /** Injected engine (tests). */
  engine?: CodingEngine;
  /** Stop after contract validation (used by `intentos plan`). */
  planOnly?: boolean;
  log?: (line: string) => void;
}

export interface RunOutcome {
  run: RunRow;
  state: RunState;
  reason: string | null;
  verification: VerificationResult | null;
}

export function createRun(store: KnowledgeStore, indexed: IndexedRepo, task: string, opts: RunOptions): RunStore {
  const paths = ensureHome(resolvePaths());
  const runId = newRunId();
  const runDir = path.join(paths.runs, runId);
  const hidden = resolveHiddenTests(indexed.policy.policy_id, task, opts.taskId ?? null);
  const taskRecord: TaskRecord = {
    task_id: hidden.benchmarkTask?.id ?? opts.taskId ?? `task-${runId}`,
    task,
    repo_path: indexed.repoPath,
    repo_id: indexed.repo.id,
    mode: opts.mode,
    created_at: nowIso(),
    hidden_task_tests_dir: hidden.taskDir,
    benchmark_task_id: hidden.benchmarkTask?.id ?? null,
    engine_options: opts.offline ? { ...opts.offline } : null,
  };
  const now = nowIso();
  store.insertRun({
    id: runId,
    repo_id: indexed.repo.id,
    base_sha: indexed.revision,
    worktree_path: null,
    state: "CREATED",
    contract_json: null,
    contract_hash: null,
    codex_thread_id: null,
    started_at: now,
    updated_at: now,
    result_json: null,
    task_json: JSON.stringify(taskRecord),
    mode: opts.mode,
    run_dir: runDir,
  });
  const rs = new RunStore(store, runId, runDir);
  rs.writeJson("task", taskRecord);
  rs.writeText("baseCommit", `${indexed.revision}\n`);
  rs.writeJson("environment", environmentInfo(opts));
  rs.event("run.created", { task: taskRecord, options: { mode: opts.mode, requireApproval: !!opts.requireApproval, offline: opts.offline ?? null } });
  rs.update({});
  return rs;
}

function environmentInfo(opts: RunOptions) {
  let pythonVersion = "unknown";
  try {
    pythonVersion = execSync(`"${resolvePython()}" --version`, { encoding: "utf8" }).trim();
  } catch {
    /* ignore */
  }
  let sdkVersion = "unknown";
  try {
    sdkVersion = (JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "node_modules", "@openai", "codex-sdk", "package.json"), "utf8")) as { version: string }).version;
  } catch {
    /* ignore */
  }
  const auth = codexAuthStatus();
  const settings = codexSettings();
  const verifier = describeVerifier();
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    python: pythonVersion,
    codex_sdk: sdkVersion,
    codex_auth: { available: auth.available, mode: auth.mode },
    codex_model: settings.model ?? "codex-default",
    mode: opts.mode,
    verifier,
    isolation: verifier.mode === "docker" ? "git worktree + Codex sandbox + container-isolated verifier (docker: read-only snapshot, no network, resource limits; host kernel shared)" : "git worktree + Codex sandbox (no container); prototype is not production-safe for untrusted repositories",
    recorded_at: nowIso(),
  };
}

export function loadTask(rs: RunStore): TaskRecord {
  return JSON.parse(rs.row.task_json) as TaskRecord;
}

/** Drive a run from its current state until a terminal state, an approval gate, or `planOnly` stop. */
export async function executeRun(store: KnowledgeStore, rs: RunStore, opts: RunOptions): Promise<RunOutcome> {
  const log = opts.log ?? (() => {});
  const limits = { ...defaultLimits(), ...(opts.limits ?? {}) };
  const budget = new RunBudget(limits, Date.parse(rs.row.started_at));
  const task = loadTask(rs);
  let reason: string | null = null;

  const fail = (why: string, extra: Record<string, unknown> = {}) => {
    reason = why;
    if (!TERMINAL_STATES.has(rs.state)) rs.transition("FAILED", { reason: why, ...extra });
    rs.update({ result_json: JSON.stringify({ final_state: "FAILED", reason: why, ...extra }) });
  };

  try {
    let indexed: IndexedRepo;
    try {
      indexed = loadIndexedRepo(store, task.repo_path);
    } catch (err) {
      fail(`index unavailable: ${(err as Error).message}`);
      return finish(store, rs, reason);
    }
    if (indexed.revision !== rs.row.base_sha) {
      fail(`repository HEAD ${indexed.revision.slice(0, 10)} no longer matches run base ${rs.row.base_sha.slice(0, 10)}; start a new run`);
      return finish(store, rs, reason);
    }
    const hidden = resolveHiddenTests(indexed.policy.policy_id, task.task, task.benchmark_task_id ?? opts.taskId ?? null);

    if (rs.state === "CREATED") rs.transition("INDEXED", { revision: indexed.revision, policy: indexed.policy.policy_id });

    // ---- context
    let pack: EvidencePack | null = rs.readJson<EvidencePack>("evidence");
    if (rs.state === "INDEXED") {
      budget.check("context retrieval");
      pack = buildEvidencePack(store, indexed, task.task);
      rs.writeJson("evidence", pack);
      rs.transition("CONTEXT_RETRIEVED", { symbols: pack.reusable_symbols.length, invariants: pack.invariants.length, rules: pack.architecture_rules.length, conflicts: pack.conflicts.length });
      log(`context: ${pack.reusable_symbols.length} symbols, ${pack.invariants.length} invariants, ${pack.architecture_rules.length} architecture rules, ${pack.conflicts.length} conflicts`);
    }
    if (!pack) {
      fail("evidence pack missing from run directory");
      return finish(store, rs, reason);
    }
    const engine = opts.engine ?? makeEngine(opts, pack, task);

    // ---- planning + compilation
    let compiled: CompiledContract | null = null;
    if (rs.state === "CONTEXT_RETRIEVED" || rs.state === "CONTRACT_PROPOSED") {
      budget.check("planning");
      const hasTaskTests = !!hidden.taskDir;
      let attempt = 0;
      let feedback: string | null = null;
      while (true) {
        attempt++;
        const prompt = buildPlanningPrompt(task.task, pack, { hasTaskTests }) + (feedback ? `\n\n## Previous attempt was rejected by the contract compiler\n${feedback}\nFix every issue and return the corrected contract JSON.` : "");
        rs.writeText(attempt === 1 ? "plannerPrompt" : `planner_prompt.attempt-${attempt}.txt`, prompt);
        log(`planning with ${engine.name}${attempt > 1 ? ` (retry ${attempt - 1})` : ""}…`);
        const planned = await engine.plan({ cwd: indexed.repoPath, prompt, outputSchema: changeContractJsonSchema(), onEvent: (e) => rs.appendEventLine({ phase: "plan", ...e }) });
        rs.writeJson(attempt === 1 ? "plannerOutput" : `planner_output.attempt-${attempt}.json`, { text: planned.text, usage: planned.usage, thread_id: planned.threadId, simulated: planned.simulated, engine: planned.engine, model: planned.model });
        let raw: unknown;
        try {
          raw = JSON.parse(planned.text);
        } catch {
          raw = { parse_error: true };
        }
        if (rs.state === "CONTEXT_RETRIEVED") rs.transition("CONTRACT_PROPOSED", { attempt, simulated: planned.simulated, thread_id: planned.threadId, usage: planned.usage });
        else rs.transition("CONTRACT_PROPOSED", { attempt, simulated: planned.simulated, thread_id: planned.threadId, usage: planned.usage });
        rs.event("planner.usage", { attempt, usage: planned.usage ?? "unknown" });
        compiled = compileContract(raw, pack, indexed.policy, { hasTaskTests });
        rs.writeJson(attempt === 1 ? "contractValidation" : `contract_validation.attempt-${attempt}.json`, { ...compiled, contract: undefined });
        if (compiled.route !== "reject") break;
        const errors = compiled.issues.filter((i) => i.severity === "error");
        log(`contract rejected: ${errors.map((e) => e.message).join("; ")}`);
        if (engine.simulated || attempt > limits.maxPlannerRetries) {
          fail(`contract rejected by compiler after ${attempt} attempt(s): ${errors.map((e) => `${e.code}: ${e.message}`).join("; ")}`, { issues: compiled.issues });
          return finish(store, rs, reason);
        }
        feedback = errors.map((e) => `- ${e.code}${e.path ? ` at ${e.path}` : ""}: ${e.message}`).join("\n");
      }
      const contract = compiled.contract!;
      rs.writeJson("contract", contract);
      rs.writeJson("contractValidation", { ...compiled, contract: undefined });
      rs.transition("CONTRACT_VALIDATED", { route: compiled.route, contract_hash: compiled.contract_hash, injected: compiled.injected, warnings: compiled.issues.filter((i) => i.severity === "warning").length }, { contract_json: JSON.stringify(contract), contract_hash: compiled.contract_hash });
      log(`contract validated: route=${compiled.route} hash=${compiled.contract_hash!.slice(0, 12)} enforced=${compiled.enforced_blocking.join(",")}`);
    }

    const contract = rs.row.contract_json ? (JSON.parse(rs.row.contract_json) as ChangeContract) : null;
    if (!contract || !rs.row.contract_hash) {
      fail("validated contract missing");
      return finish(store, rs, reason);
    }

    // ---- routing
    if (rs.state === "CONTRACT_VALIDATED") {
      if (contract.decision === "clarify") {
        rs.transition("CLARIFICATION_REQUIRED", { open_questions: contract.open_questions });
        rs.update({ result_json: JSON.stringify({ final_state: "CLARIFICATION_REQUIRED", open_questions: contract.open_questions, rationale: contract.rationale }) });
        return finish(store, rs, "clarification required");
      }
      if (contract.decision === "abstain") {
        rs.transition("ABSTAINED", { rationale: contract.rationale });
        rs.update({ result_json: JSON.stringify({ final_state: "ABSTAINED", rationale: contract.rationale, requirements: contract.requirements }) });
        return finish(store, rs, "abstained");
      }
      if (opts.planOnly) {
        rs.event("run.paused", { reason: "plan only" });
        return { run: rs.row, state: rs.state, reason: "plan only", verification: null };
      }
      if (opts.requireApproval) {
        rs.event("approval.requested", { contract_hash: rs.row.contract_hash });
        log(`awaiting human approval: intentos approve ${rs.runId} --by <name>`);
        return { run: rs.row, state: rs.state, reason: "awaiting approval", verification: null };
      }
      rs.transition("APPROVED", { approved_by: "auto (no approval gate requested)" });
    }

    // ---- implementation
    if (rs.state === "APPROVED") {
      budget.check("implementation");
      if (isDirty(indexed.repoPath)) rs.event("warning", { message: "target repository working tree is dirty; worktree is created from HEAD, uncommitted changes are ignored" });
      let worktree = rs.row.worktree_path;
      if (!worktree || !fs.existsSync(worktree)) {
        worktree = path.join(resolvePaths().worktrees, rs.runId);
        addWorktree(indexed.repoPath, worktree, rs.row.base_sha);
        rs.update({ worktree_path: worktree });
      }
      rs.transition("IMPLEMENTING", { worktree, engine: engine.name, simulated: engine.simulated });
      const prompt = buildImplementationPrompt(contract, pack, task.task);
      rs.writeText("implementationPrompt", prompt);
      log(`implementing in ${worktree} with ${engine.name}…`);
      const result = await engine.implement({ cwd: worktree, prompt, onEvent: (e) => rs.appendEventLine({ phase: "implement", ...e }) });
      recordImplementation(rs, result, "implement", 0);
      rs.transition("VERIFYING", { attempt: 1, reported_changes: result.reportedChanges.length });
    } else if (rs.state === "IMPLEMENTING") {
      // Resumed mid-implementation: do not trust partial work blindly; verification decides.
      rs.event("resume", { note: "run was interrupted during implementation; proceeding to verification of the current worktree" });
      rs.transition("VERIFYING", { attempt: previousAttempts(rs) + 1, resumed: true });
    } else if (rs.state === "REPAIRING") {
      rs.event("resume", { note: "run was interrupted during repair; re-verifying the current worktree" });
      rs.transition("VERIFYING", { attempt: previousAttempts(rs) + 1, resumed: true });
    }

    // ---- verification + bounded repair
    let verification: VerificationResult | null = null;
    while (rs.state === "VERIFYING") {
      budget.check("verification");
      const worktree = rs.row.worktree_path;
      if (!worktree || !fs.existsSync(worktree)) {
        fail("worktree missing; cannot verify");
        return finish(store, rs, reason);
      }
      const attempt = previousAttempts(rs) + 1;
      log(`verifying (attempt ${attempt})…`);
      verification = verifyWorktree({
        runId: rs.runId,
        attempt,
        worktree,
        baseSha: rs.row.base_sha,
        contract,
        contractHash: rs.row.contract_hash,
        policy: indexed.policy,
        pack,
        outDir: path.join(rs.runDir, "verification"),
        hiddenTaskTestsDir: hidden.taskDir,
        hiddenInvariantTestsDir: hidden.invariantsDir,
        eventsFile: rs.path("codexEvents"),
        repoPath: indexed.repoPath,
        simulated: engine.simulated,
      });
      rs.writeJson("verification", verification);
      rs.writeJson(`verification/attempt-${attempt}/verification.json`, verification);
      rs.writeText("diff", diffAgainstBase(worktree, rs.row.base_sha));
      rs.event("verification.completed", { attempt, status: verification.status, blocking: verification.findings.filter((f) => f.severity === "blocking").length, review: verification.findings.filter((f) => f.severity === "review").length });
      log(`verification ${verification.status}: ${verification.findings.filter((f) => f.severity === "blocking").length} blocking, ${verification.findings.filter((f) => f.severity === "review").length} review finding(s)`);

      if (verification.status === "passed") {
        rs.transition("REVIEW_READY", { attempt });
        break;
      }
      if (verification.status === "needs_review") {
        rs.transition("HUMAN_REVIEW", { attempt, findings: verification.findings.map((f) => f.id) });
        break;
      }
      const repairsDone = attempt - 1;
      const allowed = budget.repairsAllowed(contract.max_repairs);
      if (repairsDone >= allowed) {
        fail(`blocking verification findings remain after ${repairsDone} repair attempt(s) (max ${allowed})`, { findings: verification.findings.filter((f) => f.severity === "blocking").map((f) => f.id) });
        break;
      }
      budget.check("repair");
      rs.transition("REPAIRING", { repair_attempt: repairsDone + 1, blocking: verification.findings.filter((f) => f.severity === "blocking").map((f) => f.id) });
      const prompt = buildRepairPrompt(contract, verification.findings, repairsDone + 1);
      rs.writeText(`repair_prompt.attempt-${repairsDone + 1}.txt`, prompt);
      log(`repair attempt ${repairsDone + 1} with ${engine.name}…`);
      const result = await engine.implement({ cwd: worktree, prompt, threadId: rs.row.codex_thread_id, onEvent: (e) => rs.appendEventLine({ phase: `repair-${repairsDone + 1}`, ...e }) });
      recordImplementation(rs, result, "repair", repairsDone + 1);
      rs.transition("VERIFYING", { attempt: attempt + 1 });
    }
    return finish(store, rs, reason, verification);
  } catch (err) {
    const message = redact((err as Error).message ?? String(err));
    if (err instanceof BudgetExceededError) fail(`budget exceeded: ${message}`);
    else fail(`unrecoverable error: ${message}`, { stack: redact((err as Error).stack ?? "") });
    return finish(store, rs, reason);
  }
}

function previousAttempts(rs: RunStore): number {
  const dir = path.join(rs.runDir, "verification");
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((d) => d.startsWith("attempt-")).length;
}

function recordImplementation(rs: RunStore, result: ImplementResult, phase: "implement" | "repair", attempt: number): void {
  const file = phase === "implement" ? "implementerResult" : `implementer_result.repair-${attempt}.json`;
  rs.writeJson(file, { phase, attempt, engine: result.engine, model: result.model, simulated: result.simulated, thread_id: result.threadId, usage: result.usage ?? "unknown", final_response: result.finalResponse, reported_changes: result.reportedChanges, note: "The agent's final message is recorded for inspection only; verification never relies on it." });
  rs.event(`${phase}.completed`, { attempt, engine: result.engine, simulated: result.simulated, usage: result.usage ?? "unknown", thread_id: result.threadId, reported_changes: result.reportedChanges });
  if (result.threadId) rs.update({ codex_thread_id: result.threadId });
}

function makeEngine(opts: RunOptions, pack: EvidencePack, task: TaskRecord): CodingEngine {
  if (opts.mode === "offline") {
    const o: OfflineOptions = { route: "implement", patchFile: null, claimSuccess: false, fabricateEvidence: false, repairPatchFile: null, taskId: task.task_id, ...((task.engine_options as Partial<OfflineOptions> | null) ?? {}), ...(opts.offline ?? {}) };
    return new OfflineEngine(o, pack);
  }
  const auth = codexAuthStatus();
  if (!auth.available) throw new Error(`Codex credentials not found (${auth.detail}). Set CODEX_API_KEY, run \`codex login\`, or use --offline.`);
  return new LiveCodexEngine();
}

function finish(store: KnowledgeStore, rs: RunStore, reason: string | null, verification: VerificationResult | null = null): RunOutcome {
  const v = verification ?? rs.readJson<VerificationResult>("verification");
  writeMetrics(store, rs, v);
  try {
    generateReport(store, rs.runId);
  } catch (err) {
    rs.event("report.error", { message: (err as Error).message });
  }
  const row = rs.row;
  if (TERMINAL_STATES.has(rs.state) && !row.result_json) {
    rs.update({ result_json: JSON.stringify({ final_state: rs.state, reason, verification_status: v?.status ?? null }) });
  } else if (TERMINAL_STATES.has(rs.state) && row.result_json) {
    const existing = JSON.parse(row.result_json) as Record<string, unknown>;
    rs.update({ result_json: JSON.stringify({ ...existing, final_state: rs.state, verification_status: v?.status ?? existing.verification_status ?? null }) });
  }
  return { run: rs.row, state: rs.state, reason, verification: v };
}

function writeMetrics(store: KnowledgeStore, rs: RunStore, v: VerificationResult | null): void {
  const events = store.events(rs.runId);
  const usage = { input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, cached_input_tokens: 0, known: false };
  for (const e of events) {
    if (!["planner.usage", "implement.completed", "repair.completed"].includes(e.event_type)) continue;
    const payload = JSON.parse(e.payload_json) as { usage?: Usage | "unknown" };
    if (payload.usage && payload.usage !== "unknown") {
      usage.known = true;
      usage.input_tokens += payload.usage.input_tokens ?? 0;
      usage.output_tokens += payload.usage.output_tokens ?? 0;
      usage.reasoning_output_tokens += payload.usage.reasoning_output_tokens ?? 0;
      usage.cached_input_tokens += payload.usage.cached_input_tokens ?? 0;
    }
  }
  const row = rs.row;
  const transitions = events.filter((e) => e.event_type === "state.transition").map((e) => JSON.parse(e.payload_json) as { from: string; to: string });
  const repairs = transitions.filter((t) => t.to === "REPAIRING").length;
  const plannerAttempts = transitions.filter((t) => t.to === "CONTRACT_PROPOSED").length;
  const testMs = v?.commands.reduce((a, c) => a + c.duration_ms, 0) ?? 0;
  const changed = row.worktree_path && fs.existsSync(row.worktree_path) ? changedFiles(row.worktree_path, row.base_sha).length : 0;
  rs.writeJson("metrics", {
    run_id: rs.runId,
    final_state: row.state,
    mode: row.mode,
    simulated: v?.simulated ?? row.mode === "offline",
    wall_time_ms: Date.now() - Date.parse(row.started_at),
    tokens: usage.known ? usage : "unknown",
    planner_attempts: plannerAttempts,
    repair_rounds: repairs,
    verification_attempts: v?.attempt ?? 0,
    verification_status: v?.status ?? null,
    verification_time_ms: testMs,
    blocking_findings: v?.findings.filter((f) => f.severity === "blocking").length ?? null,
    review_findings: v?.findings.filter((f) => f.severity === "review").length ?? null,
    tracks: v?.tracks ?? null,
    changed_files: changed,
    state_transitions: transitions.length,
  });
}

/**
 * Apply an independent re-verification result to a finished run: a failing or review-worthy re-run
 * revokes REVIEW_READY (and a failing one revokes HUMAN_REVIEW). Results never upgrade a state.
 */
export function applyReverification(rs: RunStore, result: VerificationResult): { previous: RunState; current: RunState; changed: boolean } {
  const previous = rs.state;
  let target: RunState | null = null;
  if (previous === "REVIEW_READY" && result.status === "failed") target = "FAILED";
  else if (previous === "REVIEW_READY" && result.status === "needs_review") target = "HUMAN_REVIEW";
  else if (previous === "HUMAN_REVIEW" && result.status === "failed") target = "FAILED";
  if (target) {
    rs.transition(target, { reason: `independent re-verification ${result.status} (attempt ${result.attempt})`, findings: result.findings.filter((f) => f.severity !== "info").map((f) => f.id) });
    const existing = rs.row.result_json ? (JSON.parse(rs.row.result_json) as Record<string, unknown>) : {};
    rs.update({ result_json: JSON.stringify({ ...existing, final_state: target, verification_status: result.status, revoked_from: previous, reason: `independent re-verification ${result.status}` }) });
  }
  return { previous, current: rs.state, changed: !!target };
}

/** Human approval gate: CONTRACT_VALIDATED -> APPROVED, then continue. */
export function approveRun(rs: RunStore, approvedBy: string): void {
  if (rs.state !== "CONTRACT_VALIDATED") throw new Error(`run ${rs.runId} is in state ${rs.state}; only CONTRACT_VALIDATED runs can be approved`);
  const contract = rs.row.contract_json ? (JSON.parse(rs.row.contract_json) as ChangeContract) : null;
  if (!contract || contract.decision !== "implement") throw new Error("only implement contracts can be approved");
  rs.transition("APPROVED", { approved_by: approvedBy, contract_hash: rs.row.contract_hash });
}

export { headSha };
