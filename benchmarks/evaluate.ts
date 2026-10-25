/**
 * Benchmark runner (M5): executes benchmark tasks through the IntentOS pipeline and
 * computes metrics strictly from persisted run artifacts. Modes:
 *   full      — evidence + compiled contract + controlled execution + verification (IntentOS)
 *   baseline  — same worktree/verifier but the implementer gets ONLY the task text (no contract, no evidence);
 *               verification still runs so the comparison is fair. Live Codex only.
 * Offline mode replays the task's recorded patches (good/bad) through the full pipeline; results
 * are labelled simulated and measure the orchestration path, not agent performance.
 *
 * Usage: node --disable-warning=ExperimentalWarning benchmarks/evaluate.ts [--offline] [--task <id>] [--mode full|baseline] [--out <dir>]
 */
import fs from "node:fs";
import path from "node:path";
import { ensureHome, resolvePaths, PROJECT_ROOT } from "../src/config.ts";
import { KnowledgeStore } from "../src/knowledge/storage.ts";
import { indexRepository } from "../src/knowledge/indexer.ts";
import { loadIndexedRepo } from "../src/knowledge/repo.ts";
import { createRun, executeRun, type RunOptions } from "../src/orchestrator/runner.ts";
import { loadBenchmarkTasks } from "../src/orchestrator/tasks.ts";
import type { VerificationResult } from "../src/verification/results.ts";
import { LiveCodexEngine, type CodingEngine } from "../src/codex/adapter.ts";
import { nowIso } from "../src/util/ids.ts";

interface Args {
  offline: boolean;
  task: string | null;
  mode: "full" | "baseline";
  out: string | null;
  repo: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { offline: false, task: null, mode: "full", out: null, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === "--offline") a.offline = true;
    else if (v === "--task") a.task = argv[++i] ?? null;
    else if (v === "--mode") a.mode = (argv[++i] as Args["mode"]) ?? "full";
    else if (v === "--out") a.out = argv[++i] ?? null;
    else if (v === "--repo") a.repo = argv[++i] ?? null;
  }
  return a;
}

/** Baseline: Codex receives only the task text. Verification is unchanged, so hazards are still measured. */
class BaselineEngine implements CodingEngine {
  readonly name = "codex-sdk-baseline(task-only prompt)";
  readonly simulated = false;
  private readonly live = new LiveCodexEngine();
  private readonly task: string;
  constructor(task: string) {
    this.task = task;
  }
  plan: CodingEngine["plan"] = (req) => this.live.plan(req);
  implement: CodingEngine["implement"] = (req) => this.live.implement({ ...req, prompt: req.threadId ? req.prompt : `${this.task}\n\nRun the test suite with python -m pytest -q before finishing.` });
}

interface Row {
  task_id: string;
  variant: string;
  run_id: string;
  final_state: string;
  expected_route: string;
  route_correct: boolean;
  task_tests_passed: boolean | null;
  invariants_preserved: boolean | null;
  architecture_compliant: boolean | null;
  scope_clean: boolean | null;
  blocking_findings: number | null;
  repair_rounds: number;
  wall_ms: number;
  tokens: unknown;
  simulated: boolean;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = ensureHome(resolvePaths());
  const repo = args.repo ?? path.join(paths.fixtures, "startup_billing");
  if (!fs.existsSync(repo)) throw new Error(`fixture repo missing at ${repo}; run npm run fixture:build`);
  const store = new KnowledgeStore(paths.db);
  indexRepository(store, repo);
  const indexed = loadIndexedRepo(store, repo);
  const outDir = args.out ?? path.join(paths.benchmarks, nowIso().replace(/[:.]/g, "-"));
  fs.mkdirSync(outDir, { recursive: true });
  const tasks = loadBenchmarkTasks().filter((t) => !args.task || t.id === args.task);
  const rows: Row[] = [];

  for (const t of tasks) {
    const variants: Array<{ name: string; opts: RunOptions }> = [];
    if (args.offline) {
      if (t.expected_route !== "implement") variants.push({ name: `offline-${t.expected_route}`, opts: { mode: "offline", taskId: t.id, offline: { route: t.expected_route } } });
      for (const [label, patch] of Object.entries(t.offline_patches)) variants.push({ name: `offline-${label}`, opts: { mode: "offline", taskId: t.id, offline: { route: "implement", patchFile: path.join(PROJECT_ROOT, patch) } } });
      if (!variants.length) variants.push({ name: "offline-nopatch", opts: { mode: "offline", taskId: t.id, offline: { route: "implement" } } });
    } else if (args.mode === "baseline") {
      variants.push({ name: "live-baseline", opts: { mode: "live", taskId: t.id, engine: new BaselineEngine(t.request) } });
    } else {
      variants.push({ name: "live-full", opts: { mode: "live", taskId: t.id } });
    }
    for (const v of variants) {
      console.error(`[bench] ${t.id} / ${v.name}`);
      const rs = createRun(store, indexed, t.request, v.opts);
      const outcome = await executeRun(store, rs, v.opts);
      const ver = rs.readJson<VerificationResult>("verification");
      const metrics = rs.readJson<{ repair_rounds: number; wall_time_ms: number; tokens: unknown }>("metrics");
      const cmd = (id: string) => ver?.commands.find((c) => c.command_id === id);
      const trackOk = (track: string) => (ver ? (ver.tracks[track]?.status === "not_run" ? null : ver.tracks[track]?.blocking_findings === 0) : null);
      const route = outcome.state === "CLARIFICATION_REQUIRED" ? "clarify" : outcome.state === "ABSTAINED" ? "abstain" : "implement";
      rows.push({
        task_id: t.id,
        variant: v.name,
        run_id: rs.runId,
        final_state: outcome.state,
        expected_route: t.expected_route,
        route_correct: route === t.expected_route,
        task_tests_passed: cmd("pytest_hidden_task") ? cmd("pytest_hidden_task")!.status === "passed" && (cmd("pytest_hidden_task")!.tests_passed ?? 0) > 0 : null,
        invariants_preserved: trackOk("business_invariant"),
        architecture_compliant: trackOk("architecture"),
        scope_clean: trackOk("scope"),
        blocking_findings: ver ? ver.findings.filter((f) => f.severity === "blocking").length : null,
        repair_rounds: metrics?.repair_rounds ?? 0,
        wall_ms: metrics?.wall_time_ms ?? 0,
        tokens: metrics?.tokens ?? "unknown",
        simulated: v.opts.mode === "offline",
      });
      fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ generated_at: nowIso(), repo, revision: indexed.revision, offline: args.offline, mode: args.mode, rows }, null, 2));
    }
  }
  fs.writeFileSync(path.join(outDir, "results.md"), renderTable(rows, indexed.revision, args));
  console.log(renderTable(rows, indexed.revision, args));
  console.error(`[bench] wrote ${outDir}/results.json and results.md`);
  store.close();
}

function renderTable(rows: Row[], revision: string, args: Args): string {
  const L: string[] = [];
  L.push(`# Benchmark results — ${args.offline ? "OFFLINE (simulated orchestration; not agent performance)" : `LIVE ${args.mode}`} @ ${revision.slice(0, 10)}`);
  L.push("");
  L.push("| task | variant | final state | route ok | task tests | invariants | architecture | scope | blocking | repairs | wall ms | tokens |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  const fmt = (b: boolean | null) => (b === null ? "n/a" : b ? "pass" : "FAIL");
  for (const r of rows) L.push(`| ${r.task_id} | ${r.variant} | ${r.final_state} | ${r.route_correct ? "yes" : "no"} | ${fmt(r.task_tests_passed)} | ${fmt(r.invariants_preserved)} | ${fmt(r.architecture_compliant)} | ${fmt(r.scope_clean)} | ${r.blocking_findings ?? "n/a"} | ${r.repair_rounds} | ${r.wall_ms} | ${typeof r.tokens === "string" ? r.tokens : JSON.stringify(r.tokens)} |`);
  L.push("");
  L.push("Metrics are computed from persisted run artifacts (verification.json, metrics.json). 'n/a' means the check did not run for that variant.");
  if (args.offline) L.push("Offline rows replay recorded patches through the real verifier; they demonstrate the gates, not model behaviour.");
  return L.join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
