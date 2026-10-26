import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import type { KnowledgeStore } from "./knowledge/storage.ts";
import { loadIndexedRepo } from "./knowledge/repo.ts";
import { createRun, executeRun, approveRun, loadTask, applyReverification } from "./orchestrator/runner.ts";
import { RunStore } from "./orchestrator/store.ts";
import { checkRunIntegrity, isTerminal } from "./orchestrator/recovery.ts";
import { generateReport } from "./reports/generate.ts";
import { verifyWorktree } from "./verification/runner.ts";
import { resolveHiddenTests } from "./orchestrator/tasks.ts";
import type { ChangeContract } from "./contracts/schemas.ts";
import type { EvidencePack } from "./knowledge/retrieval.ts";
import { fallbackPolicy, policyForRepo } from "./knowledge/policy.ts";
import { registerDecisionCommands } from "./cli_decisions.ts";
import { requireTask } from "./cli.ts";

export interface CliContext {
  openStore: () => KnowledgeStore;
  fail: (message: string, code?: number) => never;
}

interface RunCliOpts {
  offline: boolean;
  offlineRoute?: "implement" | "clarify" | "abstain";
  offlinePatch?: string;
  offlineRepairPatch?: string;
  offlineClaimSuccess: boolean;
  offlineFabricateEvidence: boolean;
  requireApproval: boolean;
  task?: string;
}

function runOptions(o: RunCliOpts, log: (s: string) => void) {
  return {
    mode: o.offline ? ("offline" as const) : ("live" as const),
    offline: { route: o.offlineRoute ?? "implement", patchFile: o.offlinePatch ? path.resolve(o.offlinePatch) : null, repairPatchFile: o.offlineRepairPatch ? path.resolve(o.offlineRepairPatch) : null, claimSuccess: o.offlineClaimSuccess, fabricateEvidence: o.offlineFabricateEvidence },
    requireApproval: o.requireApproval,
    taskId: o.task ?? null,
    log,
  };
}

function addOfflineOptions(cmd: Command): Command {
  return cmd
    .option("--offline", "deterministic simulated planner/implementer (no Codex); results are labelled simulated", false)
    .option("--offline-route <route>", "simulated planner route: implement | clarify | abstain", "implement")
    .option("--offline-patch <file>", "unified diff the simulated implementer applies to the worktree")
    .option("--offline-repair-patch <file>", "unified diff the simulated implementer applies on its first repair attempt")
    .option("--offline-claim-success", "simulated implementer claims success regardless of reality (verifier must ignore it)", false)
    .option("--offline-fabricate-evidence", "simulated planner cites a fabricated evidence id (compiler must reject)", false)
    .option("--task <benchmark-task-id>", "bind hidden acceptance tests from benchmarks/tasks.json");
}

export function registerRunCommands(program: Command, ctx: CliContext): void {
  const json = () => program.opts().json as boolean;
  const log = (s: string) => {
    if (!json()) console.error(`[intentos] ${s}`);
  };

  addOfflineOptions(
    program
      .command("plan")
      .description("Run the read-only planner and compile a validated Engineering Change Contract (no code changes)")
      .argument("<repo>", "indexed repository root")
      .argument("<task>", "task description"),
  ).action(async (repo: string, task: string, o: RunCliOpts) => {
    const store = ctx.openStore();
    try {
      const indexed = loadIndexedRepo(store, repo);
      const rs = createRun(store, indexed, requireTask(task), { ...runOptions(o, log), planOnly: true });
      const outcome = await executeRun(store, rs, { ...runOptions(o, log), planOnly: true });
      const contract = rs.readJson<ChangeContract>("contract");
      const validation = rs.readJson<Record<string, unknown>>("contractValidation");
      if (json()) console.log(JSON.stringify({ run_id: rs.runId, state: outcome.state, reason: outcome.reason, contract, validation }, null, 2));
      else {
        console.log(`run ${rs.runId}: ${outcome.state}${outcome.reason ? ` (${outcome.reason})` : ""}`);
        if (contract) console.log(`contract: decision=${contract.decision} hash=${rs.row.contract_hash?.slice(0, 12)} -> ${rs.path("contract")}`);
        if (validation) console.log(`validation: route=${String(validation.route)} issues=${(validation.issues as unknown[]).length} -> ${rs.path("contractValidation")}`);
        if (contract?.open_questions.length) for (const q of contract.open_questions) console.log(`  question ${q.id}${q.blocking ? " (blocking)" : ""}: ${q.question}`);
      }
      if (outcome.state === "FAILED") process.exitCode = 1;
    } catch (err) {
      ctx.fail((err as Error).message);
    } finally {
      store.close();
    }
  });

  addOfflineOptions(
    program
      .command("run")
      .description("Full pipeline: evidence -> contract -> isolated worktree implementation -> independent verification -> report")
      .argument("<repo>", "indexed repository root")
      .argument("<task>", "task description")
      .option("--require-approval", "pause after contract validation until `intentos approve <run-id>`", false),
  ).action(async (repo: string, task: string, o: RunCliOpts) => {
    const store = ctx.openStore();
    try {
      const indexed = loadIndexedRepo(store, repo);
      const rs = createRun(store, indexed, requireTask(task), runOptions(o, log));
      log(`run ${rs.runId} created (${rs.runDir})`);
      const outcome = await executeRun(store, rs, runOptions(o, log));
      printOutcome(rs, outcome.state, outcome.reason, json());
      if (outcome.state === "FAILED") process.exitCode = 1;
    } catch (err) {
      ctx.fail((err as Error).message);
    } finally {
      store.close();
    }
  });

  program
    .command("approve")
    .description("Approve a CONTRACT_VALIDATED run (human gate) and continue implementation + verification")
    .argument("<run-id>")
    .requiredOption("--by <name>", "approver identity recorded in the audit trail")
    .action(async (runId: string, o: { by: string }) => {
      const store = ctx.openStore();
      try {
        const { rs, report } = checkRunIntegrity(store, runId);
        if (!report.ok) ctx.fail(`integrity check failed: ${report.checks.filter((c) => !c.ok).map((c) => `${c.check}: ${c.detail}`).join("; ")}`);
        approveRun(rs, o.by);
        const task = loadTask(rs);
        const outcome = await executeRun(store, rs, { mode: task.mode, log });
        printOutcome(rs, outcome.state, outcome.reason, json());
        if (outcome.state === "FAILED") process.exitCode = 1;
      } catch (err) {
        ctx.fail((err as Error).message);
      } finally {
        store.close();
      }
    });

  program
    .command("resume")
    .description("Recover a persisted run: check worktree/revision/contract integrity and continue only from a valid state")
    .argument("<run-id>")
    .action(async (runId: string) => {
      const store = ctx.openStore();
      try {
        const { rs, report } = checkRunIntegrity(store, runId);
        if (!json()) for (const c of report.checks) console.error(`[integrity] ${c.ok ? "ok  " : c.informational ? "info" : "FAIL"} ${c.check}: ${c.detail}`);
        if (isTerminal(report.state)) {
          if (json()) console.log(JSON.stringify({ run_id: runId, state: report.state, resumed: false, reason: "terminal state" }, null, 2));
          else console.log(`run ${runId} is already in terminal state ${report.state}; nothing to resume. Use \`intentos report ${runId}\`.`);
          return;
        }
        if (!report.ok) {
          rs.event("resume.rejected", { checks: report.checks });
          rs.transition("FAILED", { reason: "integrity check failed on resume", checks: report.checks });
          rs.update({ result_json: JSON.stringify({ final_state: "FAILED", reason: "integrity check failed on resume" }) });
          generateReport(store, runId);
          ctx.fail(`cannot resume ${runId}: ${report.checks.filter((c) => !c.ok).map((c) => `${c.check} (${c.detail})`).join("; ")}`);
        }
        const task = loadTask(rs);
        rs.event("resume.started", { from_state: report.state });
        const outcome = await executeRun(store, rs, { mode: task.mode, log });
        printOutcome(rs, outcome.state, outcome.reason, json());
        if (outcome.state === "FAILED") process.exitCode = 1;
      } catch (err) {
        ctx.fail((err as Error).message);
      } finally {
        store.close();
      }
    });

  program
    .command("verify")
    .description("Re-run independent verification on a run's worktree without trusting the agent's claims")
    .argument("<run-id>")
    .action((runId: string) => {
      const store = ctx.openStore();
      try {
        const { rs, report } = checkRunIntegrity(store, runId);
        const row = rs.row;
        if (!row.worktree_path || !fs.existsSync(row.worktree_path)) ctx.fail(`run ${runId} has no worktree to verify (state ${row.state})`);
        if (!row.contract_json || !row.contract_hash) ctx.fail(`run ${runId} has no validated contract`);
        const bad = report.checks.filter((c) => !c.ok && !c.informational && c.check !== "base_revision_reachable");
        if (bad.length) ctx.fail(`integrity check failed: ${bad.map((c) => `${c.check}: ${c.detail}`).join("; ")}`);
        const task = loadTask(rs);
        const repo = store.getRepository(row.repo_id)!;
        const policy = policyForRepo(repo.path) ?? fallbackPolicy(repo.path);
        const pack = rs.readJson<EvidencePack>("evidence");
        if (!pack) ctx.fail("evidence pack missing");
        const hidden = resolveHiddenTests(policy.policy_id, task.task, task.benchmark_task_id);
        const attempt = fs.existsSync(path.join(rs.runDir, "verification")) ? fs.readdirSync(path.join(rs.runDir, "verification")).filter((d) => d.startsWith("attempt-")).length + 1 : 1;
        const result = verifyWorktree({ runId, attempt, worktree: row.worktree_path!, baseSha: row.base_sha, contract: JSON.parse(row.contract_json!) as ChangeContract, contractHash: row.contract_hash!, policy, pack: pack!, outDir: path.join(rs.runDir, "verification"), hiddenTaskTestsDir: hidden.taskDir, hiddenInvariantTestsDir: hidden.invariantsDir, eventsFile: rs.path("codexEvents"), repoPath: repo.path, simulated: task.mode === "offline" });
        rs.writeJson("verification", result);
        rs.writeJson(`verification/attempt-${attempt}/verification.json`, result);
        rs.event("verification.rerun", { attempt, status: result.status, findings: result.findings.length });
        const revocation = applyReverification(rs, result);
        if (revocation.changed && !json()) console.error(`[intentos] state ${revocation.previous} -> ${revocation.current} (revoked by re-verification)`);
        generateReport(store, runId);
        if (json()) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`verification ${result.status} (attempt ${attempt}) for run ${runId}`);
          for (const c of result.commands) console.log(`  ${c.command_id.padEnd(20)} ${c.status.padEnd(8)} ${c.summary}`);
          for (const f of result.findings) console.log(`  ${f.severity.toUpperCase().padEnd(8)} ${f.id} ${f.message}`);
          console.log(`  -> ${rs.path("verification")}`);
        }
        if (result.status === "failed") process.exitCode = 1;
      } catch (err) {
        ctx.fail((err as Error).message);
      } finally {
        store.close();
      }
    });

  program
    .command("report")
    .description("Generate report.md and report.json for a run")
    .argument("<run-id>")
    .action((runId: string) => {
      const store = ctx.openStore();
      try {
        const out = generateReport(store, runId);
        if (json()) console.log(JSON.stringify(out.json, null, 2));
        else {
          console.log(out.markdown);
          console.error(`[intentos] wrote ${out.paths.md} and ${out.paths.json}`);
        }
      } catch (err) {
        ctx.fail((err as Error).message);
      } finally {
        store.close();
      }
    });

  program
    .command("runs")
    .description("List runs")
    .option("--repo <path>", "filter by repository")
    .action((o: { repo?: string }) => {
      const store = ctx.openStore();
      try {
        let rows = store.listRuns();
        if (o.repo) {
          const indexed = loadIndexedRepo(store, o.repo);
          rows = rows.filter((r) => r.repo_id === indexed.repo.id);
        }
        if (json()) console.log(JSON.stringify(rows.map((r) => ({ ...r, task_json: JSON.parse(r.task_json), contract_json: undefined, result_json: r.result_json ? JSON.parse(r.result_json) : null })), null, 2));
        else for (const r of rows) console.log(`${r.id}  ${r.state.padEnd(22)} ${r.mode.padEnd(7)} ${r.base_sha.slice(0, 10)}  ${(JSON.parse(r.task_json) as { task: string }).task.slice(0, 70)}`);
      } catch (err) {
        ctx.fail((err as Error).message);
      } finally {
        store.close();
      }
    });

  registerDecisionCommands(program, ctx);
}

function printOutcome(rs: RunStore, state: string, reason: string | null, asJson: boolean): void {
  const row = rs.row;
  if (asJson) {
    console.log(JSON.stringify({ run_id: rs.runId, state, reason, worktree: row.worktree_path, run_dir: rs.runDir, result: row.result_json ? JSON.parse(row.result_json) : null, report: rs.path("reportMd") }, null, 2));
    return;
  }
  console.log(`run ${rs.runId}: ${state}${reason ? ` — ${reason}` : ""}`);
  if (row.worktree_path) console.log(`  worktree: ${row.worktree_path}`);
  console.log(`  artifacts: ${rs.runDir}`);
  if (fs.existsSync(rs.path("reportMd"))) console.log(`  report:   ${rs.path("reportMd")}`);
}
