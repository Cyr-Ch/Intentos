/**
 * Build the interview demo state from scratch, then snapshot it so `demo/reset.sh` restores it in seconds.
 *
 *   node --disable-warning=ExperimentalWarning demo/prepare.ts [--root ~/intentos-demo] [--source ~/repos/demandlib]
 *       [--model gpt-6-astra] [--no-register]
 *
 * Produces, under <root>:
 *   home/              a private INTENTOS_HOME (store, runs, worktrees, coordination state)
 *   demandlib/         the demo repository, indexed, with the original's venv and precedents
 *   red/demandlib/     a second clone whose main is red after two merges that each pass alone (for the guardian)
 *   state.json         run ids, PR numbers, the sentences to say
 * With the IntentOS plugin installed, start Codex as `INTENTOS_HOME=<root>/home INTENTOS_CODEX_MODEL=... codex`;
 * `--register` instead registers a separate `intentos-demo` server for installations without the plugin.
 *
 * Prepared runs on demandlib (finished, not merged):
 *   P2  ticket T13 (zero-demand warning); its changed file imports tools.add_weekdays2df
 *   P1  "Rename add_weekdays2df to annotate_weekdays, keep a deprecated alias": a public rename, tier 2 at the gate
 * Moment A: a live run on T12 while P1 merges: the hook tells the agent about the rename mid-task.
 * Moment B: merge P2: refused with the exact symbol, commit, file and line.
 * Moment C: `guard` on red/demandlib: culprit, partner, validated undo PR; merge it.
 *
 * Costs four live Codex runs (about twelve minutes). Everything after that is free to replay.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (name: string, dflt: string | null = null): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] ?? dflt : dflt;
};
const root = path.resolve(opt("--root", path.join(os.homedir(), "intentos-demo"))!);
const source = path.resolve(opt("--source", path.join(os.homedir(), "repos", "demandlib"))!);
const model = opt("--model", process.env.INTENTOS_CODEX_MODEL ?? "gpt-6-astra")!;
// With the IntentOS plugin installed, the demo home is selected by INTENTOS_HOME in Codex's environment; a separate
// `intentos-demo` server registration is only for installations without the plugin (`--register`).
const register = argv.includes("--register");
process.env.INTENTOS_HOME = path.join(root, "home");
process.env.INTENTOS_CODEX_MODEL = model;
delete process.env.INTENTOS_COORDINATION;

const { ensureHome, resolvePaths, PROJECT_ROOT } = await import("../src/config.ts");
const { KnowledgeStore } = await import("../src/knowledge/storage.ts");
const { indexRepository, repoIdFor } = await import("../src/knowledge/indexer.ts");
const { loadIndexedRepo } = await import("../src/knowledge/repo.ts");
const { fallbackPolicy, policyForRepo } = await import("../src/knowledge/policy.ts");
const { repoInterpreter, repoVenvDir } = await import("../src/knowledge/venv.ts");
const { precedentsFile } = await import("../src/knowledge/precedents.ts");
const { createRun, executeRun } = await import("../src/orchestrator/runner.ts");
const { mergeRun } = await import("../src/coordination/merge.ts");
const { coordinationStatus, coordinationEnv, openPr } = await import("../src/coordination/mergeguard.ts");
const { loadTicketFile } = await import("../src/acceptance.ts");
const { git, headSha } = await import("../src/util/git.ts");

const log = (s: string) => console.error(`[demo] ${s}`);

function sh(cwd: string, cmd: string, args: string[]): { status: number; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

function clone(store: InstanceType<typeof KnowledgeStore>, dest: string): string {
  if (fs.existsSync(dest)) throw new Error(`${dest} exists; run demo/reset.sh --destroy first`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = sh(path.dirname(dest), "git", ["clone", "--quiet", source, dest]);
  if (r.status !== 0) throw new Error(`git clone failed: ${r.out}`);
  git(dest, ["config", "user.name", "Priya"]);
  git(dest, ["config", "user.email", "priya@example.test"]);
  const paths = resolvePaths();
  const venv = repoVenvDir(source, paths);
  const cloneVenv = repoVenvDir(dest, paths);
  fs.mkdirSync(path.dirname(cloneVenv), { recursive: true });
  if (fs.existsSync(venv) && !fs.existsSync(cloneVenv)) fs.symlinkSync(venv, cloneVenv);
  // The demo home has no venvs of its own: borrow the original home's venv for the source repository too.
  const originalHome = path.join(PROJECT_ROOT, ".intentos");
  const originalVenv = path.join(originalHome, "venvs", repoIdFor(source));
  if (!fs.existsSync(venv) && fs.existsSync(originalVenv) && !fs.existsSync(cloneVenv)) fs.symlinkSync(originalVenv, cloneVenv);
  const prec = path.join(originalHome, "precedents", `${repoIdFor(source)}.json`);
  const clonePrec = precedentsFile(paths, repoIdFor(dest));
  if (fs.existsSync(prec)) {
    fs.mkdirSync(path.dirname(clonePrec), { recursive: true });
    fs.copyFileSync(prec, clonePrec);
  }
  indexRepository(store, dest);
  log(`cloned ${dest} (${repoIdFor(dest)}) at ${headSha(dest).slice(0, 10)}`);
  return dest;
}

async function run(store: InstanceType<typeof KnowledgeStore>, repo: string, task: string, taskId: string | null, label: string) {
  const indexed = loadIndexedRepo(store, repo);
  const opts = { mode: "live" as const, taskId, log: (l: string) => log(`  ${label}: ${l}`) };
  const rs = createRun(store, indexed, task, opts);
  log(`${label}: run ${rs.runId} started`);
  const outcome = await executeRun(store, rs, opts);
  log(`${label}: ${outcome.state}${outcome.reason ? ` (${outcome.reason})` : ""}`);
  return { runId: rs.runId, state: outcome.state, worktree: rs.row.worktree_path };
}

function projectSuite(repo: string): { status: string; failed: string[] } {
  const policy = policyForRepo(repo) ?? fallbackPolicy(repo);
  const cmd = policy.commands.pytest_project;
  if (!cmd?.argv) return { status: "none", failed: [] };
  const python = repoInterpreter(repo);
  const junit = path.join(root, "red-main.junit.xml");
  const a = cmd.argv.map((x) => x.replace("{python}", python).replace("{snapshot}", repo).replace("{junit}", junit)).filter((x) => !x.includes("{hidden_tests_dir}"));
  const r = spawnSync(a[0]!, a.slice(1), { cwd: repo, encoding: "utf8", timeout: 900_000 });
  const failed = [...(r.stdout ?? "").matchAll(/^FAILED (\S+)/gm)].map((m) => m[1]!);
  return { status: r.status === 0 ? "pass" : "fail", failed };
}

type Prepared = { runId: string; state: string; worktree: string | null };
type PreparedPr = { pr: number; branch: string; head: string; tier: number };

/** The rename as a branch and a mergeguard PR: old definition gone, a module-level alias keeps external callers working. */
function renamePr(store: InstanceType<typeof KnowledgeStore>, repo: string): PreparedPr {
  const branch = "intentos/rename-add_weekdays2df";
  const policy = policyForRepo(repo) ?? fallbackPolicy(repo);
  const coord = coordinationEnv(repo, policy);
  const existing = git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true });
  if (existing.status !== 0) {
    const main = headSha(repo);
    const wt = path.join(root, "home", "worktrees", "rename");
    git(repo, ["worktree", "add", "-q", "-b", branch, wt, main]);
    const edit = (rel: string, fn: (t: string) => string) => fs.writeFileSync(path.join(wt, rel), fn(fs.readFileSync(path.join(wt, rel), "utf8")));
    for (const rel of ["src/oemof/demand/bdew/elec_slp.py", "src/oemof/demand/bdew/heat_building.py", "src/oemof/demand/particular_profiles.py", "src/oemof/demand/vdi/regions.py"]) {
      if (fs.existsSync(path.join(wt, rel))) edit(rel, (t) => t.replace(/\badd_weekdays2df\b/g, "annotate_weekdays"));
    }
    edit("src/oemof/demand/tools.py", (t) => t.replace("def add_weekdays2df(", "def annotate_weekdays(").trimEnd() + "\n\n\n# Deprecated alias: the function is annotate_weekdays; external callers keep working for now.\nadd_weekdays2df = annotate_weekdays\n");
    git(wt, ["add", "-A"]);
    git(wt, ["-c", "user.name=intentos", "-c", "user.email=intentos@localhost", "commit", "-q", "-m", "Rename add_weekdays2df to annotate_weekdays; keep a deprecated alias"]);
    git(repo, ["worktree", "remove", "--force", wt]);
  }
  const head = git(repo, ["rev-parse", `refs/heads/${branch}`]).stdout.trim();
  const pr = openPr(coord, repo, branch, "Rename add_weekdays2df to annotate_weekdays", { author: "intentos", prompter: "demo" });
  log(`P1 (rename): PR #${pr.number} on ${branch} (${head.slice(0, 10)}), tier ${pr.decision.tier}: ${pr.decision.reasons.join("; ")}`);
  return { pr: pr.number, branch, head, tier: pr.decision.tier };
}
const OK = (r: Prepared | undefined): r is Prepared => !!r && ["REVIEW_READY", "HUMAN_REVIEW"].includes(r.state);

async function main() {
  const resume = argv.includes("--resume");
  const stateFile = path.join(root, "state.json");
  if (fs.existsSync(root) && !resume) throw new Error(`${root} exists; pass --resume to redo only what failed (a usage limit, say), run demo/reset.sh to restore the snapshot, or demo/reset.sh --destroy to rebuild`);
  const previous = resume && fs.existsSync(stateFile) ? (JSON.parse(fs.readFileSync(stateFile, "utf8")) as { runs?: Record<string, Prepared>; red?: Record<string, unknown> }) : null;
  const kept = previous?.runs ?? {};
  ensureHome(resolvePaths());
  const store = new KnowledgeStore(resolvePaths().db);
  if (!coordinationStatus().ok) throw new Error(`coordination unavailable: ${coordinationStatus().reason}`);
  const tickets = Object.fromEntries(loadTicketFile(path.join(PROJECT_ROOT, "benchmarks", "demandlib", "tickets.yaml")).map((t) => [t.id, `${t.title}\n\n${t.issue}`.trim()]));
  const ensureClone = (dest: string): string => (fs.existsSync(dest) ? (indexRepository(store, dest), dest) : clone(store, dest));
  const need = async (key: string, repo: string, task: string, taskId: string | null, label: string): Promise<Prepared> => {
    if (OK(kept[key])) {
      log(`${label}: keeping ${kept[key]!.runId} (${kept[key]!.state})`);
      return kept[key]!;
    }
    return run(store, repo, task, taskId, label);
  };

  // ---- the demo repository and the two prepared runs
  const demo = ensureClone(path.join(root, "demandlib"));
  const base = headSha(demo);
  const p2 = await need("P2_T13", demo, tickets.T13!, "T13", "P2 (T13)");
  // P1 is a scripted change, not an agent run: the rename must remove the old definition (an agent tends to keep a
  // wrapper function, which the symbol index still sees as the same API), so it is made deterministically and opened
  // as a mergeguard PR. The gate rates it tier 2 (public API change): two approvals.
  const p1 = renamePr(store, demo);

  // ---- the red clone: two runs that each pass alone and clash in meaning, landed with the merged-result checks off
  const red = ensureClone(path.join(root, "red", "demandlib"));
  const redDone = !!(previous?.red as { main?: { status?: string } } | undefined)?.main?.status;
  const a = redDone ? kept.red_A_T13! : await need("red_A_T13", red, tickets.T13!, "T13", "red A (T13)");
  const prosumer = ["Allow negative annual demand for prosumer sites", "", "Some of our industrial sites are net generators over the year. `IndustrialLoadProfile.simple_profile` should accept a", "negative `annual_demand` and return the same profile shape scaled by that negative value, so the series integrates to", "the negative total. Add a test that a negative demand gives a profile whose sum is that negative value."].join("\n");
  const b = redDone ? kept.red_B_prosumer! : await need("red_B_prosumer", red, prosumer, null, "red B (prosumer)");
  let redMerges: Record<string, unknown> = redDone ? (previous!.red as Record<string, unknown>) : {};
  if (!redDone && OK(a) && OK(b)) {
    const ma = mergeRun(store, a.runId, { approve: ["Priya", "Sam"], by: "demo", log: (l) => log(`  red A: ${l}`) });
    process.env.INTENTOS_COORDINATION_MERGE_CHECK = "0";
    const mb = mergeRun(store, b.runId, { approve: ["Priya", "Sam"], by: "demo", skipMergedVerification: true, log: (l) => log(`  red B: ${l}`) });
    delete process.env.INTENTOS_COORDINATION_MERGE_CHECK;
    const health = projectSuite(red);
    redMerges = { a: { pr: ma.pr.number, merged: ma.merged, blocked_by: ma.blocked_by }, b: { pr: mb.pr.number, merged: mb.merged, blocked_by: mb.blocked_by }, main: health };
    log(`red main after both merges: ${health.status}${health.failed.length ? ` (${health.failed.join(", ")})` : ""}`);
  } else if (redDone) log(`red clone: kept (main ${String((redMerges.main as { status?: string })?.status)})`);
  else log(`red clone: runs ended ${a.state} / ${b.state}; the guardian moment is not prepared`);

  // ---- register the MCP server for this home
  const registration = `codex mcp add intentos-demo --env INTENTOS_HOME=${process.env.INTENTOS_HOME} --env INTENTOS_CODEX_MODEL=${model} -- ${process.execPath} --disable-warning=ExperimentalWarning ${path.join(PROJECT_ROOT, "bin", "intentos.js")} mcp`;
  if (register) {
    sh(root, "codex", ["mcp", "remove", "intentos-demo"]);
    const r = sh(root, "codex", ["mcp", "add", "intentos-demo", "--env", `INTENTOS_HOME=${process.env.INTENTOS_HOME}`, "--env", `INTENTOS_CODEX_MODEL=${model}`, "--", process.execPath, "--disable-warning=ExperimentalWarning", path.join(PROJECT_ROOT, "bin", "intentos.js"), "mcp"]);
    log(r.status === 0 ? "registered MCP server intentos-demo" : `registration failed: ${r.out.trim()}; run by hand: ${registration}`);
  }

  const state = {
    prepared_at: new Date().toISOString(),
    root,
    home: process.env.INTENTOS_HOME,
    model,
    source,
    demo_repo: demo,
    base,
    red_repo: red,
    runs: { P2_T13: p2, red_A_T13: a, red_B_prosumer: b },
    rename_pr: p1,
    red: redMerges,
    live_ticket_for_moment_A: "T12",
    registration,
    sentences: {
      opener: "What does IntentOS know about this repository? Show me status and the policy.",
      momentA_start: `Implement this under IntentOS, task id T12:\n\n${tickets.T12}`,
      momentA_during: `Merge PR #${p1.pr} of ${demo}, approvals from Priya and Sam.`,
      momentA_after: "Merge the T12 run, approval from Priya.",
      momentB: `Merge run ${p2.runId}, approval from Priya.`,
      momentC: `Main of ${red} is red. Investigate.`,
      momentC_after: "Merge that undo PR, approvals from Priya and Sam.",
    },
  };
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(state, null, 2));
  // Preparation attempts remain in the audit store but do not crowd the live ticket view.
  const hiddenRunIds = store.listRuns(repoIdFor(demo)).filter((row) => row.id !== p2.runId).map((row) => row.id);
  fs.writeFileSync(path.join(resolvePaths().home, "dashboard.json"), JSON.stringify({ hidden_run_ids: hiddenRunIds }, null, 2));
  store.close();

  // ---- snapshot for demo/reset.sh
  const snapshot = `${root}.snapshot`;
  fs.rmSync(snapshot, { recursive: true, force: true });
  const cp = sh(path.dirname(root), "cp", ["-R", root, snapshot]);
  if (cp.status !== 0) throw new Error(`snapshot failed: ${cp.out}`);
  log(`snapshot at ${snapshot}`);
  console.log(JSON.stringify(state, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
