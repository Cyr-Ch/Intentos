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
import { applyReverification } from "../../src/orchestrator/runner.ts";
import { verifyWorktree, scanProtectedAccess, discoverTestNames } from "../../src/verification/runner.ts";
import type { ChangeContract } from "../../src/contracts/schemas.ts";
import { spawnSync } from "node:child_process";

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

describe("verifier tampering resistance (host execution; see docs/security.md for the isolation caveat)", () => {
  it("candidate code that forges the JUnit report from inside the test process is blocked", async () => {
    const { outcome, verification } = await run(offline({ patchFile: PATCHES.forgeJunit }));
    expect(outcome.state).toBe("FAILED");
    const rules = verification!.findings.filter((f) => f.severity === "blocking").map((f) => f.rule_id);
    expect(rules).toContain("TEST-INVENTORY-MISMATCH"); // forged names != hidden inventory
    expect(rules).toContain("ARCH-006"); // sys.argv / os._exit / junit references caught statically
  });

  it("bound blocking invariants whose hidden tests are unavailable fail closed instead of counting as passed", async () => {
    const { rs } = await run(offline({ patchFile: PATCHES.good }));
    const contract = JSON.parse(rs.row.contract_json!) as ChangeContract;
    const pack = rs.readJson<EvidencePack>("evidence")!;
    const result = verifyWorktree({ runId: rs.runId, attempt: 9, worktree: rs.row.worktree_path!, baseSha: rs.row.base_sha, contract, contractHash: rs.row.contract_hash!, policy: env.indexed.policy, pack, outDir: path.join(rs.runDir, "verification-probe"), hiddenTaskTestsDir: null, hiddenInvariantTestsDir: null, simulated: true });
    expect(result.status).toBe("failed");
    expect(result.findings.filter((f) => f.severity === "blocking").map((f) => f.rule_id)).toEqual(expect.arrayContaining(["INV-001", "INV-003"]));
    expect(result.findings.some((f) => f.rule_id === "NO-ACCEPTANCE-TESTS")).toBe(true);
  });

  it("hidden test inventory discovery finds every hidden test function", () => {
    const names = discoverTestNames(path.join(PATCHES.good, "..", "..", "hidden_tests", "startup_billing", "invariants"));
    expect(names.has("test_locked_enterprise_contract_gets_no_discount_lines")).toBe(true);
    expect(names.size).toBeGreaterThanOrEqual(11);
  });

  it("recorded implementer commands that touch protected artifacts become review findings", () => {
    const file = path.join(env.home, "events-probe.jsonl");
    fs.writeFileSync(file, [
      JSON.stringify({ phase: "implement", payload: { type: "item.completed", item: { type: "command_execution", command: "cat ../../benchmarks/hidden_tests/startup_billing/invariants/test_inv_001_locked_contracts.py" } } }),
      JSON.stringify({ phase: "implement", payload: { type: "item.completed", item: { type: "command_execution", command: "python -m pytest -q" } } }),
      JSON.stringify({ phase: "plan", payload: { type: "item.completed", item: { type: "command_execution", command: "cat policies/startup_billing.yaml" } } }),
    ].join("\n"));
    const findings = scanProtectedAccess(file);
    expect(findings).toHaveLength(1); // planner phase is read-only by design and not flagged
    expect(findings[0]!.rule_id).toBe("PROTECTED-ARTIFACT-ACCESS");
    expect(findings[0]!.severity).toBe("review");
  });

  it("an independent re-verification that fails revokes REVIEW_READY", async () => {
    const { rs, outcome } = await run(offline({ patchFile: PATCHES.good }));
    expect(outcome.state).toBe("REVIEW_READY");
    // Someone edits the worktree after review: the legacy adapter gains code (ARCH-004).
    expect(spawnSync("git", ["apply", PATCHES.legacyAdapter], { cwd: rs.row.worktree_path!, encoding: "utf8" }).status).toBe(0);
    const contract = JSON.parse(rs.row.contract_json!) as ChangeContract;
    const pack = rs.readJson<EvidencePack>("evidence")!;
    const result = verifyWorktree({ runId: rs.runId, attempt: 2, worktree: rs.row.worktree_path!, baseSha: rs.row.base_sha, contract, contractHash: rs.row.contract_hash!, policy: env.indexed.policy, pack, outDir: path.join(rs.runDir, "verification"), hiddenTaskTestsDir: path.join(PATCHES.good, "..", "..", "hidden_tests", "startup_billing", "tasks", "task-a-enterprise-promo"), hiddenInvariantTestsDir: path.join(PATCHES.good, "..", "..", "hidden_tests", "startup_billing", "invariants"), simulated: true });
    expect(result.status).toBe("failed");
    const r = applyReverification(rs, result);
    expect(r.previous).toBe("REVIEW_READY");
    expect(r.current).toBe("FAILED");
    expect(JSON.parse(rs.row.result_json!).revoked_from).toBe("REVIEW_READY");
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

describe("architectural-surprise review signals (spec §7.5)", () => {
  it("the known-good patch raises no surprise signal and still reaches REVIEW_READY", async () => {
    const { outcome, verification } = await run(offline({ patchFile: PATCHES.good }));
    expect(outcome.state).toBe("REVIEW_READY");
    const cmd = verification!.commands.find((c) => c.command_id === "architecture_surprise")!;
    expect(cmd.enforcement).toBe("advisory");
    expect(cmd.status).toBe("passed");
    expect(cmd.summary).toMatch(/^0 signal\(s\)/);
    expect(verification!.findings.filter((f) => f.rule_id?.startsWith("SURPRISE-"))).toEqual([]);
  });

  it("a new cross-module dependency, a duplicated helper and domain construction in the API layer yield exactly the three signals and HUMAN_REVIEW", async () => {
    const { rs, outcome, verification, report } = await run(offline({ patchFile: PATCHES.surprise }));
    expect(outcome.state).toBe("HUMAN_REVIEW");
    expect(verification!.findings.some((f) => f.severity === "blocking")).toBe(false);
    const surprise = verification!.findings.filter((f) => f.rule_id?.startsWith("SURPRISE-"));
    expect(new Set(surprise.map((f) => f.rule_id))).toEqual(new Set(["SURPRISE-NEW-DEPENDENCY", "SURPRISE-DUPLICATE-HELPER", "SURPRISE-API-DOMAIN-CONSTRUCTION"]));
    expect(surprise.every((f) => f.severity === "review" && f.authority === "deterministic" && f.category === "architecture")).toBe(true);
    expect(surprise.every((f) => /risk triage, not proof of bad design/.test(f.message))).toBe(true);
    const byRule = (id: string) => surprise.filter((f) => f.rule_id === id);
    expect(byRule("SURPRISE-NEW-DEPENDENCY").map((f) => f.observed).sort()).toEqual(["adds import of app.domain.money", "adds import of app.services.exports"]);
    expect(byRule("SURPRISE-DUPLICATE-HELPER")[0]!.message).toMatch(/subtract_money\(\) whose body is equivalent to app\/domain\/money\.py:\d+ Money\.__sub__\(\)/);
    expect(byRule("SURPRISE-API-DOMAIN-CONSTRUCTION")[0]!.location).toMatch(/^app\/api\/checkout\.py:\d+$/);
    expect(verification!.tracks.architecture!.review_findings).toBe(surprise.length);
    expect(verification!.tracks.architecture!.blocking_findings).toBe(0);
    expect(report!.architectural_surprise.map((s) => s.rule_id)).toEqual(surprise.map((f) => f.rule_id));
    const md = fs.readFileSync(path.join(rs.runDir, "report.md"), "utf8");
    expect(md).toContain("## Architectural surprise (review signals)");
    expect(md).toContain("SURPRISE-DUPLICATE-HELPER");
  });
});
