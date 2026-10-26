import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureHome, resolvePaths, resolvePython } from "./config.ts";
import type { KnowledgeStore } from "./knowledge/storage.ts";
import { indexRepository, repoIdFor, type IndexSummary } from "./knowledge/indexer.ts";
import { loadPolicyFile, type Policy } from "./knowledge/policy.ts";
import { repoInterpreter, repoVenvDir } from "./knowledge/venv.ts";
import { isGitRepo } from "./util/git.ts";
import { parseJunit } from "./verification/junit.ts";
import { nowIso } from "./util/ids.ts";

/**
 * `intentos onboard <repo>`: the mechanical part of bringing a repository under IntentOS.
 * It probes the repository (read-only), creates a per-repository venv with the declared dependencies and pytest,
 * writes a DRAFT policy whose invariants/rules/decisions are empty on purpose, runs the project suite once at the
 * base revision so later failures are attributable, and indexes the repository.
 * Nothing it writes carries authority: a person fills in and approves the policy.
 */

export interface ProbeResult {
  repo: string;
  name: string | null;
  requires_python: string | null;
  dependencies: string[];
  test_dependencies: string[];
  dependency_sources: string[];
  layout: "src" | "flat";
  packages: string[];
  package_dirs: string[];
  /** Paths pytest is pointed at (from the repository's testpaths, else detected test directories). */
  test_paths: string[];
  /** The subset of test_paths that are test directories (tests/, test/, …) rather than doctest roots such as src/ or docs/. */
  test_dirs: string[];
  has_conftest: boolean;
  pytest: { source: string | null; testpaths: string[]; pythonpath: string[]; addopts: string | null; tox_pythonpath: string[] };
  pythonpath: string[];
  docs: { dirs: string[]; markdown: string[]; rst: string[] };
  protected_candidates: string[];
  warnings: string[];
}

export interface OnboardOptions {
  /** Policy id (defaults to the sanitised project name, else the folder name). */
  policyId?: string;
  /** Interpreter used to create the venv (or used directly with `install: false`). Default: the project venv. */
  python?: string;
  /** Create `.intentos/venvs/<repo-id>` and pip-install pytest + declared dependencies. */
  install: boolean;
  /** Run the drafted test command once at the base revision. */
  test: boolean;
  /** Index the repository afterwards. */
  index: boolean;
  /** Overwrite an existing policy file. */
  force: boolean;
  /** Policy file path (default `policies/<policy-id>.yaml`). */
  out?: string;
}

export interface SmokeResult {
  status: "passed" | "failed" | "error" | "timeout" | "skipped";
  summary: string;
  tests_passed: number | null;
  tests_failed: number | null;
  argv: string[] | null;
  log_path: string | null;
  duration_ms: number;
}

export interface OnboardResult {
  repo_path: string;
  repo_id: string;
  policy_id: string;
  policy_file: string;
  policy_in_policies_dir: boolean;
  interpreter: string;
  venv: string | null;
  installed: string[] | null;
  install_log: string | null;
  probe: ProbeResult;
  smoke: SmokeResult;
  index: IndexSummary | null;
  warnings: string[];
  next_steps: string[];
}

export function runProbe(repoPath: string): ProbeResult {
  const script = path.join(resolvePaths().python, "onboard_probe.py");
  const res = spawnSync(resolvePython(), ["-I", script, repoPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  if (res.error) throw new Error(`onboard probe failed to start: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`onboard probe exited ${res.status}: ${(res.stderr ?? "").trim()}`);
  return JSON.parse(res.stdout) as ProbeResult;
}

export function policyIdFor(probe: ProbeResult, repoPath: string, override?: string): string {
  const raw = override ?? probe.name ?? path.basename(path.resolve(repoPath));
  const id = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!id) throw new Error(`cannot derive a policy id from ${JSON.stringify(raw)}`);
  return id;
}

const yq = (s: string): string => JSON.stringify(s);
const yList = (items: string[], indent = "  "): string => (items.length ? items.map((i) => `${indent}- ${yq(i)}`).join("\n") : `${indent}[]`);

/** Render the draft policy as commented YAML (comments are the onboarding guidance; the file must parse under PolicySchema). */
export function renderDraftPolicy(probe: ProbeResult, repoPath: string, policyId: string): string {
  const basename = path.basename(path.resolve(repoPath));
  const norm = (p: string): string => path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "").replace(/\/+$/, "");
  const testPaths = [...new Set(probe.test_paths.map(norm).filter((p) => p && p !== "."))];
  const testDirs = [...new Set((probe.test_dirs ?? testPaths).map(norm).filter((p) => p && p !== "."))];
  const protectedPaths = [...new Set(probe.protected_candidates.map(norm))];
  const isProtected = (glob: string) => protectedPaths.includes(glob);
  const allowed = [...new Set([...(probe.layout === "src" ? ["src/**"] : probe.package_dirs.map((d) => `${norm(d)}/**`)), ...testDirs.map((t) => `${t}/**`)])].filter((g) => !isProtected(g));
  if (!allowed.length) allowed.push("**");
  const scopeTags = [...probe.package_dirs.map((d) => ({ glob: `${norm(d)}/**`, tags: [path.basename(d).toLowerCase().replace(/[^a-z0-9_]+/g, "_")] })), ...testDirs.map((t) => ({ glob: `${t}/**`, tags: ["tests"] }))];
  const pythonpath = probe.pythonpath.length ? probe.pythonpath : ["."];
  const argv = ["{python}", "-m", "pytest", ...testPaths, "-q", "-p", "no:cacheprovider", "-o", `pythonpath=${pythonpath.join(" ")}`, "--junit-xml={junit}"];
  const docsHint = probe.docs.markdown.length ? `Markdown documents the indexer can bind: ${probe.docs.markdown.slice(0, 5).join(", ")}${probe.docs.markdown.length > 5 ? ", …" : ""}` : "No Markdown documents found: add e.g. docs/intentos-policy.md with one heading per rule (reStructuredText is not indexed).";
  const L: string[] = [];
  L.push(`schema_version: "1.0"`);
  L.push(`policy_id: ${policyId}`);
  L.push(`description: >`);
  L.push(`  DRAFT generated by \`intentos onboard\` on ${nowIso().slice(0, 10)} for ${basename}. Commands and path lists were`);
  L.push(`  derived from the repository layout (${probe.layout} layout; packages: ${probe.packages.join(", ") || "none detected"}).`);
  L.push(`  Invariants, architecture rules and decisions are empty on purpose: they carry authority in every run and must`);
  L.push(`  be written and approved by a person. See docs/policies.md.`);
  L.push(`applies_to:`);
  if (probe.name) L.push(`  project_name: ${yq(probe.name)}`);
  L.push(`  path_basename: ${yq(basename)}`);
  L.push(``);
  L.push(`# Globs the implementer may edit (the planner narrows these per task) and globs it must never edit.`);
  L.push(`default_allowed_paths:`);
  L.push(yList(allowed));
  L.push(`protected_paths:`);
  L.push(yList(probe.protected_candidates));
  L.push(``);
  L.push(`# Tags by path glob: decide which invariants/rules apply to a task and help retrieval. Refine the tags.`);
  L.push(`scope_tags:`);
  if (scopeTags.length) for (const s of scopeTags) L.push(`  ${yq(s.glob)}: [${s.tags.join(", ")}]`);
  else L.push(`  {}`);
  L.push(``);
  L.push(`# Task-term synonyms to help lexical retrieval, e.g. { invoice: [invoices, billing] }.`);
  L.push(`synonyms: {}`);
  L.push(``);
  L.push(`# Trusted verification commands. argv placeholders: {python} {snapshot} {hidden_tests_dir} {junit}.`);
  L.push(`# Verification runs from a snapshot copy of the implementer's worktree, so tests must import the code via`);
  L.push(`# pythonpath (never an editable install of your clone). pytest also reads the repository's own configuration`);
  L.push(`# from the snapshot${probe.pytest.source ? ` (${probe.pytest.source}${probe.pytest.addopts ? `, addopts ${JSON.stringify(probe.pytest.addopts.trim().split(/\s+/).join(" "))}` : ""})` : ""}; the implementer can edit that file, so pin anything that must not change here (e.g. "-o", "addopts=").`);
  L.push(`commands:`);
  L.push(`  pytest_project:`);
  L.push(`    description: Project test suite from the verification snapshot (editable by the implementer; lower authority than hidden tests)`);
  L.push(`    track: functional`);
  L.push(`    argv: [${argv.map(yq).join(", ")}]`);
  L.push(`    timeout_s: 900`);
  L.push(`  scope_check:`);
  L.push(`    description: Changed files must stay inside allowed paths and outside protected paths`);
  L.push(`    track: scope`);
  L.push(`    builtin: scope_check`);
  L.push(`  architecture_rules:`);
  L.push(`    description: Deterministic AST checks for the approved architecture rules below`);
  L.push(`    track: architecture`);
  L.push(`    builtin: architecture_rules`);
  L.push(`  architecture_surprise:`);
  L.push(`    description: Architectural-surprise review signals (new cross-module dependencies, duplicate helpers, domain construction in the API layer); advisory`);
  L.push(`    track: architecture`);
  L.push(`    builtin: architecture_surprise`);
  L.push(`    enforcement: advisory`);
  L.push(``);
  L.push(`# Business invariants: approved statements whose sources are Markdown sections in the repository and whose hidden`);
  L.push(`# tests live in benchmarks/hidden_tests/${policyId}/invariants/ (outside the implementer's reach).`);
  L.push(`# ${docsHint}`);
  L.push(`# Example:`);
  L.push(`#   - id: INV-001`);
  L.push(`#     statement: <one sentence a reviewer can verify>`);
  L.push(`#     scope: [${scopeTags[0]?.tags[0] ?? "core"}]`);
  L.push(`#     applies_to_paths: [${yq(allowed[0]!)}]`);
  L.push(`#     authority: approved_policy`);
  L.push(`#     approved_by: <owner>`);
  L.push(`#     sources: [{ path: docs/intentos-policy.md, heading: <section heading> }]`);
  L.push(`#     verified_by: [benchmarks/hidden_tests/${policyId}/invariants/test_inv_001_<name>.py]`);
  L.push(`invariants: []`);
  L.push(``);
  L.push(`# Deterministic architecture rules: forbidden_import | forbidden_call | frozen_paths | required_import | forbidden_names.`);
  L.push(`# Example:`);
  L.push(`#   - id: ARCH-001`);
  L.push(`#     kind: forbidden_import`);
  L.push(`#     statement: Library code must not talk to the network or spawn processes.`);
  L.push(`#     paths: [${yq(allowed[0]!)}]`);
  L.push(`#     forbidden_modules: [requests, urllib, httpx, socket, subprocess]`);
  L.push(`#     authority: approved_policy`);
  L.push(`#     approved_by: <owner>`);
  L.push(`architecture_rules: []`);
  L.push(``);
  L.push(`# Architectural decisions (ADR-style): id DEC-nnn, statement, status approved|superseded|proposed|rejected, sources.`);
  L.push(`decisions: []`);
  L.push(``);
  L.push(`# Architectural-surprise detectors (advisory). Fill api_paths/domain_paths when the repository has such layers.`);
  L.push(`architecture_surprise:`);
  L.push(`  api_paths: []`);
  L.push(`  domain_paths: []`);
  L.push(`  ignore_names: []`);
  L.push(``);
  return L.join("\n");
}

export function minimalEnv(): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? os.homedir(), PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0", LANG: "C.UTF-8" };
}

function firstLine(s: string | null | undefined): string {
  return (s ?? "").trim().split("\n")[0] ?? "";
}

function lastLine(s: string | null | undefined): string {
  const lines = (s ?? "").trim().split("\n").filter(Boolean);
  return (lines[lines.length - 1] ?? "").replace(/=+/g, "").trim();
}

/** Create the per-repository venv and install pytest plus the declared dependencies (never the package itself). */
function createVenv(repoPath: string, probe: ProbeResult, basePython: string, logDir: string): { venv: string; interpreter: string; installed: string[]; log: string; warnings: string[] } {
  const warnings: string[] = [];
  const venv = repoVenvDir(repoPath);
  const interpreter = path.join(venv, "bin", "python");
  const log = path.join(logDir, "install.log");
  const chunks: string[] = [];
  if (!fs.existsSync(interpreter)) {
    fs.mkdirSync(path.dirname(venv), { recursive: true });
    const r = spawnSync(basePython, ["-m", "venv", venv], { encoding: "utf8", env: minimalEnv(), timeout: 300_000 });
    chunks.push(`$ ${basePython} -m venv ${venv}\n${r.stdout ?? ""}${r.stderr ?? ""}`);
    if (r.error || r.status !== 0) {
      fs.writeFileSync(log, chunks.join("\n"));
      throw new Error(`could not create venv at ${venv}: ${r.error?.message ?? firstLine(r.stderr) ?? `exit ${r.status}`}`);
    }
  }
  const specs = ["pytest", ...probe.dependencies, ...probe.test_dependencies];
  const r2 = spawnSync(interpreter, ["-m", "pip", "install", "-q", "--disable-pip-version-check", ...specs], { encoding: "utf8", env: minimalEnv(), timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  chunks.push(`$ ${interpreter} -m pip install ${specs.join(" ")}\n${r2.stdout ?? ""}${r2.stderr ?? ""}`);
  fs.writeFileSync(log, chunks.join("\n"));
  if (r2.error || r2.status !== 0) warnings.push(`pip install failed (${r2.error?.message ?? `exit ${r2.status}`}): see ${log}; install the dependencies into ${interpreter} by hand`);
  return { venv, interpreter, installed: specs, log, warnings };
}

/** Run the drafted test command once against the base revision (not a snapshot) so later failures are attributable. */
function smokeTest(policy: Policy, repoPath: string, interpreter: string, logDir: string): SmokeResult {
  const cmd = policy.commands.pytest_project;
  if (!cmd?.argv) return { status: "skipped", summary: "no pytest_project command", tests_passed: null, tests_failed: null, argv: null, log_path: null, duration_ms: 0 };
  const junit = path.join(logDir, "smoke.junit.xml");
  const logPath = path.join(logDir, "smoke.log");
  const argv = cmd.argv.map((a) => a.replace("{python}", interpreter).replace("{snapshot}", repoPath).replace("{hidden_tests_dir}", path.join(logDir, "no-hidden-tests")).replace("{junit}", junit));
  const t0 = Date.now();
  const res = spawnSync(argv[0]!, argv.slice(1), { cwd: repoPath, env: minimalEnv(), encoding: "utf8", timeout: cmd.timeout_s * 1000, maxBuffer: 64 * 1024 * 1024 });
  const duration = Date.now() - t0;
  fs.writeFileSync(logPath, `$ ${argv.join(" ")}\n(cwd ${repoPath})\n\n${res.stdout ?? ""}\n${res.stderr ?? ""}`);
  const cases = fs.existsSync(junit) ? parseJunit(fs.readFileSync(junit, "utf8")) : [];
  const passed = cases.filter((c) => c.status === "passed").length;
  const failedCases = cases.filter((c) => c.status === "failed" || c.status === "error");
  const failed = failedCases.length;
  const failedNames = failedCases.slice(0, 5).map((c) => `${c.classname}::${c.name}`).join(", ") + (failed > 5 ? ", …" : "");
  let status: SmokeResult["status"];
  let summary: string;
  if (res.error && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    status = "timeout";
    summary = `timed out after ${cmd.timeout_s}s`;
  } else if (res.error) {
    status = "error";
    summary = `failed to start: ${res.error.message}`;
  } else if (res.status === 0 && cases.length) {
    status = "passed";
    summary = lastLine(res.stdout);
  } else if (res.status === 5 || (res.status === 0 && !cases.length)) {
    status = "failed";
    summary = "no tests collected: check testpaths/pythonpath in the drafted command";
  } else {
    status = "failed";
    summary = `${lastLine(res.stdout) || lastLine(res.stderr) || `exit ${res.status}`}${failed ? ` — failing: ${failedNames}` : ""}`;
  }
  return { status, summary, tests_passed: passed, tests_failed: failed, argv, log_path: logPath, duration_ms: duration };
}

export function onboardRepository(store: KnowledgeStore, repoInput: string, opts: OnboardOptions, log: (line: string) => void = () => {}): OnboardResult {
  const repoPath = path.resolve(repoInput);
  if (!fs.existsSync(repoPath) || !isGitRepo(repoPath)) throw new Error(`${repoPath} is not a Git repository`);
  const paths = ensureHome(resolvePaths());
  const repoId = repoIdFor(repoPath);
  const warnings: string[] = [];

  log(`probing ${repoPath}…`);
  const probe = runProbe(repoPath);
  warnings.push(...probe.warnings.map((w) => `probe: ${w}`));
  const policyId = policyIdFor(probe, repoPath, opts.policyId);
  const logDir = path.join(paths.home, "onboard", repoId);
  fs.mkdirSync(logDir, { recursive: true });

  // 1. Environment: a per-repository venv with the declared dependencies, never the package itself.
  let venv: string | null = null;
  let installed: string[] | null = null;
  let installLog: string | null = null;
  let interpreter: string;
  if (opts.install) {
    const base = opts.python ?? resolvePython(paths);
    log(`creating venv for ${repoId} and installing ${1 + probe.dependencies.length + probe.test_dependencies.length} package(s): pytest${probe.dependencies.length ? ", " + probe.dependencies.join(", ") : ""}${probe.test_dependencies.length ? ", " + probe.test_dependencies.join(", ") : ""}`);
    const created = createVenv(repoPath, probe, base, logDir);
    venv = created.venv;
    installed = created.installed;
    installLog = created.log;
    interpreter = created.interpreter;
    warnings.push(...created.warnings);
  } else {
    interpreter = opts.python ?? repoInterpreter(repoPath, paths);
    if (probe.dependencies.length) warnings.push(`dependencies not installed (--no-install): ${probe.dependencies.join(", ")} must be importable from ${interpreter}`);
  }

  // 2. Draft policy.
  const policyFile = path.resolve(opts.out ?? path.join(paths.policies, `${policyId}.yaml`));
  if (fs.existsSync(policyFile) && !opts.force) throw new Error(`${policyFile} exists; pass --force to overwrite the draft`);
  fs.mkdirSync(path.dirname(policyFile), { recursive: true });
  fs.writeFileSync(policyFile, renderDraftPolicy(probe, repoPath, policyId));
  const policy = loadPolicyFile(policyFile); // validates the draft against PolicySchema
  const inPoliciesDir = path.dirname(policyFile) === path.resolve(paths.policies);
  if (!inPoliciesDir) warnings.push(`policy written outside ${paths.policies}; index/run will use the fallback policy until it is moved there`);
  log(`draft policy written: ${policyFile}`);

  // 3. Smoke-run the project suite at the base revision.
  let smoke: SmokeResult = { status: "skipped", summary: "skipped (--no-test)", tests_passed: null, tests_failed: null, argv: null, log_path: null, duration_ms: 0 };
  if (opts.test) {
    log(`running the project suite once with ${interpreter}…`);
    smoke = smokeTest(policy, repoPath, interpreter, logDir);
    log(`suite ${smoke.status}: ${smoke.summary}`);
    if (smoke.status !== "passed") warnings.push(`project suite did not pass at the base revision (${smoke.status}: ${smoke.summary}); fix the environment or the drafted command before running tasks`);
  }

  // 4. Index.
  let index: IndexSummary | null = null;
  if (opts.index) {
    log("indexing…");
    index = indexRepository(store, repoPath);
  }

  const next = [
    `review and edit ${policyFile}: allowed/protected paths, scope tags, then add invariants (with Markdown sources + hidden tests) and architecture rules`,
    `intentos explain ${repoPath} "<task>"   # free: check the evidence pack before spending Codex tokens`,
    `intentos run ${repoPath} "<task>" --require-approval   # fallback-free run; ends HUMAN_REVIEW at best until invariants/hidden tests exist`,
  ];
  if (!inPoliciesDir) next.unshift(`move ${policyFile} to ${path.join(paths.policies, `${policyId}.yaml`)} and re-run intentos index ${repoPath}`);
  return { repo_path: repoPath, repo_id: repoId, policy_id: policyId, policy_file: policyFile, policy_in_policies_dir: inPoliciesDir, interpreter, venv, installed, install_log: installLog, probe, smoke, index, warnings, next_steps: next };
}
