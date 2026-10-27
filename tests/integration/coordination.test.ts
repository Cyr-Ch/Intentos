/**
 * mergeguard inside IntentOS: several runs share one repository; main moves under them.
 *
 * Offline runs (simulated implementer, real verifier, real mergeguard) on the startup_billing fixture, in order:
 *   1. four runs are verified at the same base; each carries a coordination track
 *   2. a verified run merges through a PR: review tier, head-bound approval, merged-result verification with the
 *      hidden tests, mergeguard's own merged-tree test run, fast-forward of the checkout's main, ledger, re-index
 *   3. a change of meaning behind unchanged names (no sync note possible) is caught by the merged-result verification
 *      and, independently, by mergeguard's merged-tree tests, before main moves
 *   4. when both are bypassed and main breaks, the guardian names the culprit merge and its partner and opens a
 *      validated undo PR that merges back through the same gate
 *   5. a public rename needs two humans; a run whose tree is stale against it is told the exact symbol and blocked
 *      at the gate until main is brought in
 *   6. the live-agent sync (fast-forward of the worktree) advances the run's base instead of failing integrity
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gitHead, PATCHES, setupFixtureEnv, TASK_A, type TestEnv } from "../helpers/fixture.ts";
import { advanceBase, createRun, executeRun, type RunOptions } from "../../src/orchestrator/runner.ts";
import { loadIndexedRepo } from "../../src/knowledge/repo.ts";
import { repoIdFor } from "../../src/knowledge/indexer.ts";
import { RunStore } from "../../src/orchestrator/store.ts";
import { guardRepo, listRepoPrs, mergeNumberedPr, mergeRun } from "../../src/coordination/merge.ts";
import { coordinationEnv, coordinationStatus, readLedger, resetCoordinationProbe, syncCheck } from "../../src/coordination/mergeguard.ts";
import { verifyWorktree } from "../../src/verification/runner.ts";
import { resolveHiddenTests } from "../../src/orchestrator/tasks.ts";
import type { VerificationResult } from "../../src/verification/results.ts";
import type { ChangeContract } from "../../src/contracts/schemas.ts";
import type { EvidencePack } from "../../src/knowledge/retrieval.ts";

const LONG = 600_000;
let env: TestEnv;

beforeAll(() => {
  delete process.env.INTENTOS_COORDINATION;
  delete process.env.INTENTOS_COORDINATION_MERGE_CHECK;
  resetCoordinationProbe();
  env = setupFixtureEnv();
});
afterAll(() => env.cleanup());

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

function pytest(cwd: string, ...targets: string[]) {
  return spawnSync(coord().python, ["-m", "pytest", "-q", ...targets, "-p", "no:cacheprovider", "-o", "pythonpath=."], { cwd, encoding: "utf8" });
}

function edit(dir: string, rel: string, fn: (text: string) => string): void {
  const file = path.join(dir, rel);
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fn(before));
}

/** A unified diff against the repository's current HEAD, produced by editing a throwaway worktree. */
function makePatch(name: string, apply: (dir: string) => void): string {
  const dir = path.join(env.home, "patch-src", name);
  git(env.repo, ["worktree", "add", "--detach", dir, "HEAD"]);
  try {
    apply(dir);
    const untracked = git(dir, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
    if (untracked.length) git(dir, ["add", "-N", "--", ...untracked]);
    const diff = spawnSync("git", ["diff", "--no-color", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout;
    const file = path.join(env.home, "patches", `${name}.patch`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, diff);
    return file;
  } finally {
    git(env.repo, ["worktree", "remove", "--force", dir]);
  }
}

async function runOffline(task: string, patchFile: string, taskId: string | null) {
  const indexed = loadIndexedRepo(env.store, env.repo);
  const opts: RunOptions = { mode: "offline", offline: { route: "implement", patchFile, claimSuccess: false, fabricateEvidence: false, repairPatchFile: null }, taskId };
  const rs = createRun(env.store, indexed, task, opts);
  const outcome = await executeRun(env.store, rs, opts);
  return { rs, outcome, verification: rs.readJson<VerificationResult>("verification")! };
}

function coord() {
  return coordinationEnv(env.repo, loadIndexedRepo(env.store, env.repo).policy);
}

function prOf(run: { rs: RunStore }): number {
  return (JSON.parse(run.rs.row.result_json!) as { merge: { pr: number } }).merge.pr;
}

function reverify(rs: RunStore): VerificationResult {
  const row = rs.row;
  const repo = env.store.getRepository(row.repo_id)!;
  const policy = loadIndexedRepo(env.store, repo.path).policy;
  const task = JSON.parse(row.task_json) as { task: string; benchmark_task_id: string | null };
  const hidden = resolveHiddenTests(policy.policy_id, task.task, task.benchmark_task_id);
  const attempt = fs.readdirSync(path.join(rs.runDir, "verification")).filter((d) => d.startsWith("attempt-")).length + 1;
  const result = verifyWorktree({ runId: rs.runId, attempt, worktree: row.worktree_path!, baseSha: row.base_sha, contract: JSON.parse(row.contract_json!) as ChangeContract, contractHash: row.contract_hash!, policy, pack: rs.readJson<EvidencePack>("evidence")!, outDir: path.join(rs.runDir, "verification"), hiddenTaskTestsDir: hidden.taskDir, hiddenInvariantTestsDir: hidden.invariantsDir, eventsFile: null, repoPath: repo.path, simulated: true, coordination: coord() });
  rs.writeJson("verification", result);
  return result;
}

// Rename the audit log class with a compatibility alias. pricing.py keeps importing the alias (it is X's file).
const renameAuditLog = (dir: string) => {
  for (const rel of ["app/services/subscriptions.py", "app/services/entitlements.py", "tests/test_locked_contract.py", "tests/test_checkout.py", "tests/test_subscription_upgrade.py"]) {
    edit(dir, rel, (t) => t.replace(/\bAuditLog\b/g, "EventLog"));
  }
  edit(dir, "app/services/audit.py", (t) => t.replace("class AuditLog:", "class EventLog:") + "\n\n# Compatibility alias during the rename; new code imports EventLog.\nAuditLog = EventLog\n");
};

const auditTest = (dir: string) =>
  edit(dir, "tests/test_audit_log_events.py", () => 'from app.services.audit import AuditLog\n\n\ndef test_events_filters_by_type():\n    log = AuditLog()\n    log.record("quote.created", contract_id="c-1")\n    log.record("payment.confirmed", contract_id="c-1")\n    assert [e.event_type for e in log.events("quote.created")] == ["quote.created"]\n');

// A change of meaning with no symbol change: quotes keep only registered discount codes.
const allowlist = (dir: string) => {
  edit(dir, "app/services/pricing.py", (t) =>
    t
      .replace("from app.services.discounts import DiscountPolicy\n", 'from app.services.discounts import DiscountPolicy\n\n# Only registered discount codes reach a quote; anything else is dropped before totals are computed.\nKNOWN_DISCOUNT_CODES = frozenset({"VOLUME10"})\n')
      .replace("        discounts = self._discount_policy.applicable_discounts(contract, subtotal, today)\n", "        discounts = [line for line in self._discount_policy.applicable_discounts(contract, subtotal, today) if line.code in KNOWN_DISCOUNT_CODES]\n"),
  );
  edit(dir, "tests/test_discount_allowlist.py", () => 'from app.domain.contracts import DiscountLine\nfrom app.domain.money import Money\nfrom app.services.audit import AuditLog\nfrom app.services.discounts import DiscountPolicy\nfrom app.services.pricing import PricingService\n\n\nclass _UnknownCode(DiscountPolicy):\n    def applicable_discounts(self, contract, subtotal, today):\n        return [DiscountLine(code="MYSTERY", description="unregistered", amount=Money.of("1.00"))]\n\n\ndef test_unregistered_discount_codes_are_dropped(make_contract, today):\n    quote = PricingService(_UnknownCode(), AuditLog()).quote(make_contract(seats=1), today)\n    assert quote.discounts == []\n    assert quote.total == quote.subtotal\n');
};

const smallTest = (name: string, body: string) => (dir: string) => edit(dir, `tests/${name}.py`, () => body);

describe("mergeguard coordination inside IntentOS (offline runs, real verifier, real mergeguard)", () => {
  let runB: Awaited<ReturnType<typeof runOffline>>;
  let runR: Awaited<ReturnType<typeof runOffline>>;
  let runX: Awaited<ReturnType<typeof runOffline>>;
  let runA: Awaited<ReturnType<typeof runOffline>>;
  let mainAfterX: string;

  it("coordination is available and every offline run carries a coordination track", { timeout: LONG }, async () => {
    expect(coordinationStatus().ok, coordinationStatus().reason).toBe(true);
    const patchB = makePatch("audit-test", auditTest);
    const patchR = makePatch("rename-auditlog", renameAuditLog);
    const patchX = makePatch("allowlist", allowlist);
    runB = await runOffline("Add a regression test for audit log event filtering", patchB, null);
    runR = await runOffline("Rename AuditLog to EventLog and keep a compatibility alias", patchR, null);
    runX = await runOffline("Only registered discount codes reach a quote", patchX, null);
    runA = await runOffline(TASK_A, PATCHES.good, "task-a-enterprise-promo");
    for (const r of [runB, runR, runX]) expect(r.outcome.state, r.outcome.reason ?? "").toBe("HUMAN_REVIEW"); // no hidden acceptance tests bound
    expect(runA.outcome.state, runA.outcome.reason ?? "").toBe("REVIEW_READY");
    for (const r of [runB, runR, runX, runA]) {
      expect(r.verification.coordination).toMatchObject({ main_branch: "main", stale: false, issues: [] });
      expect(r.verification.tracks.coordination).toMatchObject({ status: "passed", blocking_findings: 0 });
      expect(r.verification.commands.find((c) => c.command_id === "sync_check")?.status).toBe("passed");
    }
    const events = env.store.events(runA.rs.runId).map((e) => e.event_type);
    expect(events).toContain("coordination.on");
    expect(events).not.toContain("coordination.hooks_installed"); // simulated engine: no agent to hook
    expect(fs.existsSync(path.join(env.home, "coordination"))).toBe(true);
    expect(fs.readFileSync(runA.rs.path("implementationPrompt"), "utf8")).toContain("git stash && git merge --ff-only main && git stash pop");
  });

  it("a verified run merges through a PR: tier, head-bound approval, merged-result verification, fast-forward, ledger, re-index", { timeout: LONG }, () => {
    const before = gitHead(env.repo);
    const blocked = mergeRun(env.store, runX.rs.runId, { by: "priya" });
    expect(blocked.merged).toBe(false);
    expect(blocked.pr.min_tier).toBe(1);
    expect(blocked.pr.decision.tier).toBe(1);
    expect(blocked.pr.decision.reasons.join(" | ")).toMatch(/IntentOS verification asked for a human/);
    expect(blocked.pr.decision.reasons.join(" | ")).toMatch(/pricing\.py changes executable code/);
    expect(blocked.blocked_by.join(" | ")).toMatch(/Needs 1 distinct human approvals/);
    expect(blocked.pr.ci.outcome).toBe("pass");
    expect(gitHead(env.repo)).toBe(before);

    const merged = mergeRun(env.store, runX.rs.runId, { approve: ["sam"], by: "priya" });
    expect(merged.merged, merged.blocked_by.join(" | ")).toBe(true);
    expect(merged.pr.approvals.map((a) => a.user)).toEqual(["sam"]);
    expect(merged.merged_verification?.status).toBe("needs_review"); // same review finding as the run itself (no acceptance tests)
    expect(merged.merged_verification?.blocking).toEqual([]);
    expect(merged.pr.merge_check?.outcome).toBe("pass"); // mergeguard ran the project suite on the merged tree
    expect(gitHead(env.repo)).toBe(merged.merge_commit);
    expect(git(env.repo, ["status", "--porcelain"])).toBe("");
    expect(fs.readFileSync(path.join(env.repo, "app/services/pricing.py"), "utf8")).toContain("KNOWN_DISCOUNT_CODES");
    expect(loadIndexedRepo(env.store, env.repo).revision).toBe(merged.merge_commit);
    expect(readLedger(coord()).map((e) => e.type)).toEqual(["merged"]);
    expect(fs.existsSync(path.join(env.repo, ".mergeguard-prs.json"))).toBe(false);
    expect(fs.existsSync(path.join(env.home, "coordination", repoIdFor(env.repo), "prs.json"))).toBe(true);
    expect(JSON.parse(runX.rs.row.result_json!).merge).toMatchObject({ merged: true, pr: merged.pr.number });
    mainAfterX = gitHead(env.repo);
  });

  it("a change of meaning behind unchanged names is caught by the merged-result verification, and by mergeguard's merged-tree tests, before main moves", { timeout: LONG }, () => {
    // Run A (enterprise promotion) was verified green at the old base; X changed nothing A imports, so the sync check is silent.
    const sync = syncCheck(coord(), runA.rs.row.worktree_path!);
    expect(sync.clean).toBe(true);
    const a = mergeRun(env.store, runA.rs.runId, { approve: ["sam"] });
    expect(a.merged).toBe(false);
    expect(a.pr.gate.allowed).toBe(true); // branch CI green, sync clean, approval present: GitHub would merge this
    expect(a.merged_verification?.status).toBe("failed");
    expect(a.merged_verification?.blocking.join("\n")).toMatch(/15_percent_promotion|enterprise/);
    expect(a.blocked_by.join("\n")).toMatch(/merged result/);
    expect(gitHead(env.repo)).toBe(mainAfterX);

    // Without the hidden-test verification, mergeguard's own merged-tree run of the project suite still refuses.
    const a2 = mergeRun(env.store, runA.rs.runId, { approve: ["sam"], skipMergedVerification: true });
    expect(a2.merged).toBe(false);
    expect(a2.pr.merge_check?.outcome).toBe("fail");
    expect(a2.blocked_by.join("\n")).toMatch(/merged result failed/);
    expect(gitHead(env.repo)).toBe(mainAfterX);
  });

  it("when main breaks anyway, the guardian names the culprit merge and its partner and opens a validated undo PR that merges through the same gate", { timeout: LONG }, () => {
    // Land A with both merged-tree checks bypassed (evaluation only): main is now red on A's own test.
    process.env.INTENTOS_COORDINATION_MERGE_CHECK = "0";
    let landed;
    try {
      landed = mergeRun(env.store, runA.rs.runId, { approve: ["sam"], skipMergedVerification: true });
    } finally {
      delete process.env.INTENTOS_COORDINATION_MERGE_CHECK;
    }
    expect(landed.merged, landed.blocked_by.join(" | ")).toBe(true);
    expect(pytest(env.repo, "tests/test_enterprise_promotion.py").status).not.toBe(0);

    const guard = guardRepo(env.store, env.repo);
    expect(guard.guardian.status).toBe("clash");
    expect(guard.guardian.pr).toBe(landed.pr.number);
    expect(guard.guardian.partner_pr).toBe(prOf(runX));
    expect(guard.guardian.message).toMatch(/Undo PR #\d+ opened/);
    expect(guard.undo_pr).not.toBeNull();
    const undo = listRepoPrs(env.repo).find((p) => p.number === guard.undo_pr)!;
    expect(undo.reverts).toBe(landed.merge_commit);
    expect(undo.ci.outcome).toBe("pass");
    expect(undo.decision.tier).toBe(2); // the undo deletes A's test file: an existing test deleted needs two humans

    const restored = mergeNumberedPr(env.store, env.repo, guard.undo_pr!, { approve: ["sam", "lee"] });
    expect(restored.merged, restored.blocked_by.join(" | ")).toBe(true);
    expect(restored.pr.merge_check?.outcome).toBe("pass");
    const green = pytest(env.repo, "tests");
    expect(green.status, green.stdout.slice(-400)).toBe(0);
    expect(readLedger(coord()).map((e) => e.type)).toContain("reverted");
    expect(loadIndexedRepo(env.store, env.repo).revision).toBe(gitHead(env.repo));
  });

  it("a public rename needs two humans; a stale run is told the exact symbol, blocked at the gate, and merges once main is brought in", { timeout: LONG }, () => {
    const blocked = mergeRun(env.store, runR.rs.runId, { approve: ["sam"], by: "priya" });
    expect(blocked.merged).toBe(false);
    expect(blocked.pr.decision.tier).toBe(2); // a renamed public class is an API break: two humans, whatever IntentOS asked for
    expect(blocked.pr.decision.reasons.join(" | ")).toMatch(/Public API changed: app\.services\.audit\.AuditLog renamed/);
    expect(blocked.blocked_by.join(" | ")).toMatch(/Needs 2 distinct human approvals.*has 1/);
    const r = mergeRun(env.store, runR.rs.runId, { approve: ["lee"], by: "priya" });
    expect(r.merged, r.blocked_by.join(" | ")).toBe(true);
    expect(r.pr.approvals.map((a) => a.user).sort()).toEqual(["lee", "sam"]);
    expect(fs.readFileSync(path.join(env.repo, "app/services/audit.py"), "utf8")).toContain("class EventLog");

    const worktree = runB.rs.row.worktree_path!;
    const sync = syncCheck(coord(), worktree);
    expect(sync.clean).toBe(false);
    expect(sync.issues).toHaveLength(1);
    expect(sync.issues[0]!.message).toMatch(/`app\.services\.audit\.AuditLog` was renamed to `app\.services\.audit\.EventLog`/);
    expect(sync.issues[0]!.message).toMatch(/tests\/test_audit_log_events\.py:\d+/);
    expect(sync.issues[0]!.message).toContain("git merge main");

    const again = reverify(runB.rs);
    expect(again.status).toBe("failed");
    expect(again.findings.filter((f) => f.rule_id === "SYNC-STALE").map((f) => f.severity)).toEqual(["blocking"]);
    expect(again.tracks.coordination?.status).toBe("failed");

    const stale = mergeRun(env.store, runB.rs.runId, { approve: ["sam"] });
    expect(stale.merged).toBe(false);
    expect(stale.blocked_by.join(" | ")).toMatch(/AuditLog.*renamed/);

    // The PR waits; its author brings main in and follows the note.
    git(worktree, ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-edit", "main"]);
    edit(worktree, "tests/test_audit_log_events.py", (t) => t.replace(/\bAuditLog\b/g, "EventLog"));
    const merged = mergeRun(env.store, runB.rs.runId, { approve: ["sam"] });
    expect(merged.merged, merged.blocked_by.join(" | ")).toBe(true);
    expect(merged.pr.sync.clean).toBe(true);
    expect(gitHead(env.repo)).toBe(merged.merge_commit);
  });

  it("the live sync path: a worktree fast-forwarded to main advances the run base instead of failing integrity", { timeout: LONG }, async () => {
    const patchC = makePatch("money-zero", smallTest("test_money_zero", "from app.domain.money import Money\n\n\ndef test_zero_is_zero():\n    assert Money.zero().is_zero()\n"));
    const runC = await runOffline("Add a test for Money.zero", patchC, null);
    expect(runC.outcome.state).toBe("HUMAN_REVIEW");
    const patchD = makePatch("money-str", smallTest("test_money_str", 'from app.domain.money import Money\n\n\ndef test_str_has_currency():\n    assert str(Money.of("1.50")) == "1.50 USD"\n'));
    const runD = await runOffline("Add a test for Money.__str__", patchD, null);
    const d = mergeRun(env.store, runD.rs.runId, { approve: ["sam"] });
    expect(d.merged, d.blocked_by.join(" | ")).toBe(true);
    expect(d.pr.decision.proofs["tests/test_money_str.py"]).toMatch(/new module|additive/);

    // What the hook tells the agent to do, done by hand here: uncommitted work rides along the fast-forward.
    const worktree = runC.rs.row.worktree_path!;
    const oldBase = runC.rs.row.base_sha;
    git(worktree, ["stash", "push", "-u", "-q"]);
    git(worktree, ["merge", "--ff-only", "main"]);
    git(worktree, ["stash", "pop", "-q"]);
    expect(gitHead(worktree)).toBe(gitHead(env.repo));
    expect(advanceBase(runC.rs, coord(), worktree, env.repo)).toBe(gitHead(env.repo));
    expect(runC.rs.row.base_sha).toBe(gitHead(env.repo));
    expect(env.store.events(runC.rs.runId).map((e) => e.event_type)).toContain("base.advanced");
    const v = reverify(runC.rs);
    expect(v.findings.find((f) => f.rule_id === "WORKTREE-HEAD")).toBeUndefined();
    expect(v.coordination?.stale).toBe(false);
    expect(v.changed_files.map((f) => f.path)).toEqual(["tests/test_money_zero.py"]);
    expect(oldBase).not.toBe(runC.rs.row.base_sha);
    const c = mergeRun(env.store, runC.rs.runId, { approve: ["sam"] });
    expect(c.merged, c.blocked_by.join(" | ")).toBe(true);
  });
});
