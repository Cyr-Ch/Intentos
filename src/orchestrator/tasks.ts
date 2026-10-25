import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, resolvePaths } from "../config.ts";

export interface BenchmarkTask {
  id: string;
  fixture: string;
  title: string;
  request: string;
  expected_route: "implement" | "clarify" | "abstain";
  /** Routes that also count as correct (e.g. clarify when the request is genuinely underspecified). */
  accepted_routes?: Array<"implement" | "clarify" | "abstain">;
  hidden_tests: string | null;
  hazards: string[];
  offline_patches: Record<string, string>;
  notes?: string;
}

export function loadBenchmarkTasks(file = path.join(PROJECT_ROOT, "benchmarks", "tasks.json")): BenchmarkTask[] {
  if (!fs.existsSync(file)) return [];
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { tasks: BenchmarkTask[] }).tasks;
}

/** Resolve hidden test directories for a task (explicit id, or exact request text match). */
export function resolveHiddenTests(policyId: string, task: string, taskId: string | null): { taskDir: string | null; invariantsDir: string | null; benchmarkTask: BenchmarkTask | null } {
  const paths = resolvePaths();
  const invariantsDir = path.join(paths.hiddenTests, policyId, "invariants");
  const tasks = loadBenchmarkTasks();
  const bench = tasks.find((t) => (taskId ? t.id === taskId : t.request.trim().toLowerCase() === task.trim().toLowerCase())) ?? null;
  let taskDir: string | null = null;
  if (bench?.hidden_tests) {
    const dir = path.join(PROJECT_ROOT, bench.hidden_tests);
    if (fs.existsSync(dir)) taskDir = dir;
  }
  return { taskDir, invariantsDir: fs.existsSync(invariantsDir) ? invariantsDir : null, benchmarkTask: bench };
}
