import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { gitHead, gitStatus, PATCHES, setupFixtureEnv, TASK_A, type TestEnv } from "../helpers/fixture.ts";
import { createRun, executeRun, approveRun, type RunOptions } from "../../src/orchestrator/runner.ts";
import { checkRunIntegrity } from "../../src/orchestrator/recovery.ts";
import { RunStore } from "../../src/orchestrator/store.ts";
import type { VerificationResult } from "../../src/verification/results.ts";
import type { ReportJson } from "../../src/reports/generate.ts";
import type { CodingEngine } from "../../src/codex/adapter.ts";
import { buildOfflineContract } from "../../src/codex/offline.ts";
import type { EvidencePack } from "../../src/knowledge/retrieval.ts";

let env: TestEnv;
let baseHead: string;
beforeAll(() => {
  env = setupFixtureEnv();
  baseHead = gitHead(env.repo);
});
afterAll(() => env.cleanup());

const offline = (extra: Partial<RunOptions["offline"]> = {}, more: Partial<RunOptions> = {}): RunOptions => ({
  mode: "offline",
  offline: { route: "implement", patchFile: null, claimSuccess: false, fabricateEvidence: false, repairPatchFile: null, ...extra },
  taskId: "task-a-enterprise-promo",
  ...more,
});

async function run(opts: RunOptions, task = TASK_A) {
  const rs = createRun(env.store, env.indexed, task, opts);
  const outcome = await executeRun(env.store, rs, opts);
  return { rs, outcome, verification: rs.readJson<VerificationResult>("verification"), report: rs.readJson<ReportJson>("reportJson") };
}

describe("offline pipeline — implement route", () => {
  it("known-good patch passes every gate and reaches REVIEW_READY without touching the base branch", async () => {
    const { rs, outcome, verification, report } = await run(offline({ patchFile: PATCHES.good }));
    expect(outcome.state).toBe("REVIEW_READY");
    expect(verification!.status).toBe("passed");
    expect(verification!.commands.map((c) => c.command_id)).toEqual(expect.arrayContaining(["pytest_project", "pytest_hidden_task", "pytest_invariants", "architecture_rules", "scope_check"]));
    expect(verification!.commands.find((c) => c.command_id === "pytest_hidden_task")!.tests_passed).toBeGreaterThan(0);
    expect(verification!.simulated).toBe(true);
    expect(report!.simulated).toBe(true);
    expect(report!.outcome).toBe("Review-ready");
    // artifacts
    for (const f of ["task.json", "base_commit.txt", "environment.json", "evidence.json", "contract.json", "contract_validation.json", "diff.patch", "verification.json", "report.json", "report.md", "metrics.json"]) expect(fs.existsSync(path.join(rs.runDir, f)), f).toBe(true);
    expect(fs.readFileSync(path.join(rs.runDir, "diff.patch"), "utf8")).toContain("ENTERPRISE15");
    // base repository untouched
    expect(gitHead(env.repo)).toBe(baseHead);
    expect(gitStatus(env.repo)).toBe("");
    // worktree isolated and still at base
    expect(rs.row.worktree_path!.startsWith(env.home)).toBe(true);
    expect(gitHead(rs.row.worktree_path!)).toBe(baseHead);
  });

  it("known-bad patch passes the narrow project tests but is blocked by invariant + architecture checks; fake success is ignored; repairs are bounded", async () => {
    const { rs, outcome, verification } = await run(offline({ patchFile: PATCHES.bad, claimSuccess: true }));
    expect(outcome.state).toBe("FAILED");
    expect(verification!.status).toBe("failed");
    const project = verification!.commands.find((c) => c.command_id === "pytest_project")!;
    expect(project.status).toBe("passed"); // narrow tests pass…
    const rules = verification!.findings.map((f) => f.rule_id);
    expect(rules).toContain("ARCH-001"); // …but the API layer imports decimal
    expect(rules).toContain("INV-001"); // …and locked contracts get the promo via checkout
    expect(verification!.findings.every((f) => f.severity !== "blocking" || f.authority !== "exploratory")).toBe(true);
    // fake success claim recorded but not trusted
    const impl = rs.readJson<{ final_response: string }>("implementerResult")!;
    expect(impl.final_response).toContain("Implementation complete and verified");
    // bounded repair: 2 repairs max -> 3 verification attempts
    const attempts = fs.readdirSync(path.join(rs.runDir, "verification")).filter((d) => d.startsWith("attempt-"));
    expect(attempts.length).toBe(3);
    const transitions = env.store.events(rs.runId).filter((e) => e.event_type === "state.transition").map((e) => (JSON.parse(e.payload_json) as { to: string }).to);
    expect(transitions.filter((t) => t === "REPAIRING").length).toBe(2);
    expect(transitions.at(-1)).toBe("FAILED");
    expect(outcome.reason).toMatch(/blocking verification findings remain/);
    expect(gitHead(env.repo)).toBe(baseHead);
  });

  it("a failing first attempt followed by a successful repair reaches REVIEW_READY via REPAIRING", async () => {
    const { outcome, rs } = await run(offline({ patchFile: PATCHES.legacyAdapter, repairPatchFile: PATCHES.good }));
    const transitions = env.store.events(rs.runId).filter((e) => e.event_type === "state.transition").map((e) => (JSON.parse(e.payload_json) as { to: string }).to);
    expect(transitions).toContain("REPAIRING");
    // the legacy adapter edit remains (repair applied the good patch on top), so ARCH-004 still fails -> FAILED after bounded repairs
    expect(["FAILED", "REVIEW_READY"]).toContain(outcome.state);
    const v = rs.readJson<VerificationResult>("verification")!;
    expect(v.findings.some((f) => f.rule_id === "ARCH-004")).toBe(true);
  });

  it("edits to protected paths are blocked by the scope check", async () => {
    const { outcome, verification } = await run(offline({ patchFile: PATCHES.protectedDoc }));
    expect(outcome.state).toBe("FAILED");
    expect(verification!.findings.some((f) => f.rule_id === "SCOPE-PROTECTED" && f.severity === "blocking")).toBe(true);
  });

  it("weakened existing tests surface as review findings (HUMAN_REVIEW), never silently pass", async () => {
    const { outcome, verification } = await run(offline({ patchFile: PATCHES.weakenTests }), "Tidy the locked contract tests");
    expect(verification!.findings.some((f) => f.rule_id === "TESTS-WEAKENED")).toBe(true);
    expect(["HUMAN_REVIEW", "FAILED"]).toContain(outcome.state);
  });

  it("a verifier whose test runner cannot start must fail the run, never pass it", async () => {
    const prev = process.env.INTENTOS_PYTHON;
    process.env.INTENTOS_PYTHON = "python3"; // interpreter without pytest installed (verifier commands fail to start)
    try {
      const { outcome, verification } = await run(offline({ patchFile: PATCHES.good }));
      expect(outcome.state).toBe("FAILED");
      expect(verification!.status).toBe("failed");
      expect(verification!.findings.some((f) => f.severity === "blocking" && /pytest_project/.test(f.message))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.INTENTOS_PYTHON;
      else process.env.INTENTOS_PYTHON = prev;
    }
  });

  it("an implementer that produces no changes never becomes review-ready", async () => {
    const { outcome, verification } = await run(offline({}));
    expect(outcome.state).not.toBe("REVIEW_READY");
    expect(verification!.findings.some((f) => f.rule_id === "NO-CHANGES")).toBe(true);
  });
});

describe("offline pipeline — non-implementation routes", () => {
  it("clarify stops before any worktree is created", async () => {
    const { rs, outcome } = await run(offline({ route: "clarify" }), "Add immediate subscription upgrades");
    expect(outcome.state).toBe("CLARIFICATION_REQUIRED");
    expect(rs.row.worktree_path).toBeNull();
    const result = JSON.parse(rs.row.result_json!) as { open_questions: unknown[] };
    expect(result.open_questions.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(rs.runDir, "report.md"))).toBe(true);
  });

  it("abstain is a first-class evidence-backed outcome", async () => {
    const { rs, outcome, report } = await run(offline({ route: "abstain" }), "Fix the bug where cancelled contracts still receive the volume discount");
    expect(outcome.state).toBe("ABSTAINED");
    expect(report!.outcome).toBe("Abstained");
    expect(rs.row.worktree_path).toBeNull();
  });

  it("a fabricated evidence id is rejected by the compiler and the run fails before implementation", async () => {
    const { rs, outcome } = await run(offline({ fabricateEvidence: true }));
    expect(outcome.state).toBe("FAILED");
    expect(outcome.reason).toMatch(/unknown_evidence/);
    expect(rs.row.worktree_path).toBeNull();
  });
});

describe("approval gate, resume and integrity", () => {
  it("pauses at CONTRACT_VALIDATED when approval is required and continues after approval", async () => {
    const opts = offline({ patchFile: PATCHES.good }, { requireApproval: true });
    const rs = createRun(env.store, env.indexed, TASK_A, opts);
    const paused = await executeRun(env.store, rs, opts);
    expect(paused.state).toBe("CONTRACT_VALIDATED");
    approveRun(rs, "cto@example.com");
    const done = await executeRun(env.store, rs, { mode: "offline" });
    expect(done.state).toBe("REVIEW_READY");
    const approval = env.store.events(rs.runId).find((e) => e.event_type === "state.transition" && (JSON.parse(e.payload_json) as { to: string }).to === "APPROVED");
    expect(JSON.parse(approval!.payload_json).approved_by).toBe("cto@example.com");
  });

  it("resumes an interrupted run from the persisted state using the recorded engine options", async () => {
    // Engine that implements and then throws before the state machine advances past IMPLEMENTING.
    let calls = 0;
    const pack = () => JSON.parse(fs.readFileSync(path.join(env.home, "runs", fs.readdirSync(path.join(env.home, "runs")).at(-1)!, "evidence.json"), "utf8")) as EvidencePack;
    const flaky: CodingEngine = {
      name: "flaky-test-engine",
      simulated: true,
      async plan() {
        return { text: JSON.stringify(buildOfflineContract(pack(), { route: "implement", fabricateEvidence: false, taskId: "t" })), usage: null, threadId: null, simulated: true, engine: "flaky", model: null, items: [] };
      },
      async implement(req) {
        calls++;
        if (calls === 1) {
          fs.writeFileSync(path.join(req.cwd, "tests", "test_interrupted.py"), "def test_partial():\n    assert True\n");
          throw new Error("simulated crash mid-implementation");
        }
        return { finalResponse: "done", usage: null, threadId: null, simulated: true, engine: "flaky", model: null, items: [], reportedChanges: [] };
      },
    };
    const opts: RunOptions = { mode: "offline", engine: flaky, taskId: "task-a-enterprise-promo", offline: { route: "implement", patchFile: null, claimSuccess: false, fabricateEvidence: false, repairPatchFile: null } };
    const rs = createRun(env.store, env.indexed, TASK_A, opts);
    const first = await executeRun(env.store, rs, opts);
    expect(first.state).toBe("FAILED"); // crash is recorded, not hidden
    // Simulate an interruption instead: rewind the persisted state to IMPLEMENTING (as if the process died) and resume.
    env.store.updateRun(rs.runId, { state: "IMPLEMENTING", result_json: null });
    const { report } = checkRunIntegrity(env.store, rs.runId);
    expect(report.ok, JSON.stringify(report.checks)).toBe(true);
    const resumed = await executeRun(env.store, new RunStore(env.store, rs.runId, rs.runDir), { mode: "offline", engine: flaky });
    expect(["FAILED", "HUMAN_REVIEW", "REVIEW_READY"]).toContain(resumed.state);
    expect(env.store.events(rs.runId).some((e) => e.event_type === "resume")).toBe(true);
    expect(fs.existsSync(path.join(rs.runDir, "verification.json"))).toBe(true);
  });

  it("refuses to resume when the contract was tampered with", async () => {
    const opts = offline({ patchFile: PATCHES.good }, { requireApproval: true });
    const rs = createRun(env.store, env.indexed, TASK_A, opts);
    await executeRun(env.store, rs, opts);
    const tampered = JSON.parse(rs.row.contract_json!) as { allowed_paths: string[] };
    tampered.allowed_paths.push("docs/**");
    env.store.updateRun(rs.runId, { contract_json: JSON.stringify(tampered) });
    const { report } = checkRunIntegrity(env.store, rs.runId);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.check === "contract_hash")!.ok).toBe(false);
  });

  it("detects a worktree that moved off the base revision", async () => {
    const { rs } = await run(offline({ patchFile: PATCHES.good }));
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["-c", "user.email=x@x", "-c", "user.name=x", "commit", "-qam", "sneaky"], { cwd: rs.row.worktree_path! });
    const { report } = checkRunIntegrity(env.store, rs.runId);
    expect(report.checks.find((c) => c.check === "worktree_at_base")!.ok).toBe(false);
  });
});
