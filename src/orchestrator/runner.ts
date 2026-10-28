import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { KnowledgeStore, RunRow } from "../knowledge/storage.ts";
import { loadIndexedRepo, type IndexedRepo } from "../knowledge/repo.ts";
import { buildEvidencePack, type EvidencePack } from "../knowledge/retrieval.ts";
import { changeContractJsonSchema, type ChangeContract } from "../contracts/schemas.ts";
import { compileContract, type CompiledContract } from "../contracts/compiler.ts";
import { buildContinuePrompt, buildImplementationPrompt, buildPlanningPrompt, buildRepairPrompt } from "../contracts/prompts.ts";
import { codexAuthStatus, LiveCodexEngine, type CodingEngine, type ImplementResult, type Usage } from "../codex/adapter.ts";
import { OfflineEngine, type OfflineOptions } from "../codex/offline.ts";
import { verifyWorktree } from "../verification/runner.ts";
import { describeVerifier } from "../verification/sandbox.ts";
import { repoInterpreter } from "../knowledge/venv.ts";
import type { VerificationResult } from "../verification/results.ts";
import { RunStore, type TaskRecord } from "./store.ts";
import { BudgetExceededError, RunBudget, defaultLimits, type RunLimits } from "./limits.ts";
import { TERMINAL_STATES, type RunState } from "./workflow.ts";
import { resolveHiddenTests } from "./tasks.ts";
import { ensureHome, resolvePaths, codexSettings, PROJECT_ROOT } from "../config.ts";
import { newRunId, nowIso } from "../util/ids.ts";
import { addWorktree, headSha, isDirty, diffAgainstBase, changedFiles, git } from "../util/git.ts";
import { generateReport } from "../reports/generate.ts";
import { redact } from "../util/redact.ts";
import { coordinationEnabled, coordinationEnv, coordinationStatus, prepareCodexHome, syncedBase, syncCheck, type CoordinationEnv } from "../coordination/mergeguard.ts";
import { appendRoleSkills, captureAgentSnapshot, type AgentSnapshot, type EffectiveRole } from "../agent-skills.ts";

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
  const agentConfig = captureAgentSnapshot();
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
  rs.writeJson("agent_config.json", agentConfig);
  rs.writeJson("environment", environmentInfo(opts, indexed.repoPath, agentConfig));
  rs.event("run.created", { task: taskRecord, options: { mode: opts.mode, requireApproval: !!opts.requireApproval, offline: opts.offline ?? null } });
  rs.update({});
  return rs;
}

function environmentInfo(opts: RunOptions, repoPath?: string, agentConfig?: AgentSnapshot) {
  const python = repoInterpreter(repoPath);
  let pythonVersion = "unknown";
  try {
    pythonVersion = execSync(`"${python}" --version`, { encoding: "utf8" }).trim();
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
    python_path: python,
    codex_sdk: sdkVersion,
    codex_auth: { available: auth.available, mode: auth.mode },
    codex_model: agentConfig?.roles.implementer.model ?? settings.model ?? "codex-default",
    planner_model: agentConfig?.roles.planner.model ?? settings.model ?? "codex-default",
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
    const agentConfig = rs.readJson<AgentSnapshot>("agent_config.json") ?? captureAgentSnapshot();
    const engine = opts.engine ?? makeEngine(opts, pack, task, agentConfig.roles.implementer);
    const plannerEngine = opts.engine ?? (opts.mode === "offline" ? engine : makeEngine(opts, pack, task, agentConfig.roles.planner));
    const coord = coordinationFor(rs, indexed);

    // ---- planning + compilation
    let compiled: CompiledContract | null = null;
    if (rs.state === "CONTEXT_RETRIEVED" || rs.state === "CONTRACT_PROPOSED") {
      budget.check("planning");
      const hasTaskTests = !!hidden.taskDir;
      let attempt = 0;
      let feedback: string | null = null;
      while (true) {
        attempt++;
        const prompt = appendRoleSkills(buildPlanningPrompt(task.task, pack, { hasTaskTests }) + (feedback ? `\n\n## Previous attempt was rejected by the contract compiler\n${feedback}\nFix every issue and return the corrected contract JSON.` : ""), agentConfig.roles.planner);
        rs.writeText(attempt === 1 ? "plannerPrompt" : `planner_prompt.attempt-${attempt}.txt`, prompt);
        log(`planning with ${plannerEngine.name}${attempt > 1 ? ` (retry ${attempt - 1})` : ""}…`);
        const planned = await plannerEngine.plan({ cwd: indexed.repoPath, prompt, outputSchema: changeContractJsonSchema(), onEvent: (e) => rs.appendEventLine({ phase: "plan", ...e }) });
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
        if (plannerEngine.simulated || attempt > limits.maxPlannerRetries) {
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
      const prompt = appendRoleSkills(buildImplementationPrompt(contract, pack, task.task, { coordination: coord ? { mainBranch: coord.mainBranch } : null }), agentConfig.roles.implementer);
      rs.writeText("implementationPrompt", prompt);
      log(`implementing in ${worktree} with ${engine.name}…`);
      const result = await coordinatedTurn(rs, coord, engine, worktree, indexed.repoPath, (extra) => engine.implement({ cwd: worktree, prompt, ...extra, onThreadStarted: threadStarted(rs), onEvent: (e) => rs.appendEventLine({ phase: "implement", ...e }) }));
      recordImplementation(rs, result, "implement", 0);
      rs.transition("VERIFYING", { attempt: 1, reported_changes: result.reportedChanges.length });
    } else if (rs.state === "IMPLEMENTING" || rs.state === "REPAIRING") {
      // Resumed mid-turn: re-enter the recorded Codex thread when that is safe, otherwise let verification
      // judge the partial work. Either way nothing in the worktree is trusted without verification.
      await reenterIfPossible(store, rs, engine, contract, rs.state === "IMPLEMENTING" ? "implement" : "repair", budget, log, coord, indexed.repoPath, agentConfig.roles.implementer);
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
        coordination: coord,
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
      const prompt = appendRoleSkills(buildRepairPrompt(contract, verification.findings, repairsDone + 1, { coordination: coord ? { mainBranch: coord.mainBranch } : null }), agentConfig.roles.implementer);
      rs.writeText(`repair_prompt.attempt-${repairsDone + 1}.txt`, prompt);
      log(`repair attempt ${repairsDone + 1} with ${engine.name}…`);
      const phase = `repair-${repairsDone + 1}`;
      const result = await coordinatedTurn(rs, coord, engine, worktree, indexed.repoPath, (extra) => engine.implement({ cwd: worktree, prompt, threadId: rs.row.codex_thread_id, ...extra, onThreadStarted: threadStarted(rs), onEvent: (e) => rs.appendEventLine({ phase, ...e }) }));
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

/** Maximum number of times `resume` re-enters an interrupted Codex turn for one run. */
export const MAX_RESUME_REENTRIES = 2;

/** Persist the implementer thread id the moment the SDK reports it, so an interrupted turn can be re-entered. */
function threadStarted(rs: RunStore): (threadId: string) => void {
  return (id) => {
    rs.update({ codex_thread_id: id });
    rs.event("implementer.thread_started", { id });
  };
}

/**
 * Resume from IMPLEMENTING / REPAIRING: re-enter the recorded Codex thread with a continuation prompt when the
 * engine is live, a thread id is known, the worktree still sits at the base sha and the re-entry budget
 * (`MAX_RESUME_REENTRIES`, counted from `resume.reentered` events) is not exhausted. Otherwise verify as is.
 * Both branches end in VERIFYING; verification alone decides what the partial work is worth.
 */
/**
 * mergeguard coordination for this run, or null when it is off or unavailable (recorded once as a run event).
 * The environment points mergeguard at the indexed repository's checked-out branch as main and keeps all its state
 * under INTENTOS_HOME.
 */
function coordinationFor(rs: RunStore, indexed: IndexedRepo): CoordinationEnv | null {
  if (!coordinationEnabled()) {
    rs.event("coordination.off", { reason: coordinationStatus().reason });
    return null;
  }
  try {
    const coord = coordinationEnv(indexed.repoPath, indexed.policy);
    rs.event("coordination.on", { main_branch: coord.mainBranch, state_dir: coord.stateDir, policy_file: coord.policyFile });
    return coord;
  } catch (err) {
    rs.event("coordination.off", { reason: (err as Error).message });
    return null;
  }
}

/**
 * One implementer turn under coordination. The Codex process gets a private CODEX_HOME under the run directory that
 * holds the mergeguard hooks (trusted by hash through a config override scoped to this process) and a link to the
 * user's auth; project `.codex/` files are not used because Codex never reads them below a worktree's `.git` file.
 * A HEAD that moved only by fast-forwarding to main (the sync the hook asked for) advances the run's base afterwards.
 */
async function coordinatedTurn(rs: RunStore, coord: CoordinationEnv | null, engine: CodingEngine, worktree: string, repoPath: string, turn: (extra: { configOverrides?: string[]; env?: Record<string, string> }) => Promise<ImplementResult>): Promise<ImplementResult> {
  if (!coord) return turn({});
  let home: ReturnType<typeof prepareCodexHome> | null = null;
  if (!engine.simulated) {
    home = prepareCodexHome(coord, path.join(rs.runDir, "codex_home"));
    rs.event("coordination.hooks_installed", { codex_home: home.home, files: home.files.map((f) => path.basename(f)) });
  }
  try {
    return await turn(home ? { configOverrides: [home.trustOverride, "features.hooks=true"], env: { ...coord.env, CODEX_HOME: home.home } } : { env: coord.env });
  } finally {
    // Codex's sandbox protects linked-worktree Git metadata even when the
    // parent .git directory is an additional writable directory. Perform the
    // hook-requested fast-forward here, outside the agent's sandbox.
    if (!engine.simulated) syncAfterTurn(rs, coord, worktree, repoPath);
    advanceBase(rs, coord, worktree, repoPath);
  }
}

function syncAfterTurn(rs: RunStore, coord: CoordinationEnv, worktree: string, repoPath: string): void {
  try {
    if (headSha(worktree) !== rs.row.base_sha) return;
    const sync = syncCheck(coord, worktree);
    if (sync.main === sync.base) return;
    const branch = coord.mainBranch;
    const hadChanges = isDirty(worktree);
    if (hadChanges) git(worktree, ["stash", "push", "-u", "-q", "-m", `intentos-sync-${rs.runId}`]);
    try {
      git(worktree, ["merge", "--ff-only", branch]);
    } catch (error) {
      if (hadChanges) git(worktree, ["stash", "pop", "-q"], { allowFail: true });
      throw error;
    }
    if (hadChanges) {
      const restored = git(worktree, ["stash", "pop", "-q"], { allowFail: true });
      if (restored.status !== 0) rs.event("coordination.sync_conflict", { detail: restored.stderr.trim() });
    }
    rs.event("coordination.synced", { from: sync.base, to: sync.main, issues: sync.issues.map((issue) => issue.id) });
  } catch (error) {
    rs.event("coordination.sync_failed", { reason: (error as Error).message, repo: repoPath });
  }
}

/** A worktree fast-forwarded to main is not an integrity failure: the run's base moves with it. */
export function advanceBase(rs: RunStore, coord: CoordinationEnv, worktree: string, repoPath: string): string | null {
  const from = rs.row.base_sha;
  let synced: string | null = null;
  try {
    synced = syncedBase(repoPath, worktree, from, coord.mainBranch);
  } catch {
    return null;
  }
  if (!synced) return null;
  rs.update({ base_sha: synced });
  rs.writeText("baseCommit", `${synced}\n`);
  rs.event("base.advanced", { from, to: synced, reason: `worktree fast-forwarded to ${coord.mainBranch} as the coordination hook asked` });
  return synced;
}

async function reenterIfPossible(store: KnowledgeStore, rs: RunStore, engine: CodingEngine, contract: ChangeContract, phase: "implement" | "repair", budget: RunBudget, log: (line: string) => void, coord: CoordinationEnv | null = null, repoPath: string | null = null, role: EffectiveRole | null = null): Promise<void> {
  const reentries = store.events(rs.runId).filter((e) => e.event_type === "resume.reentered").length;
  const worktree = rs.row.worktree_path;
  const threadId = rs.row.codex_thread_id;
  let reason: string | null = null;
  if (engine.simulated) reason = "engine is simulated (offline mode); there is no Codex thread to re-enter";
  else if (!threadId) reason = "no Codex thread id was recorded before the interruption";
  else if (reentries >= MAX_RESUME_REENTRIES) reason = `re-entry limit reached (${reentries} of ${MAX_RESUME_REENTRIES} re-entries used)`;
  else if (!worktree || !fs.existsSync(worktree)) reason = "worktree is missing";
  else {
    let wtHead: string | null = null;
    try {
      wtHead = headSha(worktree);
    } catch {
      /* unreadable worktree */
    }
    if (wtHead !== rs.row.base_sha) reason = `worktree HEAD ${wtHead?.slice(0, 10) ?? "unavailable"} is not the run base ${rs.row.base_sha.slice(0, 10)}`;
  }
  if (reason !== null || !worktree || !threadId) {
    rs.event("resume", { phase, note: "verifying current worktree without re-entering a thread", reason: reason ?? "unknown" });
    log(`resume: ${reason ?? "unknown"}; verifying the current worktree as is`);
    rs.transition("VERIFYING", { attempt: previousAttempts(rs) + 1, resumed: true });
    return;
  }
  budget.check("resume re-entry");
  const attempt = reentries + 1;
  const lastFindings = rs.readJson<VerificationResult>("verification")?.findings ?? [];
  const prompt = role ? appendRoleSkills(buildContinuePrompt(contract, phase, lastFindings), role) : buildContinuePrompt(contract, phase, lastFindings);
  rs.writeText(`continue_prompt.${attempt}.txt`, prompt);
  // Recorded before the turn starts so a second interruption still counts against the budget.
  rs.event("resume.reentered", { phase, thread_id: threadId, attempt });
  log(`resume: re-entering Codex thread ${threadId} to continue the interrupted ${phase} (re-entry ${attempt} of ${MAX_RESUME_REENTRIES})…`);
  const result = await coordinatedTurn(rs, coord, engine, worktree, repoPath ?? worktree, (extra) => engine.implement({ cwd: worktree, prompt, threadId, ...extra, onThreadStarted: threadStarted(rs), onEvent: (e) => rs.appendEventLine({ phase: `resume-${phase}-${attempt}`, ...e }) }));
  recordImplementation(rs, result, phase, previousAttempts(rs));
  rs.transition("VERIFYING", { attempt: previousAttempts(rs) + 1, resumed: true, reentered: attempt });
}

function recordImplementation(rs: RunStore, result: ImplementResult, phase: "implement" | "repair", attempt: number): void {
  const file = phase === "implement" ? "implementerResult" : `implementer_result.repair-${attempt}.json`;
  rs.writeJson(file, { phase, attempt, engine: result.engine, model: result.model, simulated: result.simulated, thread_id: result.threadId, usage: result.usage ?? "unknown", final_response: result.finalResponse, reported_changes: result.reportedChanges, note: "The agent's final message is recorded for inspection only; verification never relies on it." });
  rs.event(`${phase}.completed`, { attempt, engine: result.engine, simulated: result.simulated, usage: result.usage ?? "unknown", thread_id: result.threadId, reported_changes: result.reportedChanges });
  if (result.threadId) rs.update({ codex_thread_id: result.threadId });
}

function makeEngine(opts: RunOptions, pack: EvidencePack, task: TaskRecord, role: EffectiveRole): CodingEngine {
  if (opts.mode === "offline") {
    const o: OfflineOptions = { route: "implement", patchFile: null, claimSuccess: false, fabricateEvidence: false, repairPatchFile: null, taskId: task.task_id, ...((task.engine_options as Partial<OfflineOptions> | null) ?? {}), ...(opts.offline ?? {}) };
    return new OfflineEngine(o, pack);
  }
  const auth = codexAuthStatus();
  if (!auth.available) throw new Error(`Codex credentials not found (${auth.detail}). Set CODEX_API_KEY, run \`codex login\`, or use --offline.`);
  return new LiveCodexEngine({ model: role.model, reasoningEffort: role.reasoning });
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
