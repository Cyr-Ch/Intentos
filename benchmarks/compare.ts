/**
 * Codex alone versus Codex under IntentOS on fresh tickets, one run per ticket per arm, then the merges.
 *
 *   node --disable-warning=ExperimentalWarning benchmarks/compare.ts --repo ~/repos/demandlib --tickets benchmarks/demandlib/tickets.yaml
 *       [--arms full,baseline] [--only T01,T02] [--out <dir>] [--phase run|merge|all] [--resume <dir>]
 *
 * Each arm gets its own clone of the repository (same base revision), indexed, with the original's onboarded venv and
 * precedents. Phase `run`: every ticket is run from that base with the arm's engine: `full` is the IntentOS pipeline
 * (evidence pack, planner, compiled contract, implementer, verifier with the hidden acceptance tests and invariants,
 * bounded repairs); `baseline` is the same worktree, verifier and repair budget with an implementer that receives only
 * the ticket text. Phase `merge`: the runs are merged into the arm's main in ticket order. The IntentOS arm goes through
 * `intentos merge` (review tier, approvals, branch CI, sync check, merged-result verification with the hidden tests,
 * mergeguard's merged-tree test run). The baseline arm does what a team with CI alone does: merge when the branch's own
 * project tests are green. After every merge, main is tested with the project suite, the invariants and the acceptance
 * tests of everything merged so far, so a broken main is recorded the moment it happens.
 *
 * Every number comes from run artifacts (verification.json, attempt-1/verification.json, metrics.json, merge.json) and
 * from test runs on main. Failed runs are rows, not gaps. Nothing is estimated.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureHome, resolvePaths, PROJECT_ROOT } from "../src/config.ts";
import { KnowledgeStore } from "../src/knowledge/storage.ts";
import { indexRepository, repoIdFor } from "../src/knowledge/indexer.ts";
import { loadIndexedRepo } from "../src/knowledge/repo.ts";
import { fallbackPolicy, policyForRepo, type Policy } from "../src/knowledge/policy.ts";
import { repoInterpreter, repoVenvDir } from "../src/knowledge/venv.ts";
import { precedentsFile } from "../src/knowledge/precedents.ts";
import { buildEvidencePack, type EvidencePack } from "../src/knowledge/retrieval.ts";
import { createRun, executeRun, type RunOptions } from "../src/orchestrator/runner.ts";
import { RunStore } from "../src/orchestrator/store.ts";
import { loadBenchmarkTasks, resolveHiddenTests } from "../src/orchestrator/tasks.ts";
import type { VerificationResult } from "../src/verification/results.ts";
import { parseJunit } from "../src/verification/junit.ts";
import { LiveCodexEngine, type CodingEngine } from "../src/codex/adapter.ts";
import { buildOfflineContract } from "../src/codex/offline.ts";
import { loadTicketFile } from "../src/acceptance.ts";
import { mergeRun, type MergeOutcome } from "../src/coordination/merge.ts";
import { coordinationStatus } from "../src/coordination/mergeguard.ts";
import { git, headSha } from "../src/util/git.ts";
import { nowIso } from "../src/util/ids.ts";

type Arm = "full" | "baseline";

interface Args {
  repo: string | null;
  tickets: string;
  arms: Arm[];
  only: Set<string> | null;
  out: string | null;
  phase: "run" | "merge" | "all";
  resume: string | null;
  approvers: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = { repo: null, tickets: path.join(PROJECT_ROOT, "benchmarks", "demandlib", "tickets.yaml"), arms: ["full", "baseline"], only: null, out: null, phase: "all", resume: null, approvers: ["reviewer-a", "reviewer-b"] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === "--repo") a.repo = argv[++i] ?? null;
    else if (v === "--tickets") a.tickets = argv[++i] ?? a.tickets;
    else if (v === "--arms") a.arms = (argv[++i] ?? "").split(",").filter((x): x is Arm => x === "full" || x === "baseline");
    else if (v === "--only") a.only = new Set((argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    else if (v === "--out") a.out = argv[++i] ?? null;
    else if (v === "--phase") a.phase = (argv[++i] as Args["phase"]) ?? "all";
    else if (v === "--resume") a.resume = argv[++i] ?? null;
    else if (v === "--approvers") a.approvers = (argv[++i] ?? "").split(",").filter(Boolean);
  }
  if (!a.repo) throw new Error("--repo <path> is required");
  return a;
}

/** Vanilla Codex: no planner, no evidence; the policy-derived contract keeps the verifier and repair budget identical. */
class BaselineEngine implements CodingEngine {
  readonly name = "codex-sdk-baseline(task-only prompt, no planner)";
  readonly simulated = false;
  private readonly live = new LiveCodexEngine();
  private readonly task: string;
  private readonly pack: EvidencePack;
  constructor(task: string, pack: EvidencePack) {
    this.task = task;
    this.pack = pack;
  }
  plan: CodingEngine["plan"] = async () => ({ text: JSON.stringify(buildOfflineContract(this.pack, { route: "implement", fabricateEvidence: false, taskId: "baseline" })), usage: null, threadId: null, simulated: false, engine: this.name, model: null, items: [] });
  implement: CodingEngine["implement"] = (req) => this.live.implement({ ...req, prompt: req.threadId ? req.prompt : `${this.task}\n\nRun the test suite with python -m pytest -q before finishing.` });
}

export interface RunRow {
  ticket: string;
  arm: Arm;
  run_id: string | null;
  final_state: string;
  expected_route: string;
  route: string;
  route_correct: boolean;
  /** Hidden acceptance tests at the end of the run (after repairs), and at the first attempt. */
  acceptance_final: boolean | null;
  acceptance_first: boolean | null;
  /** Blocking invariant / architecture / scope findings at the first attempt: what would have shipped without IntentOS. */
  first_attempt_blocking: { invariant: number; architecture: number; scope: number; functional: number; total: number } | null;
  blocking_final: number | null;
  review_findings_final: number | null;
  protected_paths_touched: number | null;
  changed_files: number | null;
  repair_rounds: number;
  wall_ms: number;
  tokens: unknown;
  error: string | null;
}

export interface MergeRow {
  ticket: string;
  arm: Arm;
  run_id: string | null;
  attempted: boolean;
  merged: boolean;
  how: string;
  tier: number | null;
  approvals_needed: number | null;
  blocked_by: string[];
  merged_verification: string | null;
  main_after: { green: boolean; project: string; invariants: string; acceptance: string; failed: string[] } | null;
}

interface State {
  started_at: string;
  repo: string;
  base: string;
  model: string | null;
  arms: Record<string, { clone: string; repo_id: string }>;
  runs: RunRow[];
  merges: MergeRow[];
}

function sh(cwd: string, cmd: string, args: string[]): { status: number; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

function pythonpathArgs(policy: Policy, repo: string): string[] {
  const argv = policy.commands.pytest_project?.argv ?? [];
  let pp = ".";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("pythonpath=")) pp = a.slice("pythonpath=".length);
    if (a === "-o" && argv[i + 1]?.startsWith("pythonpath=")) pp = argv[i + 1]!.slice("pythonpath=".length);
  }
  return ["-o", `pythonpath=${pp.split(/\s+/).filter(Boolean).map((p) => path.resolve(repo, p)).join(" ")}`];
}

/** Run a pytest target set in the clone and summarise. */
function pytestOn(repo: string, policy: Policy, targets: string[], label: string, outDir: string): { status: string; failed: string[]; passed: number } {
  if (!targets.length) return { status: "none", failed: [], passed: 0 };
  const python = repoInterpreter(repo);
  const junit = path.join(outDir, `${label}.junit.xml`);
  const r = spawnSync(python, ["-m", "pytest", ...targets, "-q", "-p", "no:cacheprovider", "--continue-on-collection-errors", ...pythonpathArgs(policy, repo), `--junit-xml=${junit}`], { cwd: repo, encoding: "utf8", timeout: 900_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  fs.writeFileSync(path.join(outDir, `${label}.log`), `${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  const cases = fs.existsSync(junit) ? parseJunit(fs.readFileSync(junit, "utf8")) : [];
  const failed = cases.filter((c) => c.status === "failed" || c.status === "error").map((c) => `${c.classname}::${c.name}`);
  const passed = cases.filter((c) => c.status === "passed").length;
  return { status: r.status === 0 && cases.length > 0 ? "pass" : cases.length ? "fail" : "error", failed, passed };
}

/** The project suite from the policy, run in the clone's main checkout. */
function projectSuite(repo: string, policy: Policy, label: string, outDir: string): { status: string; failed: string[] } {
  const cmd = policy.commands.pytest_project;
  if (!cmd?.argv) return { status: "none", failed: [] };
  const python = repoInterpreter(repo);
  const junit = path.join(outDir, `${label}.project.junit.xml`);
  const argv = cmd.argv.map((a) => a.replace("{python}", python).replace("{snapshot}", repo).replace("{junit}", junit)).filter((a) => !a.includes("{hidden_tests_dir}"));
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd: repo, encoding: "utf8", timeout: 900_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  fs.writeFileSync(path.join(outDir, `${label}.project.log`), `${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  const cases = fs.existsSync(junit) ? parseJunit(fs.readFileSync(junit, "utf8")) : [];
  return { status: r.status === 0 ? "pass" : "fail", failed: cases.filter((c) => c.status === "failed" || c.status === "error").map((c) => `${c.classname}::${c.name}`) };
}

/** Is main healthy: project suite, invariants, and the acceptance tests of every ticket merged so far. */
function mainHealth(repo: string, policy: Policy, mergedTickets: string[], label: string, outDir: string): MergeRow["main_after"] {
  const project = projectSuite(repo, policy, label, outDir);
  const invDir = resolveHiddenTests(policy.policy_id, "", null).invariantsDir;
  const inv = pytestOn(repo, policy, invDir ? [invDir] : [], `${label}.invariants`, outDir);
  const accDirs = mergedTickets.map((t) => resolveHiddenTests(policy.policy_id, "", t).taskDir).filter((d): d is string => !!d);
  const acc = pytestOn(repo, policy, accDirs, `${label}.acceptance`, outDir);
  const failed = [...project.failed, ...inv.failed, ...acc.failed];
  return { green: project.status === "pass" && inv.status !== "fail" && acc.status !== "fail", project: project.status, invariants: inv.status, acceptance: acc.status, failed: failed.slice(0, 20) };
}

function prepareClone(args: Args, arm: Arm, outDir: string, store: KnowledgeStore, log: (s: string) => void): { clone: string; repoId: string } {
  const source = path.resolve(args.repo!);
  const clone = path.join(outDir, arm, path.basename(source));
  if (!fs.existsSync(clone)) {
    fs.mkdirSync(path.dirname(clone), { recursive: true });
    const r = sh(path.dirname(clone), "git", ["clone", "--quiet", source, clone]);
    if (r.status !== 0) throw new Error(`git clone failed: ${r.out}`);
    git(clone, ["config", "user.name", `intentos-benchmark-${arm}`]);
    git(clone, ["config", "user.email", `benchmark-${arm}@localhost`]);
  }
  const paths = resolvePaths();
  const sourceId = repoIdFor(source);
  const cloneId = repoIdFor(clone);
  // The clone borrows the original's onboarded venv and precedents (both keyed by repository id).
  const venv = repoVenvDir(source, paths);
  const cloneVenv = repoVenvDir(clone, paths);
  if (fs.existsSync(venv) && !fs.existsSync(cloneVenv)) fs.symlinkSync(venv, cloneVenv);
  const prec = precedentsFile(paths, sourceId);
  const clonePrec = precedentsFile(paths, cloneId);
  if (fs.existsSync(prec) && !fs.existsSync(clonePrec)) fs.copyFileSync(prec, clonePrec);
  indexRepository(store, clone);
  log(`${arm}: clone at ${clone} (${cloneId}), indexed at ${headSha(clone).slice(0, 10)}`);
  return { clone, repoId: cloneId };
}

function ticketText(t: { title: string; issue: string }): string {
  return `${t.title}\n\n${t.issue}`.trim();
}

async function runPhase(args: Args, state: State, store: KnowledgeStore, outDir: string, log: (s: string) => void): Promise<void> {
  const tickets = loadTicketFile(path.resolve(args.tickets)).filter((t) => !args.only || args.only.has(t.id));
  const bound = new Set(loadBenchmarkTasks().map((t) => t.id));
  for (const arm of args.arms) {
    const clone = state.arms[arm]!.clone;
    for (const t of tickets) {
      if (state.runs.some((r) => r.arm === arm && r.ticket === t.id && r.run_id)) continue;
      const indexed = loadIndexedRepo(store, clone);
      const text = ticketText(t);
      const opts: RunOptions = { mode: "live", taskId: bound.has(t.id) ? t.id : null, log: (l) => log(`  ${arm}/${t.id}: ${l}`) };
      if (arm === "baseline") opts.engine = new BaselineEngine(text, buildEvidencePack(store, indexed, text));
      log(`${arm}/${t.id}: ${t.title}`);
      const row: RunRow = { ticket: t.id, arm, run_id: null, final_state: "ERROR", expected_route: t.expected_route, route: "none", route_correct: false, acceptance_final: null, acceptance_first: null, first_attempt_blocking: null, blocking_final: null, review_findings_final: null, protected_paths_touched: null, changed_files: null, repair_rounds: 0, wall_ms: 0, tokens: "unknown", error: null };
      const t0 = Date.now();
      try {
        const rs = createRun(store, indexed, text, opts);
        row.run_id = rs.runId;
        const outcome = await executeRun(store, rs, opts);
        Object.assign(row, summarizeRun(rs, outcome.state, t.expected_route, arm));
      } catch (e) {
        row.error = (e as Error).message.slice(0, 500);
        row.wall_ms = Date.now() - t0;
        log(`  ${arm}/${t.id}: ERROR ${row.error}`);
      }
      state.runs = [...state.runs.filter((r) => !(r.arm === arm && r.ticket === t.id)), row];
      save(outDir, state);
      log(`  ${arm}/${t.id}: ${row.final_state}, acceptance ${fmt(row.acceptance_final)} (first attempt ${fmt(row.acceptance_first)}), ${row.repair_rounds} repair(s), ${Math.round(row.wall_ms / 1000)} s`);
    }
  }
}

function summarizeRun(rs: RunStore, state: string, expectedRoute: string, arm: Arm): Partial<RunRow> {
  const ver = rs.readJson<VerificationResult>("verification");
  const first = rs.readJson<VerificationResult>("verification/attempt-1/verification.json") ?? (ver?.attempt === 1 ? ver : null);
  const metrics = rs.readJson<{ repair_rounds: number; wall_time_ms: number; tokens: unknown }>("metrics");
  const route = state === "CLARIFICATION_REQUIRED" ? "clarify" : state === "ABSTAINED" ? "abstain" : "implement";
  const acc = (v: VerificationResult | null) => {
    const c = v?.commands.find((x) => x.command_id === "pytest_hidden_task");
    return c ? c.status === "passed" && (c.tests_passed ?? 0) > 0 : null;
  };
  const count = (v: VerificationResult | null, cat: string) => (v ? v.findings.filter((f) => f.severity === "blocking" && f.category === cat).length : 0);
  return {
    final_state: state,
    route,
    route_correct: arm === "baseline" && expectedRoute !== "implement" ? false : route === expectedRoute,
    acceptance_final: acc(ver),
    acceptance_first: acc(first),
    first_attempt_blocking: first ? { invariant: count(first, "business_invariant"), architecture: count(first, "architecture"), scope: count(first, "scope"), functional: count(first, "functional"), total: first.findings.filter((f) => f.severity === "blocking").length } : null,
    blocking_final: ver ? ver.findings.filter((f) => f.severity === "blocking").length : null,
    review_findings_final: ver ? ver.findings.filter((f) => f.severity === "review").length : null,
    protected_paths_touched: ver ? ver.changed_files.filter((f) => f.protected).length : null,
    changed_files: ver ? ver.changed_files.length : null,
    repair_rounds: metrics?.repair_rounds ?? 0,
    wall_ms: metrics?.wall_time_ms ?? 0,
    tokens: metrics?.tokens ?? "unknown",
  };
}

/** The baseline merge: a branch from the worktree, the project suite as CI, a plain merge when green. */
function plainMerge(clone: string, policy: Policy, rs: RunStore, ticket: string, outDir: string): Pick<MergeRow, "attempted" | "merged" | "how" | "blocked_by"> {
  const worktree = rs.row.worktree_path;
  if (!worktree || !fs.existsSync(worktree)) return { attempted: false, merged: false, how: "no worktree", blocked_by: ["no worktree"] };
  const branch = `baseline/${ticket}`;
  const onBranch = git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true });
  if (onBranch.status !== 0) git(worktree, ["checkout", "-q", "-b", branch]);
  git(worktree, ["add", "-A"]);
  if (git(worktree, ["diff", "--cached", "--quiet"], { allowFail: true }).status !== 0) git(worktree, ["-c", "user.name=baseline", "-c", "user.email=baseline@localhost", "commit", "-q", "-m", `${ticket}: baseline run ${rs.runId}`]);
  if (headSha(worktree) === rs.row.base_sha) return { attempted: true, merged: false, how: "no changes", blocked_by: ["the run produced no changes"] };
  // CI: the branch's own project suite, run in the worktree.
  const ci = projectSuite(worktree, policy, `${ticket}.baseline-ci`, outDir);
  if (ci.status !== "pass") return { attempted: true, merged: false, how: "branch CI red", blocked_by: [`branch CI failed: ${ci.failed.slice(0, 5).join(", ")}`] };
  const merge = git(clone, ["-c", "user.name=baseline", "-c", "user.email=baseline@localhost", "merge", "--no-ff", "-m", `Merge ${branch}`, branch], { allowFail: true });
  if (merge.status !== 0) {
    git(clone, ["merge", "--abort"], { allowFail: true });
    return { attempted: true, merged: false, how: "merge conflict", blocked_by: [`git merge conflict: ${merge.stderr.trim().split("\n").slice(-1)[0] ?? ""}`] };
  }
  return { attempted: true, merged: true, how: "plain merge after green branch CI", blocked_by: [] };
}

function mergePhase(args: Args, state: State, store: KnowledgeStore, outDir: string, log: (s: string) => void): void {
  const tickets = loadTicketFile(path.resolve(args.tickets)).filter((t) => !args.only || args.only.has(t.id));
  for (const arm of args.arms) {
    const clone = state.arms[arm]!.clone;
    const policy = policyForRepo(clone) ?? fallbackPolicy(clone);
    const mergeOut = path.join(outDir, arm, "merge");
    fs.mkdirSync(mergeOut, { recursive: true });
    const mergedSoFar = state.merges.filter((m) => m.arm === arm && m.merged).map((m) => m.ticket);
    for (const t of tickets) {
      if (state.merges.some((m) => m.arm === arm && m.ticket === t.id)) continue;
      const run = state.runs.find((r) => r.arm === arm && r.ticket === t.id);
      const row: MergeRow = { ticket: t.id, arm, run_id: run?.run_id ?? null, attempted: false, merged: false, how: "", tier: null, approvals_needed: null, blocked_by: [], merged_verification: null, main_after: null };
      if (!run?.run_id || !["REVIEW_READY", "HUMAN_REVIEW"].includes(run.final_state)) {
        row.how = `not mergeable: run ${run?.final_state ?? "missing"}`;
        row.blocked_by = [row.how];
      } else if (arm === "full") {
        try {
          const out: MergeOutcome = mergeRun(store, run.run_id, { approve: args.approvers, by: "benchmark", log: (l) => log(`  full/${t.id}: ${l}`) });
          row.attempted = true;
          row.merged = out.merged;
          row.how = out.merged ? "intentos merge" : "intentos merge refused";
          row.tier = out.pr.decision.tier;
          row.approvals_needed = out.pr.decision.required_approvals;
          row.blocked_by = out.blocked_by;
          row.merged_verification = out.merged_verification?.status ?? null;
        } catch (e) {
          row.attempted = true;
          row.how = "intentos merge error";
          row.blocked_by = [(e as Error).message.slice(0, 300)];
        }
      } else {
        const rs = new RunStore(store, run.run_id, store.getRun(run.run_id)!.run_dir);
        Object.assign(row, plainMerge(clone, policy, rs, t.id, mergeOut));
        row.approvals_needed = 1; // one reviewer on every PR, the convention the baseline team follows
      }
      if (row.merged) mergedSoFar.push(t.id);
      if (row.attempted) row.main_after = mainHealth(clone, policy, mergedSoFar, `${t.id}.after`, mergeOut);
      state.merges = [...state.merges.filter((m) => !(m.arm === arm && m.ticket === t.id)), row];
      save(outDir, state);
      log(`${arm}/${t.id}: ${row.merged ? "merged" : "not merged"} (${row.how}${row.tier !== null ? `, tier ${row.tier}` : ""})${row.main_after ? `; main ${row.main_after.green ? "green" : `RED: ${row.main_after.failed.slice(0, 3).join(", ")}`}` : ""}`);
    }
  }
}

function fmt(b: boolean | null): string {
  return b === null ? "n/a" : b ? "pass" : "FAIL";
}

function save(outDir: string, state: State): void {
  fs.writeFileSync(path.join(outDir, "compare.json"), JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(outDir, "report.md"), render(state));
}

export function render(state: State): string {
  const L: string[] = [];
  L.push(`# Codex alone vs Codex under IntentOS — ${path.basename(state.repo)} @ ${state.base.slice(0, 10)}`);
  L.push("");
  L.push(`Started ${state.started_at}; implementer model ${state.model ?? "codex default"}; one run per ticket per arm. Every number is read from run artifacts and test runs; failed runs are rows.`);
  const arms = Object.keys(state.arms) as Arm[];
  L.push("");
  L.push("## Runs");
  L.push("");
  L.push("| ticket | arm | state | route ok | acceptance (final / first attempt) | first-attempt blocking inv/arch/scope | blocking final | review findings | protected touched | files | repairs | wall s | tokens in/out |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  const tok = (t: unknown) => (t && typeof t === "object" && "input_tokens" in (t as object) ? `${(t as { input_tokens: number }).input_tokens}/${(t as { output_tokens: number }).output_tokens}` : "unknown");
  for (const r of [...state.runs].sort((a, b) => a.ticket.localeCompare(b.ticket) || a.arm.localeCompare(b.arm))) {
    const fb = r.first_attempt_blocking;
    L.push(`| ${r.ticket} | ${r.arm} | ${r.final_state}${r.error ? ` (${r.error.slice(0, 60)})` : ""} | ${r.route_correct ? "yes" : "no"} | ${fmt(r.acceptance_final)} / ${fmt(r.acceptance_first)} | ${fb ? `${fb.invariant}/${fb.architecture}/${fb.scope}` : "n/a"} | ${r.blocking_final ?? "n/a"} | ${r.review_findings_final ?? "n/a"} | ${r.protected_paths_touched ?? "n/a"} | ${r.changed_files ?? "n/a"} | ${r.repair_rounds} | ${Math.round(r.wall_ms / 1000)} | ${tok(r.tokens)} |`);
  }
  L.push("");
  L.push("## Totals per arm");
  L.push("");
  L.push("| arm | tickets | acceptance passed (final) | acceptance passed (first attempt) | route correct | runs with first-attempt invariant violations | runs with protected paths touched | repairs total | errors | mean wall s |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const arm of arms) {
    const rows = state.runs.filter((r) => r.arm === arm);
    const n = rows.length;
    const c = (f: (r: RunRow) => boolean) => rows.filter(f).length;
    L.push(`| ${arm} | ${n} | ${c((r) => r.acceptance_final === true)} | ${c((r) => r.acceptance_first === true)} | ${c((r) => r.route_correct)} | ${c((r) => (r.first_attempt_blocking?.invariant ?? 0) > 0)} | ${c((r) => (r.protected_paths_touched ?? 0) > 0)} | ${rows.reduce((a, r) => a + r.repair_rounds, 0)} | ${c((r) => !!r.error)} | ${n ? Math.round(rows.reduce((a, r) => a + r.wall_ms, 0) / n / 1000) : 0} |`);
  }
  if (state.merges.length) {
    L.push("");
    L.push("## Merges (ticket order, into each arm's own main)");
    L.push("");
    L.push("| ticket | arm | merged | how | tier | approvals needed | merged-result verification | main after: project / invariants / acceptance | failing on main |");
    L.push("|---|---|---|---|---|---|---|---|---|");
    for (const m of [...state.merges].sort((a, b) => a.ticket.localeCompare(b.ticket) || a.arm.localeCompare(b.arm))) {
      L.push(`| ${m.ticket} | ${m.arm} | ${m.merged ? "yes" : "no"} | ${m.how}${m.blocked_by.length && !m.merged ? `: ${m.blocked_by[0]!.slice(0, 90)}` : ""} | ${m.tier ?? "n/a"} | ${m.approvals_needed ?? "n/a"} | ${m.merged_verification ?? "n/a"} | ${m.main_after ? `${m.main_after.green ? "GREEN" : "RED"}: ${m.main_after.project} / ${m.main_after.invariants} / ${m.main_after.acceptance}` : "n/a"} | ${m.main_after?.failed.slice(0, 3).join(", ") ?? ""} |`);
    }
    L.push("");
    L.push("| arm | merges attempted | merged | refused | merges that left main red | approvals required in total |");
    L.push("|---|---|---|---|---|---|");
    for (const arm of arms) {
      const ms = state.merges.filter((m) => m.arm === arm);
      L.push(`| ${arm} | ${ms.filter((m) => m.attempted).length} | ${ms.filter((m) => m.merged).length} | ${ms.filter((m) => m.attempted && !m.merged).length} | ${ms.filter((m) => m.merged && m.main_after && !m.main_after.green).length} | ${ms.filter((m) => m.merged).reduce((a, m) => a + (m.approvals_needed ?? 0), 0)} |`);
    }
  }
  L.push("");
  L.push("Acceptance = the hidden tests written by the side model before implementation (benchmarks/hidden_tests/<policy>/tasks/<id>). First attempt = verification/attempt-1, before any repair. Route correct for the baseline is false by construction on clarify/abstain tickets: it cannot do either. Baseline merges use the branch's own project suite as CI and a plain git merge; IntentOS merges go through the gate and the merged-result verification.");
  return L.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = ensureHome(resolvePaths());
  const log = (s: string) => console.error(`[compare] ${s}`);
  const outDir = args.resume ? path.resolve(args.resume) : path.resolve(args.out ?? path.join(paths.benchmarks, "demandlib", nowIso().replace(/[:.]/g, "-")));
  fs.mkdirSync(outDir, { recursive: true });
  const stateFile = path.join(outDir, "compare.json");
  const store = new KnowledgeStore(paths.db);
  const source = path.resolve(args.repo!);
  let state: State;
  if (fs.existsSync(stateFile)) {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as State;
    log(`resuming ${outDir}: ${state.runs.length} run row(s), ${state.merges.length} merge row(s)`);
  } else {
    state = { started_at: nowIso(), repo: source, base: headSha(source), model: process.env.INTENTOS_CODEX_MODEL ?? null, arms: {}, runs: [], merges: [] };
  }
  if (args.arms.includes("full") && !coordinationStatus().ok) throw new Error(`coordination is unavailable: ${coordinationStatus().reason}`);
  for (const arm of args.arms) {
    if (!state.arms[arm]) {
      const c = prepareClone(args, arm, outDir, store, log);
      state.arms[arm] = { clone: c.clone, repo_id: c.repoId };
    } else indexRepository(store, state.arms[arm]!.clone);
  }
  save(outDir, state);
  if (args.phase === "run" || args.phase === "all") await runPhase(args, state, store, outDir, log);
  if (args.phase === "merge" || args.phase === "all") mergePhase(args, state, store, outDir, log);
  save(outDir, state);
  console.log(render(state));
  log(`wrote ${outDir}/compare.json and report.md`);
  store.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
