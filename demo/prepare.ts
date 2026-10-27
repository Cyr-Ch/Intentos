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
 * and registers the MCP server `intentos-demo` in Codex with INTENTOS_HOME pointing at <root>/home.
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
const register = !argv.includes("--no-register");
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
const { coordinationStatus } = await import("../src/coordination/mergeguard.ts");
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

async function main() {
  if (fs.existsSync(root)) throw new Error(`${root} exists; run demo/reset.sh --destroy to rebuild, or demo/reset.sh to restore the snapshot`);
  ensureHome(resolvePaths());
  const store = new KnowledgeStore(resolvePaths().db);
  if (!coordinationStatus().ok) throw new Error(`coordination unavailable: ${coordinationStatus().reason}`);
  const tickets = Object.fromEntries(loadTicketFile(path.join(PROJECT_ROOT, "benchmarks", "demandlib", "tickets.yaml")).map((t) => [t.id, `${t.title}\n\n${t.issue}`.trim()]));

  // ---- the demo repository and the two prepared runs
  const demo = clone(store, path.join(root, "demandlib"));
  const base = headSha(demo);
  const p2 = await run(store, demo, tickets.T13!, "T13", "P2 (T13)");
  const renameTicket = ["Rename add_weekdays2df to annotate_weekdays", "", "`tools.add_weekdays2df` is a poor name: it does more than add weekdays (it also tags holidays and adds the date column).", "Please rename it to `annotate_weekdays` and update every internal caller and test to the new name. Keep", "`add_weekdays2df` as a deprecated alias that calls the new function, so external code keeps working for now."].join("\n");
  const p1 = await run(store, demo, renameTicket, null, "P1 (rename)");

  // ---- the red clone: two runs that each pass alone and clash in meaning, landed with the merged-result checks off
  const red = clone(store, path.join(root, "red", "demandlib"));
  const a = await run(store, red, tickets.T13!, "T13", "red A (T13)");
  const prosumer = ["Allow negative annual demand for prosumer sites", "", "Some of our industrial sites are net generators over the year. `IndustrialLoadProfile.simple_profile` should accept a", "negative `annual_demand` and return the same profile shape scaled by that negative value, so the series integrates to", "the negative total. Add a test that a negative demand gives a profile whose sum is that negative value."].join("\n");
  const b = await run(store, red, prosumer, null, "red B (prosumer)");
  let redMerges: Record<string, unknown> = {};
  if (["REVIEW_READY", "HUMAN_REVIEW"].includes(a.state) && ["REVIEW_READY", "HUMAN_REVIEW"].includes(b.state)) {
    const ma = mergeRun(store, a.runId, { approve: ["Priya", "Sam"], by: "demo", log: (l) => log(`  red A: ${l}`) });
    process.env.INTENTOS_COORDINATION_MERGE_CHECK = "0";
    const mb = mergeRun(store, b.runId, { approve: ["Priya", "Sam"], by: "demo", skipMergedVerification: true, log: (l) => log(`  red B: ${l}`) });
    delete process.env.INTENTOS_COORDINATION_MERGE_CHECK;
    const health = projectSuite(red);
    redMerges = { a: { pr: ma.pr.number, merged: ma.merged, blocked_by: ma.blocked_by }, b: { pr: mb.pr.number, merged: mb.merged, blocked_by: mb.blocked_by }, main: health };
    log(`red main after both merges: ${health.status}${health.failed.length ? ` (${health.failed.join(", ")})` : ""}`);
  } else log(`red clone: runs ended ${a.state} / ${b.state}; the guardian moment is not prepared`);

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
    runs: { P1_rename: p1, P2_T13: p2, red_A_T13: a, red_B_prosumer: b },
    red: redMerges,
    live_ticket_for_moment_A: "T12",
    registration,
    sentences: {
      opener: "What does IntentOS know about this repository? Show me status and the policy.",
      momentA_start: `Implement this under IntentOS, task id T12:\n\n${tickets.T12}`,
      momentA_during: `Merge run ${p1.runId}, approvals from Priya and Sam.`,
      momentA_after: "Merge the T12 run, approval from Priya.",
      momentB: `Merge run ${p2.runId}, approval from Priya.`,
      momentC: `Main of ${red} is red. Investigate.`,
      momentC_after: "Merge that undo PR, approvals from Priya and Sam.",
    },
  };
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(state, null, 2));
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
