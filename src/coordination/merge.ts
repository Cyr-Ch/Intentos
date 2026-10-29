/**
 * `intentos merge`: a verified run becomes a branch, a mergeguard PR, a review tier, approvals, a merged-result
 * verification, and a fast-forward of the repository's main. `intentos guard`: when main is red anyway, the guardian
 * names the culprit and its partner and opens a validated undo PR; the breaker raises review floors per folder.
 *
 * Nothing here trusts the run's own verification alone: the PR's branch is tested again by mergeguard (its CI), and the
 * merged result (branch combined with the main of right now) is verified with the hidden tests before main moves.
 * That last check is the one neither a branch-only CI nor a symbol-level sync check can do: a change of meaning behind
 * an unchanged name (dollars become cents) is caught here, not on main.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { KnowledgeStore } from "../knowledge/storage.ts";
import { fallbackPolicy, fillArgv, policyForRepo, projectTestCommand, type Policy } from "../knowledge/policy.ts";
import { linkNodeModules } from "../knowledge/js.ts";
import { indexRepository } from "../knowledge/indexer.ts";
import type { EvidencePack } from "../knowledge/retrieval.ts";
import type { ChangeContract } from "../contracts/schemas.ts";
import { RunStore } from "../orchestrator/store.ts";
import { loadTask as loadTaskRecord } from "../orchestrator/runner.ts";
import { resolveHiddenTests } from "../orchestrator/tasks.ts";
import { verifyWorktree } from "../verification/runner.ts";
import type { VerificationResult } from "../verification/results.ts";
import { repoInterpreter } from "../knowledge/venv.ts";
import { addWorktree, currentBranch, git, headSha, removeWorktree } from "../util/git.ts";
import { ensureDir } from "../util/paths.ts";
import { nowIso } from "../util/ids.ts";
import { generateReport } from "../reports/generate.ts";
import { approvePr, breakerStatus, checkPr, coordinationEnv, coordinationStatus, guardian, listPrs, mergePr, openPr, readLedger, showPr, type BreakerStatus, type CoordinationEnv, type GuardianResult, type MergeguardPr } from "./mergeguard.ts";

export interface MergeOptions {
  /** Human approvals to record on the PR's current head (names; bots and the author never count). */
  approve?: string[];
  /** Who asked for the merge; recorded as the PR's prompter (never a reviewer). */
  by?: string | null;
  /** Skip the hidden-test verification of the merged result (not recommended; recorded in the outcome). */
  skipMergedVerification?: boolean;
  log?: (line: string) => void;
}

export interface MergeOutcome {
  run_id: string | null;
  repo: string;
  main_branch: string;
  branch: string;
  pr: MergeguardPr;
  merged: boolean;
  merge_commit: string | null;
  /** Why the merge did not happen (gate reasons, merged-result findings), empty when merged. */
  blocked_by: string[];
  merged_verification: { status: VerificationResult["status"]; attempt: number; dir: string; blocking: string[]; review: string[] } | null;
  reindexed: boolean;
}

function requireCoordination(repoPath: string, policy: Policy): CoordinationEnv {
  const status = coordinationStatus();
  if (!status.ok) throw new Error(`coordination is unavailable: ${status.reason}`);
  return coordinationEnv(repoPath, policy);
}

function repoRow(store: KnowledgeStore, repoId: string) {
  const repo = store.getRepository(repoId);
  if (!repo) throw new Error(`repository ${repoId} is not indexed`);
  return repo;
}

/** The project test command from the trusted policy as a mergeguard merge check (`{checkout}` is the merged tree). */
export function mergeCheckCommand(policy: Policy, repoPath: string): string | null {
  // Evaluation-only switch: lets a test land a change that the merged-tree run would refuse, to exercise the guardian.
  if (process.env.INTENTOS_COORDINATION_MERGE_CHECK === "0") return null;
  const cmd = projectTestCommand(policy)?.cmd;
  if (!cmd?.argv) return null;
  const python = repoInterpreter(repoPath);
  const junit = path.join(os.tmpdir(), `intentos-merge-check-${process.pid}.xml`);
  const argv = fillArgv(cmd.argv, { python, snapshot: "{checkout}", hidden_tests_dir: "{hidden_tests_dir}", junit, node_modules: path.join(repoPath, "node_modules") }).filter((a) => !a.includes("{hidden_tests_dir}"));
  return argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

function titleFor(task: string, runId: string): string {
  const first = task.trim().split("\n")[0]!.trim();
  return (first.length > 72 ? `${first.slice(0, 69)}...` : first) || `IntentOS run ${runId}`;
}

/**
 * Verify the PR head merged onto the main of right now, with the run's contract, hidden tests and invariants.
 * The diff under review is main..merged, so scope and tests-weakened checks see exactly what main would receive.
 */
export function verifyMergedResult(store: KnowledgeStore, rs: RunStore, coord: CoordinationEnv, repoPath: string, policy: Policy, head: string): { result: VerificationResult; dir: string; attempt: number; merged: string } {
  const row = rs.row;
  const contract = JSON.parse(row.contract_json!) as ChangeContract;
  const pack = rs.readJson<EvidencePack>("evidence");
  if (!pack) throw new Error("evidence pack missing from the run directory");
  const task = loadTaskRecord(rs);
  const hidden = resolveHiddenTests(policy.policy_id, task.task, task.benchmark_task_id);
  const outDir = ensureDir(path.join(rs.runDir, "merged_verification"));
  const attempt = fs.readdirSync(outDir).filter((d) => d.startsWith("attempt-")).length + 1;
  const main = git(repoPath, ["rev-parse", coord.mainBranch]).stdout.trim();
  const candidate = path.join(path.dirname(row.worktree_path!), `${rs.runId}-merged`);
  removeWorktree(repoPath, candidate);
  fs.rmSync(candidate, { recursive: true, force: true });
  addWorktree(repoPath, candidate, main);
  if (policy.language === "typescript") linkNodeModules(repoPath, candidate);
  try {
    const merge = git(candidate, ["-c", "user.name=intentos", "-c", "user.email=intentos@localhost", "merge", "--no-ff", "-m", `candidate: ${rs.runId} onto ${coord.mainBranch}`, head], { allowFail: true });
    if (merge.status !== 0) {
      throw new Error(`the branch does not merge cleanly onto ${coord.mainBranch}: ${merge.stderr.trim().split("\n").slice(-2).join(" ")}`);
    }
    const merged = headSha(candidate);
    const result = verifyWorktree({ runId: rs.runId, attempt, worktree: candidate, baseSha: main, expectedHead: merged, contract, contractHash: row.contract_hash!, policy, pack, outDir, hiddenTaskTestsDir: hidden.taskDir, hiddenInvariantTestsDir: hidden.invariantsDir, eventsFile: null, repoPath, simulated: task.mode === "offline", coordination: null });
    fs.writeFileSync(path.join(outDir, `attempt-${attempt}`, "verification.json"), JSON.stringify({ ...result, merged_candidate: merged, main, head }, null, 2));
    return { result, dir: path.join(outDir, `attempt-${attempt}`), attempt, merged };
  } finally {
    removeWorktree(repoPath, candidate);
    fs.rmSync(candidate, { recursive: true, force: true });
  }
}

/** Turn a run's worktree into a branch (one commit of its uncommitted work) and open or refresh its PR. */
function branchAndPr(rs: RunStore, coord: CoordinationEnv, worktree: string, opts: MergeOptions): { branch: string; pr: MergeguardPr; head: string } {
  const branch = `intentos/${rs.runId}`;
  const task = loadTaskRecord(rs);
  const title = titleFor(task.task, rs.runId);
  const onBranch = currentBranch(worktree);
  if (onBranch !== branch) {
    if (onBranch) throw new Error(`worktree is on branch ${onBranch}, expected a detached HEAD at the run base`);
    if (headSha(worktree) !== rs.row.base_sha) throw new Error(`worktree HEAD ${headSha(worktree).slice(0, 10)} is not the run base ${rs.row.base_sha.slice(0, 10)}; verify the run again before merging`);
    const exists = git(worktree, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true }).status === 0;
    git(worktree, exists ? ["checkout", "-q", branch] : ["checkout", "-q", "-b", branch]);
  }
  git(worktree, ["add", "-A"]);
  const staged = git(worktree, ["diff", "--cached", "--quiet"], { allowFail: true }).status !== 0;
  if (staged) {
    git(worktree, ["-c", "user.name=intentos", "-c", "user.email=intentos@localhost", "commit", "-q", "-m", `${title}\n\nIntentOS run ${rs.runId}; verified against base ${rs.row.base_sha.slice(0, 10)}.`]);
    rs.event("merge.committed", { branch, head: headSha(worktree) });
  } else if (headSha(worktree) === rs.row.base_sha) {
    throw new Error("the worktree has no changes to merge");
  }
  const head = headSha(worktree);
  const humanReview = rs.state === "HUMAN_REVIEW";
  const verification = rs.readJson<VerificationResult>("verification");
  const reviewIds = verification?.findings.filter((f) => f.severity === "review").map((f) => f.id) ?? [];
  const pr = openPr(coord, worktree, branch, title, { author: "intentos", prompter: opts.by ?? null, minTier: humanReview ? 1 : 0, minTierReason: humanReview ? `IntentOS verification asked for a human: ${reviewIds.slice(0, 6).join(", ")}` : undefined });
  return { branch, pr, head };
}

/** Merge a finished run: REVIEW_READY or HUMAN_REVIEW, worktree present, verification on the current base. */
export function mergeRun(store: KnowledgeStore, runId: string, opts: MergeOptions = {}): MergeOutcome {
  const log = opts.log ?? (() => {});
  const row = store.getRun(runId);
  if (!row) throw new Error(`run ${runId} not found`);
  const rs = new RunStore(store, runId, row.run_dir);
  if (rs.state !== "REVIEW_READY" && rs.state !== "HUMAN_REVIEW") throw new Error(`run ${runId} is ${rs.state}; only REVIEW_READY or HUMAN_REVIEW runs can be merged`);
  if (!row.worktree_path || !fs.existsSync(row.worktree_path)) throw new Error(`run ${runId} has no worktree`);
  if (!row.contract_json || !row.contract_hash) throw new Error(`run ${runId} has no validated contract`);
  const verification = rs.readJson<VerificationResult>("verification");
  if (!verification) throw new Error(`run ${runId} was never verified`);
  if (verification.base_sha !== row.base_sha) throw new Error(`the last verification ran against ${verification.base_sha.slice(0, 10)} but the run base is ${row.base_sha.slice(0, 10)}; run intentos verify ${runId} first`);
  const repo = repoRow(store, row.repo_id);
  const policy = policyForRepo(repo.path) ?? fallbackPolicy(repo.path);
  const coord = requireCoordination(repo.path, policy);
  const worktree = row.worktree_path;

  const { branch, pr: opened, head } = branchAndPr(rs, coord, worktree, opts);
  log(`PR #${opened.number} ${branch} (${head.slice(0, 10)}): tier ${opened.decision.tier}, ${opened.decision.reasons.join("; ")}`);
  if (rs.state === "REVIEW_READY" && opened.decision.tier > 0) {
    rs.transition("HUMAN_REVIEW", { tier: opened.decision.tier, reasons: opened.decision.reasons, reason: "the PR gate requires human approval" });
  }
  rs.event("merge.pr_opened", { pr: opened.number, branch, head, tier: opened.decision.tier, reasons: opened.decision.reasons, proofs: opened.decision.proofs, ci: opened.ci?.outcome ?? null });
  let pr = opened;
  for (const user of opts.approve ?? []) {
    pr = approvePr(coord, worktree, pr.number, user);
    log(`approval by ${user} on ${pr.head.slice(0, 10)}`);
  }
  pr = checkPr(coord, worktree, pr.number);
  const outcome: MergeOutcome = { run_id: runId, repo: repo.path, main_branch: coord.mainBranch, branch, pr, merged: false, merge_commit: null, blocked_by: [], merged_verification: null, reindexed: false };
  if (!pr.gate.allowed) {
    outcome.blocked_by = pr.gate.reasons;
    rs.event("merge.blocked", { pr: pr.number, reasons: pr.gate.reasons });
    recordMergeOutcome(rs, outcome);
    return outcome;
  }

  if (!opts.skipMergedVerification) {
    log(`verifying the merged result on ${coord.mainBranch}…`);
    const mv = verifyMergedResult(store, rs, coord, repo.path, policy, head);
    const blocking = mv.result.findings.filter((f) => f.severity === "blocking");
    const review = mv.result.findings.filter((f) => f.severity === "review");
    outcome.merged_verification = { status: mv.result.status, attempt: mv.attempt, dir: mv.dir, blocking: blocking.map((f) => `${f.id} ${f.message}`), review: review.map((f) => `${f.id} ${f.message}`) };
    rs.event("merge.merged_result_verified", { pr: pr.number, candidate: mv.merged, status: mv.result.status, blocking: blocking.map((f) => f.id), review: review.map((f) => f.id) });
    if (mv.result.status === "failed") {
      outcome.blocked_by = blocking.map((f) => `merged result: ${f.message}`);
      rs.event("merge.blocked", { pr: pr.number, reasons: outcome.blocked_by });
      recordMergeOutcome(rs, outcome);
      return outcome;
    }
  } else {
    rs.event("warning", { message: "merged-result verification skipped on request" });
  }

  try {
    pr = mergePr(coord, worktree, pr.number, mergeCheckCommand(policy, repo.path) ?? undefined);
  } catch (err) {
    outcome.pr = showPr(coord, worktree, pr.number);
    outcome.blocked_by = [(err as Error).message.replace(/^mergeguard pr merge: /, "")];
    rs.event("merge.blocked", { pr: pr.number, reasons: outcome.blocked_by });
    recordMergeOutcome(rs, outcome);
    return outcome;
  }
  outcome.pr = pr;
  outcome.merged = true;
  outcome.merge_commit = pr.merge_commit ?? null;
  log(`merged PR #${pr.number} into ${coord.mainBranch} as ${pr.merge_commit?.slice(0, 10)}`);
  try {
    indexRepository(store, repo.path);
    outcome.reindexed = true;
  } catch (err) {
    rs.event("warning", { message: `re-index after merge failed: ${(err as Error).message}` });
  }
  rs.event("merge.completed", { pr: pr.number, merge_commit: pr.merge_commit, tier: pr.decision.tier, approvals: pr.approvals.map((a) => a.user), reindexed: outcome.reindexed });
  recordMergeOutcome(rs, outcome);
  return outcome;
}

function recordMergeOutcome(rs: RunStore, outcome: MergeOutcome): void {
  const existing = rs.row.result_json ? (JSON.parse(rs.row.result_json) as Record<string, unknown>) : {};
  rs.update({ result_json: JSON.stringify({ ...existing, final_state: rs.state, merge: { pr: outcome.pr.number, branch: outcome.branch, tier: outcome.pr.decision.tier, merged: outcome.merged, merge_commit: outcome.merge_commit, blocked_by: outcome.blocked_by, merged_verification: outcome.merged_verification?.status ?? null, at: nowIso() } }) });
  rs.writeJson("merge.json", outcome);
  try {
    generateReport(rs.store, rs.runId);
  } catch {
    /* report regeneration is best effort */
  }
}

/** Merge a mergeguard PR that is not a run (an undo PR the guardian opened): gate, project tests on the merged result, main. */
export function mergeNumberedPr(store: KnowledgeStore, repoPath: string, number: number, opts: MergeOptions = {}): MergeOutcome {
  const log = opts.log ?? (() => {});
  const policy = policyForRepo(repoPath) ?? fallbackPolicy(repoPath);
  const coord = requireCoordination(repoPath, policy);
  let pr = showPr(coord, repoPath, number);
  for (const user of opts.approve ?? []) pr = approvePr(coord, repoPath, number, user);
  pr = checkPr(coord, repoPath, number);
  const outcome: MergeOutcome = { run_id: null, repo: repoPath, main_branch: coord.mainBranch, branch: pr.branch, pr, merged: false, merge_commit: null, blocked_by: [], merged_verification: null, reindexed: false };
  if (!pr.gate.allowed) {
    outcome.blocked_by = pr.gate.reasons;
    return outcome;
  }
  try {
    pr = mergePr(coord, repoPath, number, mergeCheckCommand(policy, repoPath) ?? undefined);
  } catch (err) {
    outcome.pr = showPr(coord, repoPath, number);
    outcome.blocked_by = [(err as Error).message.replace(/^mergeguard pr merge: /, "")];
    return outcome;
  }
  outcome.pr = pr;
  outcome.merged = true;
  outcome.merge_commit = pr.merge_commit ?? null;
  log(`merged PR #${number} into ${coord.mainBranch} as ${pr.merge_commit?.slice(0, 10)}`);
  try {
    indexRepository(store, repoPath);
    outcome.reindexed = true;
  } catch {
    outcome.reindexed = false;
  }
  return outcome;
}

export interface GuardOutcome {
  repo: string;
  main_branch: string;
  main: string;
  good: string;
  guardian: GuardianResult;
  breaker: BreakerStatus;
  undo_pr: number | null;
}

/**
 * Investigate a red main: reruns to rule out flaky tests, first-parent bisect over the merges, culprit-alone check,
 * partner search, validated undo PR. `good` defaults to the parent of the first merge recorded in the ledger.
 */
export function guardRepo(store: KnowledgeStore, repoPath: string, opts: { good?: string | null; undo?: boolean; log?: (line: string) => void } = {}): GuardOutcome {
  const log = opts.log ?? (() => {});
  const policy = policyForRepo(repoPath) ?? fallbackPolicy(repoPath);
  const coord = requireCoordination(repoPath, policy);
  const main = git(repoPath, ["rev-parse", coord.mainBranch]).stdout.trim();
  let good = opts.good ?? null;
  if (!good) {
    const merges = readLedger(coord).filter((e) => e.type === "merged" && e.commit);
    if (!merges.length) throw new Error(`nothing has been merged through intentos on ${coord.mainBranch} yet; pass --good <sha> to name a known-good commit`);
    good = git(repoPath, ["rev-parse", `${merges[0]!.commit}^1`]).stdout.trim();
  }
  log(`guardian: ${coord.mainBranch} ${main.slice(0, 10)}, last known good ${good.slice(0, 10)}`);
  const result = guardian(coord, repoPath, good, main, { undo: opts.undo !== false });
  const breaker = breakerStatus(coord, repoPath);
  if (result.message) log(result.message);
  const undoPr = typeof result.undo_pr === "number" ? result.undo_pr : null;
  if (undoPr !== null) {
    try {
      indexRepository(store, repoPath);
    } catch {
      /* the undo PR is on a branch; the index of main is unchanged */
    }
  }
  return { repo: repoPath, main_branch: coord.mainBranch, main, good, guardian: result, breaker, undo_pr: undoPr };
}

export function listRepoPrs(repoPath: string): MergeguardPr[] {
  const policy = policyForRepo(repoPath) ?? fallbackPolicy(repoPath);
  const coord = requireCoordination(repoPath, policy);
  return listPrs(coord, repoPath);
}
