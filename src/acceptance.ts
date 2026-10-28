import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { LiveCodexEngine, type CodingEngine } from "./codex/adapter.ts";
import { ensureHome, PROJECT_ROOT, resolvePaths } from "./config.ts";
import { repoIdFor } from "./knowledge/indexer.ts";
import { fallbackPolicy, policyForRepo, type Policy } from "./knowledge/policy.ts";
import { loadIndexedRepo } from "./knowledge/repo.ts";
import { buildEvidencePack, type EvidencePack } from "./knowledge/retrieval.ts";
import type { KnowledgeStore } from "./knowledge/storage.ts";
import { repoInterpreter } from "./knowledge/venv.ts";
import { loadBenchmarkTasks, type BenchmarkTask } from "./orchestrator/tasks.ts";
import { parseJunit, type JunitCase } from "./verification/junit.ts";
import { headSha, isDirty, isGitRepo } from "./util/git.ts";
import { nowIso } from "./util/ids.ts";
import { redact } from "./util/redact.ts";
import { appendRoleSkills, captureAgentSnapshot } from "./agent-skills.ts";

/**
 * Acceptance tests for a ticket, written before anyone implements it, by a model other than the one that will.
 *
 * The side thread (read-only, in the repository) gets the ticket and the evidence pack and answers with pytest
 * modules as structured output. IntentOS trusts none of it until it has run: every module must be collected, and for
 * a ticket that asks for new behaviour at least one test per module must fail at the current revision (a test that
 * passes before the change proves nothing about the change); for a ticket whose correct answer is "already done" every
 * test must pass now. Rejections go back to the same thread once. What survives is written under
 * benchmarks/hidden_tests/<policy>/tasks/<task-id>/ with its author recorded, bound in benchmarks/tasks.json, and never
 * shown to the implementer: the planner's contract is the model's reading of the ticket and cannot be its own oracle.
 */

export type Expectation = "fail" | "pass";

export interface AcceptanceOptions {
  taskId: string;
  /** Model for the side thread; default INTENTOS_ACCEPTANCE_MODEL, then INTENTOS_MINING_MODEL. Never the implementer's default. */
  model?: string | null;
  reasoningEffort?: string | null;
  /** "fail": the ticket asks for new behaviour (default). "pass": the ticket describes behaviour the code already has. */
  expect?: Expectation;
  expectedRoute?: BenchmarkTask["expected_route"];
  /** Rounds at most, the first included (default 2: one answer, one fix of what was rejected). */
  rounds?: number;
  engine?: CodingEngine;
  hiddenTestsRoot?: string;
  tasksFile?: string;
  outDir?: string;
  /** Replace an existing acceptance directory for this task. */
  force?: boolean;
  store?: KnowledgeStore | null;
}

export interface TestStatus {
  file: string;
  test: string;
  status: JunitCase["status"];
  message: string | null;
}

export interface RejectedFile {
  path: string;
  reasons: string[];
}

export interface AcceptanceRound {
  round: number;
  proposed: number;
  accepted: number;
  rejected: RejectedFile[];
  usage: unknown;
}

export interface AcceptanceResult {
  repo_path: string;
  policy_id: string;
  task_id: string;
  head: string;
  expect: Expectation;
  model: string | null;
  engine: string;
  thread_id: string | null;
  rounds: AcceptanceRound[];
  /** Hidden test files written, repository-relative to the IntentOS checkout. */
  files: string[];
  dir: string;
  tasks_file: string;
  statuses: TestStatus[];
  notes: string;
}

export function resolveAcceptanceModel(explicit?: string | null): string | null {
  return explicit ?? process.env.INTENTOS_ACCEPTANCE_MODEL ?? process.env.INTENTOS_MINING_MODEL ?? null;
}

/** Strict structured output: every field present. */
export const ACCEPTANCE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["files", "notes"],
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content", "covers"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          covers: { type: "array", items: { type: "string" } },
        },
      },
    },
    notes: { type: "string" },
  },
};

const FILE_NAME = /^test_[a-z0-9_]+\.py$/;

export function buildAcceptancePrompt(a: { repoPath: string; policyId: string; taskId: string; ticket: string; expect: Expectation; pack: EvidencePack | null; pythonpath: string }): string {
  const L: string[] = [];
  L.push("# IntentOS acceptance tests");
  L.push("");
  L.push(`You write the acceptance tests for a ticket on the repository at ${a.repoPath} (IntentOS policy \`${a.policyId}\`, ticket \`${a.taskId}\`). A different model will implement the ticket later and will never see these tests; they decide, independently of that model's own claims, whether the ticket was solved. You are in a read-only sandbox in the repository: read the code, the existing tests and the docs; run nothing that modifies files.`);
  L.push("");
  L.push("## The ticket, exactly as the implementer will receive it");
  L.push("");
  L.push(a.ticket.trim());
  L.push("");
  L.push("## What the tests must be");
  L.push("");
  if (a.expect === "fail") {
    L.push("- Tests of the behaviour the ticket asks for. They must FAIL at the current revision (the behaviour does not exist yet) and pass once a correct implementation is in place. IntentOS runs them now and rejects a module in which no test fails.");
    L.push("- Regression guards for behaviour the ticket says must not change are welcome in the same modules; they pass now and must keep passing.");
  } else {
    L.push("- The ticket describes behaviour that the repository may already have. Write tests that assert exactly that behaviour; IntentOS runs them now and rejects any that fail, because the right answer to this ticket may be that nothing needs to change.");
  }
  L.push("- Assert behaviour through interfaces the ticket names or that already exist (the entry points a user would call), never through implementation details, so that any compliant implementation passes. For a new function, method or parameter, use the name only when the ticket itself names it; when it does not, prefer reaching the behaviour through an existing entry point, and say in `notes` which name you had to assume.");
  L.push("- Self-contained pytest modules: they run from a directory outside the repository with the package importable, so they cannot use fixtures from the repository's conftest.py; define what they need. No network, no files written outside tempfile, no sleeping.");
  L.push("- Follow the repository's own test style (imports, how objects are built, tolerances). Keep each module focused; two or three modules at most.");
  L.push(`- File names: \`test_<something>.py\`, a plain basename. The modules will be run with \`python -m pytest -o pythonpath=${a.pythonpath}\` from the repository root.`);
  L.push("");
  L.push('Output: a JSON object {"files": [{"path": "test_....py", "content": "<full module>", "covers": ["<one line per thing the module checks>"]}], "notes": "<assumptions, names you had to invent, anything the ticket leaves open>"} and nothing else.');
  if (a.pack) {
    L.push("");
    L.push("## Context from the index (starting points; read the code to confirm)");
    L.push("");
    for (const s of a.pack.reusable_symbols.slice(0, 12)) L.push(`- ${s.kind} ${s.qualified_name} (${s.path}:${s.line_start}-${s.line_end})`);
    const tests = a.pack.tests.slice(0, 8);
    if (tests.length) {
      L.push("");
      L.push("Existing tests near this task:");
      for (const t of tests) L.push(`- ${t.path}${"name" in t && (t as { name?: string }).name ? `::${(t as { name?: string }).name}` : ""}`);
    }
  }
  return redact(L.join("\n"));
}

export function buildAcceptanceFixPrompt(rejected: RejectedFile[], expect: Expectation): string {
  const L: string[] = [];
  L.push(`IntentOS ran your modules at the current revision and rejected ${rejected.length}:`);
  L.push("");
  for (const r of rejected) L.push(`- ${r.path}: ${r.reasons.join(" | ")}`);
  L.push("");
  L.push(expect === "fail" ? "Fix what can be fixed: a module that failed to collect, or one in which every test passes already (then it does not test the requested behaviour; assert what the ticket asks for, which does not exist yet). Return only the fixed modules in the same JSON shape, and {\"files\": []} if none can be fixed. Do not resend the accepted ones." : "Fix what can be fixed: a module that failed to collect, or a test that fails although the ticket describes behaviour the code may already have (check what the code does and assert that). Return only the fixed modules in the same JSON shape, and {\"files\": []} if none can be fixed. Do not resend the accepted ones.");
  return L.join("\n");
}

function parseAnswer(text: string): { files: Array<{ path: string; content: string; covers: string[] }>; notes: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("the model's answer is not JSON");
    parsed = JSON.parse(m[0]);
  }
  const obj = (parsed ?? {}) as { files?: unknown; notes?: unknown };
  const files = Array.isArray(obj.files) ? obj.files.filter((f): f is { path: string; content: string; covers: string[] } => !!f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string" && typeof (f as { content?: unknown }).content === "string").map((f) => ({ path: f.path, content: f.content, covers: Array.isArray(f.covers) ? f.covers.filter((c) => typeof c === "string") : [] })) : [];
  return { files, notes: typeof obj.notes === "string" ? obj.notes : "" };
}

/** `-o pythonpath=...` from the policy's project test command, else `.`. */
export function pythonpathFor(policy: Policy): string {
  const argv = policy.commands.pytest_project?.argv ?? [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("pythonpath=")) return a.slice("pythonpath=".length);
    if (a === "-o" && argv[i + 1]?.startsWith("pythonpath=")) return argv[i + 1]!.slice("pythonpath=".length);
  }
  return ".";
}

/** Run the candidate modules at the repository's current revision and report every test's status. */
export function runAtBase(repoPath: string, dir: string, python: string, pythonpath: string): { cases: JunitCase[]; collectionErrors: Map<string, string>; output: string } {
  const junit = path.join(dir, "junit.xml");
  // pytest resolves `pythonpath` against its rootdir, which is the modules' directory here: make the entries absolute.
  const absolute = pythonpath.split(/\s+/).filter(Boolean).map((p) => path.resolve(repoPath, p)).join(" ");
  const res = spawnSync(python, ["-m", "pytest", dir, "-q", "-p", "no:cacheprovider", "--continue-on-collection-errors", "-o", `pythonpath=${absolute}`, "--rootdir", dir, `--junit-xml=${junit}`], { cwd: repoPath, encoding: "utf8", timeout: 600_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const cases = fs.existsSync(junit) ? parseJunit(fs.readFileSync(junit, "utf8")) : [];
  const collectionErrors = new Map<string, string>();
  for (const c of cases) {
    // pytest reports a module that failed to import as one error case with an empty classname, named after the module.
    if (c.status === "error" && !c.classname) collectionErrors.set(moduleFile(c), (c.message ?? "collection error").slice(0, 300));
  }
  if (!cases.length && res.status !== 0) {
    for (const m of output.matchAll(/ERROR collecting .*?(test_[a-z0-9_]+\.py)/g)) collectionErrors.set(m[1]!, "collection error");
  }
  return { cases, collectionErrors, output };
}

/** The module a JUnit case belongs to, as a basename ending in .py. */
function moduleFile(c: JunitCase): string {
  const base = path.basename(c.file ?? c.name);
  return base.endsWith(".py") ? base : `${base}.py`;
}

function fileOf(c: JunitCase, dir: string): string {
  if (c.file) return path.basename(c.file);
  if (!c.classname) return moduleFile(c);
  const first = c.classname.split(".")[0] ?? "";
  const guess = `${first}.py`;
  return fs.existsSync(path.join(dir, guess)) ? guess : first;
}

/** Judge the modules at base: which are accepted, which rejected and why. */
export function judgeModules(files: Array<{ path: string; content: string }>, run: ReturnType<typeof runAtBase>, dir: string, expect: Expectation): { accepted: string[]; rejected: RejectedFile[]; statuses: TestStatus[] } {
  const statuses: TestStatus[] = [];
  const byFile = new Map<string, JunitCase[]>();
  for (const c of run.cases) {
    const f = fileOf(c, dir);
    byFile.set(f, [...(byFile.get(f) ?? []), c]);
    if (!run.collectionErrors.has(f)) statuses.push({ file: f, test: c.name, status: c.status, message: c.message ? c.message.slice(0, 200) : null });
  }
  const accepted: string[] = [];
  const rejected: RejectedFile[] = [];
  for (const f of files) {
    const reasons: string[] = [];
    if (!FILE_NAME.test(f.path)) reasons.push("file name must be a plain basename matching test_<name>.py");
    if (!f.content.trim()) reasons.push("empty module");
    const err = run.collectionErrors.get(f.path);
    const cases = (byFile.get(f.path) ?? []).filter((c) => !(c.status === "error" && (c.name.endsWith(".py") || !c.classname)));
    if (err) reasons.push(`the module could not be collected: ${err.split("\n").slice(-1)[0]}`);
    else if (!cases.length) reasons.push("no test was collected from the module");
    else if (expect === "fail" && !cases.some((c) => c.status === "failed" || c.status === "error")) reasons.push("every test passes at the current revision, so the module does not test the requested behaviour");
    else if (expect === "pass") {
      const failing = cases.filter((c) => c.status === "failed" || c.status === "error");
      if (failing.length) reasons.push(`${failing.length} test(s) fail at the current revision: ${failing.map((c) => `${c.name}${c.message ? ` (${c.message.split("\n")[0]?.slice(0, 120)})` : ""}`).join("; ")}`);
    }
    if (reasons.length) rejected.push({ path: f.path, reasons });
    else accepted.push(f.path);
  }
  return { accepted, rejected, statuses };
}

function header(a: { taskId: string; ticket: string; model: string | null; engine: string; threadId: string | null; head: string; expect: Expectation; statuses: TestStatus[]; covers: string[] }): string {
  const L = [`"""Acceptance tests for ${a.taskId}, written before implementation by ${a.model ?? a.engine} (IntentOS acceptance${a.threadId ? `, thread ${a.threadId}` : ""}).`, "", `Base revision ${a.head.slice(0, 10)}, ${nowIso()}. At that revision: ${a.statuses.map((s) => `${s.test} ${s.status}`).join(", ") || "no tests recorded"}.`, `Expectation: ${a.expect === "fail" ? "the requested behaviour does not exist yet; at least one test fails now and all pass once implemented" : "the behaviour already exists; all tests pass now"}.`, "Hidden from the implementer. Assert behaviour through public entry points so that any compliant implementation passes.", ""];
  if (a.covers.length) L.push("Covers:", ...a.covers.map((c) => `- ${c}`), "");
  L.push("Ticket:", ...a.ticket.trim().split("\n").map((l) => `    ${l}`), '"""', "");
  return L.join("\n");
}

function upsertTask(tasksFile: string, task: BenchmarkTask): void {
  const doc = fs.existsSync(tasksFile) ? (JSON.parse(fs.readFileSync(tasksFile, "utf8")) as { fixture?: string; tasks: BenchmarkTask[] }) : { tasks: [] };
  const i = doc.tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) doc.tasks[i] = { ...doc.tasks[i], ...task };
  else doc.tasks.push(task);
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  fs.writeFileSync(tasksFile, JSON.stringify(doc, null, 2) + "\n");
}

export async function writeAcceptanceTests(repoInput: string, ticket: string, opts: AcceptanceOptions, log: (line: string) => void = () => {}): Promise<AcceptanceResult> {
  const repoPath = path.resolve(repoInput);
  if (!fs.existsSync(repoPath) || !isGitRepo(repoPath)) throw new Error(`${repoPath} is not a Git repository`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.taskId)) throw new Error("task id must be a plain token (letters, digits, . _ -)");
  if (ticket.trim().length < 8) throw new Error("the ticket text is empty or too short");
  if (isDirty(repoPath)) log("warning: the repository working tree is dirty; tests run against the files as they are");
  const paths = ensureHome(resolvePaths());
  const policy = policyForRepo(repoPath) ?? fallbackPolicy(repoPath);
  const policyId = policy.policy_id.replace(/^fallback:/, "");
  const expect: Expectation = opts.expect ?? "fail";
  const head = headSha(repoPath);
  const agentConfig = captureAgentSnapshot();
  const role = agentConfig.roles.acceptance;
  const model = resolveAcceptanceModel(opts.model ?? role.model);
  const reasoning = opts.reasoningEffort ?? role.reasoning;
  if (!opts.engine && !model) throw new Error("no model named for the acceptance tests: pass --model <slug> (one the Codex account can run, other than the model that will implement) or set INTENTOS_ACCEPTANCE_MODEL");
  if (!opts.engine && model && agentConfig.roles.implementer.model === model) throw new Error("acceptance model must differ from the implementer model");
  const engine = opts.engine ?? new LiveCodexEngine({ model, reasoningEffort: reasoning });
  const hiddenRoot = path.resolve(opts.hiddenTestsRoot ?? paths.hiddenTests);
  const target = path.join(hiddenRoot, policyId, "tasks", opts.taskId);
  if (fs.existsSync(target) && fs.readdirSync(target).length && !opts.force) throw new Error(`${target} already has acceptance tests; pass --force to replace them`);
  const tasksFile = path.resolve(opts.tasksFile ?? path.join(PROJECT_ROOT, "benchmarks", "tasks.json"));
  const outDir = path.resolve(opts.outDir ?? path.join(paths.home, "acceptance", repoIdFor(repoPath), opts.taskId));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "agent_config.json"), JSON.stringify({ role: { ...role, model, reasoning }, captured_at: agentConfig.captured_at }, null, 2) + "\n");
  let pack: EvidencePack | null = null;
  if (opts.store) {
    try {
      pack = buildEvidencePack(opts.store, loadIndexedRepo(opts.store, repoPath), ticket);
    } catch (e) {
      log(`no evidence pack (${(e as Error).message.split("\n")[0]}); the model reads the repository without it`);
    }
  }
  const python = repoInterpreter(repoPath);
  const pythonpath = pythonpathFor(policy);
  const maxRounds = Math.max(1, Math.min(opts.rounds ?? 2, 4));
  let prompt = appendRoleSkills(buildAcceptancePrompt({ repoPath, policyId, taskId: opts.taskId, ticket, expect, pack, pythonpath }), role);
  let threadId: string | null = null;
  let resolvedModel: string | null = model;
  let engineName = engine.name;
  const rounds: AcceptanceRound[] = [];
  const kept = new Map<string, { path: string; content: string; covers: string[] }>();
  const keptStatuses = new Map<string, TestStatus[]>();
  let notes = "";
  let lastRejected: RejectedFile[] = [];
  for (let round = 1; round <= maxRounds; round++) {
    fs.writeFileSync(path.join(outDir, `prompt-${round}.txt`), prompt);
    log(`round ${round}: asking ${model ?? engine.name} for the acceptance tests…`);
    const res = await engine.plan({ cwd: repoPath, prompt, outputSchema: ACCEPTANCE_SCHEMA, threadId, onThreadStarted: (id) => { threadId = id; } });
    threadId = res.threadId ?? threadId;
    resolvedModel = res.model ?? resolvedModel;
    engineName = res.engine;
    fs.writeFileSync(path.join(outDir, `round-${round}.json`), res.text);
    const answer = parseAnswer(res.text);
    if (answer.notes) notes = answer.notes;
    if (!answer.files.length) {
      rounds.push({ round, proposed: 0, accepted: 0, rejected: [], usage: res.usage });
      log(`round ${round}: no modules returned`);
      break;
    }
    const roundDir = path.join(outDir, `round-${round}`, "tests");
    fs.mkdirSync(roundDir, { recursive: true });
    for (const f of answer.files) if (FILE_NAME.test(f.path)) fs.writeFileSync(path.join(roundDir, f.path), f.content);
    const run = runAtBase(repoPath, roundDir, python, pythonpath);
    fs.writeFileSync(path.join(outDir, `round-${round}`, "pytest.log"), run.output);
    const verdict = judgeModules(answer.files, run, roundDir, expect);
    for (const p of verdict.accepted) {
      kept.set(p, answer.files.find((f) => f.path === p)!);
      keptStatuses.set(p, verdict.statuses.filter((s) => s.file === p));
    }
    rounds.push({ round, proposed: answer.files.length, accepted: verdict.accepted.length, rejected: verdict.rejected, usage: res.usage });
    lastRejected = verdict.rejected;
    log(`round ${round}: ${answer.files.length} module(s), ${verdict.accepted.length} accepted${verdict.rejected.length ? `, ${verdict.rejected.length} rejected: ${verdict.rejected.map((r) => `${r.path} (${r.reasons[0]})`).join("; ")}` : ""}`);
    if (!verdict.rejected.length) break;
    prompt = appendRoleSkills(buildAcceptanceFixPrompt(verdict.rejected, expect), role);
  }
  if (!kept.size) throw new Error(`no acceptance module survived the check at ${head.slice(0, 10)}${lastRejected.length ? `: ${lastRejected.map((r) => `${r.path}: ${r.reasons.join(" | ")}`).join("; ")}` : ""}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const written: string[] = [];
  const statuses: TestStatus[] = [];
  for (const [p, f] of kept) {
    const st = keptStatuses.get(p) ?? [];
    statuses.push(...st);
    const file = path.join(target, p);
    fs.writeFileSync(file, header({ taskId: opts.taskId, ticket, model: resolvedModel, engine: engineName, threadId, head, expect, statuses: st, covers: f.covers }) + f.content.trimEnd() + "\n");
    written.push(path.relative(PROJECT_ROOT, file).split(path.sep).join("/"));
  }
  const authored = { task_id: opts.taskId, policy_id: policyId, repo_path: repoPath, base: head, expect, model: resolvedModel, engine: engineName, thread_id: threadId, written_at: nowIso(), files: written, rounds, notes };
  fs.writeFileSync(path.join(target, "AUTHORED.json"), JSON.stringify(authored, null, 2) + "\n");
  const firstLine = ticket.trim().split("\n")[0]!.trim();
  const task: BenchmarkTask = { id: opts.taskId, fixture: policyId, title: firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine, request: ticket.trim(), expected_route: opts.expectedRoute ?? (expect === "pass" ? "abstain" : "implement"), hidden_tests: path.relative(PROJECT_ROOT, target).split(path.sep).join("/"), hazards: [], offline_patches: {}, notes: `acceptance tests by ${resolvedModel ?? engineName} at ${head.slice(0, 10)} (${authored.written_at}); ${expect === "fail" ? "fail at base, pass when solved" : "pass at base"}` };
  upsertTask(tasksFile, task);
  const result: AcceptanceResult = { repo_path: repoPath, policy_id: policyId, task_id: opts.taskId, head, expect, model: resolvedModel, engine: engineName, thread_id: threadId, rounds, files: written, dir: target, tasks_file: tasksFile, statuses, notes };
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  log(`written: ${written.length} module(s) in ${target}; bound as task ${opts.taskId} in ${path.relative(PROJECT_ROOT, tasksFile)}`);
  return result;
}

/** Tickets from a YAML list (benchmarks/demandlib/tickets.yaml shape): id, issue, expected_route. */
export function loadTicketFile(file: string): Array<{ id: string; title: string; issue: string; expected_route: BenchmarkTask["expected_route"] }> {
  const data = YAML.parse(fs.readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
  if (!Array.isArray(data)) throw new Error(`${file} is not a list of tickets`);
  return data.map((t) => ({ id: String(t.id), title: String(t.title ?? ""), issue: String(t.issue ?? ""), expected_route: (t.expected_route as BenchmarkTask["expected_route"]) ?? "implement" }));
}

/** What a ticket's expected route means for its tests: new behaviour fails now, an already-done ticket passes now, a vague one has none. */
export function expectationFor(route: BenchmarkTask["expected_route"]): Expectation | null {
  if (route === "implement") return "fail";
  if (route === "abstain") return "pass";
  return null;
}

export { loadBenchmarkTasks, os };
