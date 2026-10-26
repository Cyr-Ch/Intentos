import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PATCHES, setupFixtureEnv, TASK_A, type TestEnv } from "../helpers/fixture.ts";
import { createRun, executeRun, MAX_RESUME_REENTRIES, type RunOptions } from "../../src/orchestrator/runner.ts";
import { checkRunIntegrity } from "../../src/orchestrator/recovery.ts";
import { RunStore } from "../../src/orchestrator/store.ts";
import type { CodingEngine, ImplementRequest, ImplementResult } from "../../src/codex/adapter.ts";
import { buildOfflineContract } from "../../src/codex/offline.ts";
import { buildContinuePrompt } from "../../src/contracts/prompts.ts";
import type { EvidencePack } from "../../src/knowledge/retrieval.ts";
import type { ChangeContract } from "../../src/contracts/schemas.ts";
import type { Finding } from "../../src/verification/results.ts";

let env: TestEnv;
beforeAll(() => {
  env = setupFixtureEnv();
});
afterAll(() => env.cleanup());

const TASK_ID = "task-a-enterprise-promo";
const PARTIAL = path.join("tests", "test_partial_progress.py");

/**
 * Stand-in for the live SDK engine: `simulated: false` so the orchestrator takes the live path, but no Codex
 * process is involved. `implement` is scripted per test; calls, thread ids and prompts are recorded.
 */
function standIn(rs: RunStore, implement: (req: ImplementRequest, call: number) => Promise<ImplementResult>, opts: { simulated?: boolean } = {}) {
  const log = { calls: 0, threadIds: [] as Array<string | null | undefined>, prompts: [] as string[] };
  const simulated = opts.simulated ?? false;
  const engine: CodingEngine = {
    name: "live-stand-in",
    simulated,
    async plan() {
      const pack = rs.readJson<EvidencePack>("evidence")!;
      const contract = buildOfflineContract(pack, { route: "implement", fabricateEvidence: false, taskId: TASK_ID });
      return { text: JSON.stringify(contract), usage: null, threadId: null, simulated, engine: "live-stand-in", model: null, items: [] };
    },
    async implement(req) {
      log.calls++;
      log.threadIds.push(req.threadId);
      log.prompts.push(req.prompt);
      req.onEvent?.({ timestamp: new Date().toISOString(), type: "stand-in.turn", payload: { call: log.calls } });
      return implement(req, log.calls);
    },
  };
  return { engine, log };
}

const done = (req: ImplementRequest): ImplementResult => ({ finalResponse: "continued and finished", usage: null, threadId: req.threadId ?? null, simulated: false, engine: "live-stand-in", model: null, items: [], reportedChanges: [] });

/** Rewind persisted state as if the process died mid-turn (the state machine itself never goes backwards). */
function interruptAt(rs: RunStore, state: "IMPLEMENTING" | "REPAIRING") {
  env.store.updateRun(rs.runId, { state, result_json: null });
  return new RunStore(env.store, rs.runId, rs.runDir);
}

const events = (rs: RunStore, type: string) => env.store.events(rs.runId).filter((e) => e.event_type === type).map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);

/** Continuation prompts are the only `implement` calls that re-enter a thread; repair prompts are ordinary bounded repairs. */
const continuations = (log: { prompts: string[] }) => log.prompts.filter((p) => p.includes("turn was interrupted"));

describe("resume re-enters the interrupted Codex thread", () => {
  it("persists the thread id at thread.started, re-enters that thread on resume and finishes REVIEW_READY", async () => {
    const opts: RunOptions = { mode: "live", taskId: TASK_ID };
    const rs = createRun(env.store, env.indexed, TASK_A, opts);
    const first = standIn(rs, async (req) => {
      req.onThreadStarted?.("thread-test-1");
      fs.writeFileSync(path.join(req.cwd, PARTIAL), "def test_partial_progress():\n    assert True\n");
      throw new Error("simulated crash mid-turn");
    });
    const crashed = await executeRun(env.store, rs, { ...opts, engine: first.engine });
    expect(crashed.state).toBe("FAILED"); // the crash is recorded, never hidden
    expect(rs.row.codex_thread_id).toBe("thread-test-1"); // persisted although the turn never completed
    expect(events(rs, "implementer.thread_started")).toEqual([{ id: "thread-test-1" }]);

    const resumable = interruptAt(rs, "IMPLEMENTING");
    const { report } = checkRunIntegrity(env.store, rs.runId);
    expect(report.ok, JSON.stringify(report.checks)).toBe(true);
    expect(report.checks.find((c) => c.check === "codex_thread_known")).toMatchObject({ ok: true, informational: true, detail: "thread thread-test-1" });

    const second = standIn(rs, async (req) => {
      // The agent "continues": finalises the partial file away and lands the real change.
      fs.rmSync(path.join(req.cwd, PARTIAL));
      const res = spawnSync("git", ["apply", PATCHES.good], { cwd: req.cwd, encoding: "utf8" });
      if (res.status !== 0) throw new Error(res.stderr);
      return done(req);
    });
    const resumed = await executeRun(env.store, resumable, { mode: "live", engine: second.engine });
    expect(second.log.calls).toBe(1);
    expect(second.log.threadIds).toEqual(["thread-test-1"]); // same thread, not a new one
    expect(second.log.prompts[0]).toContain("interrupted");
    expect(second.log.prompts[0]).toContain("git status");
    expect(second.log.prompts[0]).toContain(JSON.parse(rs.row.contract_json!).goal);
    expect(events(rs, "resume.reentered")).toEqual([{ phase: "implement", thread_id: "thread-test-1", attempt: 1 }]);
    expect(fs.readFileSync(path.join(rs.runDir, "continue_prompt.1.txt"), "utf8")).toBe(second.log.prompts[0]);
    expect(fs.existsSync(path.join(rs.runDir, "implementer_result.json"))).toBe(true);
    expect(resumed.state).toBe("REVIEW_READY");
    expect(resumed.verification!.status).toBe("passed");
    expect(fs.existsSync(path.join(rs.row.worktree_path!, PARTIAL))).toBe(false);

    // An interruption during a repair re-enters with the repair phase and the last findings.
    const repairing = interruptAt(rs, "REPAIRING");
    const third = standIn(rs, async (req) => done(req));
    const again = await executeRun(env.store, repairing, { mode: "live", engine: third.engine });
    expect(third.log.threadIds).toEqual(["thread-test-1"]);
    expect(third.log.prompts[0]).toContain("repair turn was interrupted");
    expect(third.log.prompts[0]).toContain("Blocking findings from the last verification");
    expect(events(rs, "resume.reentered").at(-1)).toMatchObject({ phase: "repair", attempt: 2 });
    expect(fs.existsSync(path.join(rs.runDir, "continue_prompt.2.txt"))).toBe(true);
    expect(fs.existsSync(path.join(rs.runDir, "implementer_result.repair-1.json"))).toBe(true);
    expect(again.state).toBe("REVIEW_READY");
  });

  it(`re-enters at most ${MAX_RESUME_REENTRIES} times per run, then verifies the worktree directly`, async () => {
    const opts: RunOptions = { mode: "live", taskId: TASK_ID };
    const rs = createRun(env.store, env.indexed, TASK_A, opts);
    const crashy = standIn(rs, async (req) => {
      req.onThreadStarted?.("thread-test-2");
      throw new Error("crash after thread.started");
    });
    expect((await executeRun(env.store, rs, { ...opts, engine: crashy.engine })).state).toBe("FAILED");
    for (let i = 1; i <= MAX_RESUME_REENTRIES + 1; i++) {
      const outcome = await executeRun(env.store, interruptAt(rs, "IMPLEMENTING"), { mode: "live", engine: crashy.engine });
      if (i <= MAX_RESUME_REENTRIES) {
        expect(outcome.reason).toMatch(/crash after thread.started/); // re-entered and crashed again
        expect(continuations(crashy.log)).toHaveLength(i);
        expect(outcome.verification).toBeNull(); // the crash happened before any verification
      } else {
        expect(continuations(crashy.log)).toHaveLength(MAX_RESUME_REENTRIES); // no further re-entry…
        expect(outcome.verification).not.toBeNull(); // …the unchanged worktree was verified as is (then bounded repair as usual)
      }
    }
    expect(events(rs, "resume.reentered").map((e) => e.attempt)).toEqual([1, 2]);
    const direct = events(rs, "resume");
    expect(direct).toHaveLength(1);
    expect(direct[0]!.reason).toMatch(/re-entry limit reached/);
    expect(fs.existsSync(path.join(rs.runDir, "verification.json"))).toBe(true);
  });

  it("verifies as is when no thread id was recorded, and never re-enters a simulated engine", async () => {
    // (a) live engine that died before the SDK reported a thread id
    const opts: RunOptions = { mode: "live", taskId: TASK_ID };
    const rs = createRun(env.store, env.indexed, TASK_A, opts);
    const silent = standIn(rs, async () => {
      throw new Error("crash before thread.started");
    });
    await executeRun(env.store, rs, { ...opts, engine: silent.engine });
    expect(rs.row.codex_thread_id).toBeNull();
    const resumable = interruptAt(rs, "IMPLEMENTING");
    const { report } = checkRunIntegrity(env.store, rs.runId);
    expect(report.ok).toBe(true); // the informational check never fails integrity…
    expect(report.checks.find((c) => c.check === "codex_thread_known")).toMatchObject({ ok: false, informational: true }); // …but it is reported
    await executeRun(env.store, resumable, { mode: "live", engine: silent.engine });
    expect(continuations(silent.log)).toHaveLength(0); // existing behaviour: straight to verification (repairs follow as usual)
    expect(silent.log.threadIds.every((t) => !t)).toBe(true);
    expect(events(rs, "resume.reentered")).toHaveLength(0);
    expect(events(rs, "resume")[0]!.reason).toMatch(/no Codex thread id/);
    expect(fs.existsSync(path.join(rs.runDir, "verification.json"))).toBe(true);

    // (b) a simulated engine, even one that reports a thread id, is never re-entered
    const offline: RunOptions = { mode: "offline", taskId: TASK_ID, offline: { route: "implement", patchFile: null, claimSuccess: false, fabricateEvidence: false, repairPatchFile: null } };
    const rs2 = createRun(env.store, env.indexed, TASK_A, offline);
    const sim = standIn(rs2, async (req) => {
      req.onThreadStarted?.("thread-sim");
      throw new Error("crash");
    }, { simulated: true });
    await executeRun(env.store, rs2, { ...offline, engine: sim.engine });
    expect(rs2.row.codex_thread_id).toBe("thread-sim");
    await executeRun(env.store, interruptAt(rs2, "IMPLEMENTING"), { mode: "offline", engine: sim.engine });
    expect(continuations(sim.log)).toHaveLength(0);
    expect(events(rs2, "resume.reentered")).toHaveLength(0);
    expect(events(rs2, "resume")[0]!.reason).toMatch(/simulated/);
    expect(checkRunIntegrity(env.store, rs2.runId).report.checks.find((c) => c.check === "codex_thread_known")!.ok).toBe(true);
  });

  it("refuses to re-enter when the worktree moved off the base revision (integrity gate stays closed)", async () => {
    const opts: RunOptions = { mode: "live", taskId: TASK_ID };
    const rs = createRun(env.store, env.indexed, TASK_A, opts);
    const eng = standIn(rs, async (req) => {
      req.onThreadStarted?.("thread-test-3");
      throw new Error("crash");
    });
    await executeRun(env.store, rs, { ...opts, engine: eng.engine });
    spawnSync("git", ["-c", "user.email=x@x", "-c", "user.name=x", "commit", "-q", "--allow-empty", "-m", "sneaky"], { cwd: rs.row.worktree_path! });
    const resumable = interruptAt(rs, "IMPLEMENTING");
    const { report } = checkRunIntegrity(env.store, rs.runId);
    expect(report.ok).toBe(false); // the CLI refuses here; the orchestrator guard below is defence in depth
    expect(report.checks.find((c) => c.check === "worktree_at_base")!.ok).toBe(false);
    await executeRun(env.store, resumable, { mode: "live", engine: eng.engine });
    expect(continuations(eng.log)).toHaveLength(0);
    expect(events(rs, "resume.reentered")).toHaveLength(0);
    expect(events(rs, "resume")[0]!.reason).toMatch(/not the run base/);
  });
});

describe("continuation prompt", () => {
  const contract: ChangeContract = {
    schema_version: "1.0",
    task_id: "t",
    goal: "Add the promo",
    decision: "implement",
    base_revision: "abc",
    requirements: [{ id: "REQ-001", statement: "Enterprise plans get 15% off", evidence_ids: [], certainty: "hypothesized" }],
    reuse_candidates: [],
    business_invariants: [{ id: "INV-001", evidence_ids: [], enforcement: "blocking" }],
    architecture_constraints: [{ id: "ARCH-001", evidence_ids: [], enforcement: "blocking" }],
    affected_modules: [],
    allowed_paths: ["app/services/**", "tests/**"],
    protected_paths: ["docs/**"],
    verification: [],
    open_questions: [],
    rationale: "",
    max_repairs: 2,
  } as unknown as ChangeContract;
  const finding: Finding = { id: "F-1", category: "business_invariant", severity: "blocking", rule_id: "INV-001", source_evidence_ids: [], test: "test_locked", expected: "no discount", observed: "discount applied", message: "locked contract received the promo", location: "app/api/checkout.py:12", log_path: null, authority: "hidden_test" };

  it("restates the contract, tells the agent not to start over, and includes the last blocking findings for repairs", () => {
    const impl = buildContinuePrompt(contract, "implement", [finding]);
    expect(impl).toContain("implementation turn was interrupted");
    expect(impl).toContain("Do not start over");
    expect(impl).toContain("app/services/**, tests/**");
    expect(impl).toContain("docs/**");
    expect(impl).toContain("REQ-001");
    expect(impl).toContain("INV-001 [blocking]");
    expect(impl).not.toContain("Blocking findings"); // only repairs carry findings
    const repair = buildContinuePrompt(contract, "repair", [finding, { ...finding, id: "F-2", severity: "review", message: "style nit" }]);
    expect(repair).toContain("repair turn was interrupted");
    expect(repair).toContain("F-1 [business_invariant INV-001] locked contract received the promo (test: test_locked) expected=no discount observed=discount applied at app/api/checkout.py:12");
    expect(repair).not.toContain("style nit");
  });
});
