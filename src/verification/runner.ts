import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fillArgv, fillEnv, type CommandVars, type Policy, type PolicyCommand } from "../knowledge/policy.ts";
import { isJsTestFile, linkNodeModules, writeVitestWrapperConfig } from "../knowledge/js.ts";
import type { ChangeContract } from "../contracts/schemas.ts";
import type { EvidencePack } from "../knowledge/retrieval.ts";
import { changedFiles, diffAgainstBase, workingTreeFiles, headSha } from "../util/git.ts";
import { ensureDir } from "../util/paths.ts";
import { resolvePaths } from "../config.ts";
import { parseJunit } from "./junit.ts";
import { runArchitectureRules, runScopeCheck } from "./policy.ts";
import { runArchitecturalSurprise } from "./surprise.ts";
import { precedentFindings } from "./precedents.ts";
import { repoInterpreter } from "../knowledge/venv.ts";
import { generateCounterexamples } from "./counterexamples.ts";
import { summarizeStatus, type CommandRecord, type CoordinationSummary, type Finding, type VerificationResult } from "./results.ts";
import { nowIso } from "../util/ids.ts";
import { syncCheck, type CoordinationEnv } from "../coordination/mergeguard.ts";
import { containerName, dockerClientEnv, dockerPreflight, dockerSettings, killContainer, planCommand, verifierMode, type DockerSettings, type VerifierMode } from "./sandbox.ts";

export interface VerifyInput {
  runId: string;
  attempt: number;
  worktree: string;
  baseSha: string;
  contract: ChangeContract;
  contractHash: string;
  policy: Policy;
  pack: EvidencePack;
  outDir: string;
  /** Directory with hidden task acceptance tests (outside the worktree), or null. */
  hiddenTaskTestsDir: string | null;
  /** Directory with hidden invariant tests (outside the worktree), or null. */
  hiddenInvariantTestsDir: string | null;
  /** codex_events.jsonl of the run (scanned for reads of protected artifacts), or null. */
  eventsFile?: string | null;
  /** Repository used to read base-revision sources (defaults to the worktree, which shares the object store). */
  repoPath?: string;
  simulated: boolean;
  /** mergeguard coordination environment; when set, a tree stale against main is a blocking finding. */
  coordination?: CoordinationEnv | null;
  /** HEAD the worktree is expected at when it is not the base (a merged-result candidate on top of main). */
  expectedHead?: string;
}

/**
 * mergeguard's sync check as a verification track: the working tree's uses of symbols that main renamed, moved,
 * removed or re-signed since the run's base are blocking findings carrying the note the agent would have received.
 * The review tier of the diff is recorded separately by `intentos merge`, where head and base are commits.
 */
export function coordinationTrack(coord: CoordinationEnv, worktree: string): { summary: CoordinationSummary; findings: Finding[]; record: CommandRecord } {
  const t0 = Date.now();
  const findings: Finding[] = [];
  let summary: CoordinationSummary;
  try {
    const sync = syncCheck(coord, worktree);
    summary = { main_branch: coord.mainBranch, main: sync.main, base: sync.base, stale: !sync.clean, issues: sync.issues, tier: null, reasons: [], proofs: {}, error: null };
    sync.issues.forEach((issue, i) => {
      findings.push({ id: `F-SYNC-${String(i + 1).padStart(3, "0")}`, category: "coordination", severity: "blocking", rule_id: "SYNC-STALE", source_evidence_ids: [], test: null, expected: `code on ${coord.mainBranch} (${sync.main.slice(0, 10)}): ${issue.symbol} ${issue.change.replace("_", " ")}${issue.new ? ` to ${issue.new}` : ""}`, observed: `used at ${issue.used_in.join(", ")}`, message: issue.message, location: issue.used_in[0] ?? null, log_path: null, authority: "deterministic" });
    });
  } catch (err) {
    const message = (err as Error).message;
    summary = { main_branch: coord.mainBranch, main: "", base: "", stale: false, issues: [], tier: null, reasons: [], proofs: {}, error: message };
    findings.push({ id: "F-SYNC-ERROR", category: "coordination", severity: "review", rule_id: "SYNC-CHECK-ERROR", source_evidence_ids: [], test: null, expected: "mergeguard sync check ran", observed: message.slice(0, 300), message: `coordination check could not run: ${message.slice(0, 200)}`, location: null, log_path: null, authority: "deterministic" });
  }
  const record: CommandRecord = { command_id: "sync_check", track: "coordination", enforcement: "blocking", argv: null, builtin: "sync_check", exit_code: null, duration_ms: Date.now() - t0, status: summary.error ? "error" : summary.stale ? "failed" : "passed", stdout_path: null, stderr_path: null, summary: summary.error ? summary.error.slice(0, 160) : summary.stale ? `${summary.issues.length} symbol(s) this tree uses changed on ${coord.mainBranch} since the run's base` : `up to date with ${coord.mainBranch} ${summary.main.slice(0, 10)}`, tests_passed: null, tests_failed: null };
  return { summary, findings, record };
}

/**
 * Test names discovered statically in a directory of trusted hidden tests: `def test_*` in pytest files, and the string
 * titles of `it(`/`test(` blocks in vitest/jest files (`*.test.ts`, `*.spec.ts`, …).
 */
export function discoverTestNames(dir: string): Set<string> {
  const names = new Set<string>();
  if (!fs.existsSync(dir)) return names;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p);
      } else if (/^test_.*\.py$/.test(e.name)) {
        for (const m of fs.readFileSync(p, "utf8").matchAll(/^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/gm)) names.add(m[1]!);
      } else if (isJsTestFile(e.name)) {
        for (const m of fs.readFileSync(p, "utf8").matchAll(/^\s*(?:it|test)(?:\.(?:only|skip|concurrent|fails))*\s*\(\s*(['"`])((?:(?!\1).)+)\1/gm)) if (!m[2]!.includes("${")) names.add(m[2]!);
      }
    }
  };
  walk(dir);
  return names;
}

/** The leaf test name as the inventory check compares it: pytest parameters (`[...]`) and vitest `describe > ` prefixes removed. */
export const leafTestName = (name: string): string => (name.includes(" > ") ? name.split(" > ").pop()! : name).replace(/\[.*$/, "");

/** The vitest wrapper config hidden tests run with (see `writeVitestWrapperConfig`). */
export const writeHiddenVitestConfig = (snapshot: string, hiddenDir: string): string => writeVitestWrapperConfig(snapshot, hiddenDir);

const PROTECTED_ARTIFACT_PATTERNS = [/hidden_tests/i, /\bpolicies\//, /\.intentos\/runs/, /\.intentos_hidden/, /benchmarks\//, /intentos\.db/];

/** Scan recorded Codex commands/file changes for attempts to read or write protected artifacts (detection, not prevention). */
export function scanProtectedAccess(eventsFile: string | null | undefined): Finding[] {
  if (!eventsFile || !fs.existsSync(eventsFile)) return [];
  const findings: Finding[] = [];
  let n = 0;
  for (const line of fs.readFileSync(eventsFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: { phase?: string; payload?: { type?: string; item?: { type?: string; command?: string; changes?: Array<{ path: string }> } } };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev.phase || ev.phase === "plan") continue;
    const item = ev.payload?.item;
    if (ev.payload?.type !== "item.completed" || !item) continue;
    const texts: string[] = [];
    if (item.type === "command_execution" && item.command) texts.push(item.command);
    if (item.type === "file_change") for (const c of item.changes ?? []) texts.push(c.path);
    for (const t of texts) {
      if (PROTECTED_ARTIFACT_PATTERNS.some((re) => re.test(t))) {
        findings.push({ id: `F-ACCESS-${String(++n).padStart(3, "0")}`, category: "process", severity: "review", rule_id: "PROTECTED-ARTIFACT-ACCESS", source_evidence_ids: [], test: null, expected: "implementer confined to the worktree", observed: t.slice(0, 300), message: `implementer ${item.type === "file_change" ? "wrote" : "ran a command referencing"} a protected artifact: ${t.slice(0, 160)}`, location: null, log_path: eventsFile, authority: "deterministic" });
        if (n >= 20) return findings;
      }
    }
  }
  return findings;
}

/**
 * Independent verification. Never consults the implementer's claims: it snapshots the
 * worktree, copies protected hidden tests next to it, runs only trusted allowlisted
 * commands, and derives status purely from observed results.
 */
export function verifyWorktree(input: VerifyInput): VerificationResult {
  const startedAt = nowIso();
  const attemptDir = ensureDir(path.join(input.outDir, `attempt-${input.attempt}`));
  const snapshot = ensureDir(path.join(attemptDir, "snapshot"));
  const findings: Finding[] = [];
  const commands: CommandRecord[] = [];
  // Interpreter for commands that execute the candidate's tests: INTENTOS_PYTHON, else the repository's onboarded venv, else the project venv.
  const python = repoInterpreter(input.repoPath ?? null);
  // Executing commands run on the host or in the verifier container; static builtins always run on the host.
  const mode = verifierMode();
  const docker = mode === "docker" ? (() => { const settings = dockerSettings(); return { settings, preflight: dockerPreflight(settings) }; })() : null;
  const unavailable = !!docker && !docker.preflight.ok;
  const limitations: string[] = [];
  if (!docker) {
    limitations.push("Verification runs the candidate code on the host (no container isolation); use only trusted fixture repositories.");
    limitations.push("Network access during verification is not technically blocked; architecture rules forbid network libraries statically.");
  } else if (docker.preflight.ok) {
    limitations.push(`verifier: mode docker, image ${docker.settings.image} (${docker.preflight.imageDigest ?? "digest unknown"}); executing commands ran in a container (snapshot read-only, no network, cpus ${docker.settings.cpus}, memory ${docker.settings.memory}, pids ${docker.settings.pidsLimit}); static builtins ran on the host. Docker's default seccomp profile applies and the host kernel is shared.`);
  } else {
    limitations.push(`verifier: mode docker but unavailable (${docker.preflight.reason}); executing commands were NOT run and blocking ones failed closed — no host fallback.`);
  }
  const execContext = (commandId: string): ExecContext => ({ mode, container: docker && docker.preflight.ok ? { name: containerName(input.runId, commandId, input.attempt), settings: docker.settings, resultsDir: attemptDir, hiddenDir: path.join(snapshot, ".intentos_hidden"), python } : null });
  const unavailableRecord = (commandId: string, cmd: PolicyCommand): CommandRecord => ({ command_id: commandId, track: cmd.track, enforcement: cmd.enforcement, argv: null, builtin: cmd.builtin ?? null, exit_code: null, duration_ms: 0, status: "error", stdout_path: null, stderr_path: null, summary: `not executed: container verifier unavailable (${docker?.preflight.reason ?? "docker unavailable"})`, tests_passed: null, tests_failed: null });
  if (input.simulated) limitations.push("Implementation was produced by the simulated offline engine; results measure the orchestration path, not agent performance.");

  // Integrity: the worktree must still be at the base revision (implementer must not commit).
  const wtHead = headSha(input.worktree);
  if (wtHead !== (input.expectedHead ?? input.baseSha)) {
    findings.push({ id: "F-INTEGRITY-001", category: "process", severity: "blocking", rule_id: "WORKTREE-HEAD", source_evidence_ids: [], test: null, expected: input.expectedHead ?? input.baseSha, observed: wtHead, message: "worktree HEAD moved from the base revision (implementer committed or rebased)", location: null, log_path: null, authority: "deterministic" });
  }

  // Changes & scope
  const changed = changedFiles(input.worktree, input.baseSha);
  const diffText = diffAgainstBase(input.worktree, input.baseSha);
  fs.writeFileSync(path.join(attemptDir, "diff.patch"), diffText);
  const scope = runScopeCheck(changed, input.contract, diffText);
  const wantsScope = input.contract.verification.some((v) => input.policy.commands[v.command_id]?.builtin === "scope_check");
  if (wantsScope) {
    findings.push(...scope.findings);
    commands.push({ command_id: "scope_check", track: "scope", enforcement: "blocking", argv: null, builtin: "scope_check", exit_code: null, duration_ms: 0, status: scope.findings.some((f) => f.severity === "blocking") ? "failed" : "passed", stdout_path: null, stderr_path: null, summary: `${changed.length} changed file(s); ${scope.findings.length} finding(s)`, tests_passed: null, tests_failed: null });
  }
  findings.push(...scanProtectedAccess(input.eventsFile));
  let coordination: CoordinationSummary | null = null;
  if (input.coordination) {
    const track = coordinationTrack(input.coordination, input.worktree);
    coordination = track.summary;
    findings.push(...track.findings);
    commands.push(track.record);
  }
  if (!input.hiddenTaskTestsDir) {
    findings.push({ id: "F-ACCEPT-NONE", category: "process", severity: "review", rule_id: "NO-ACCEPTANCE-TESTS", source_evidence_ids: [], test: null, expected: "an independent task acceptance test outside the implementer's writable area", observed: "none bound to this task", message: "no independent task acceptance tests are bound (use --task <benchmark id> or add hidden tests); functional correctness rests on the project suite, which the implementer may edit", location: null, log_path: null, authority: "deterministic" });
  }
  if (changed.length === 0) {
    findings.push({ id: "F-SCOPE-NOCHANGE", category: "process", severity: "review", rule_id: "NO-CHANGES", source_evidence_ids: [], test: null, expected: "an implementation diff", observed: "working tree identical to base", message: "the implementer produced no changes", location: null, log_path: null, authority: "deterministic" });
  }

  // Snapshot the working tree (tracked + untracked, non-ignored), excluding .git.
  for (const rel of workingTreeFiles(input.worktree)) {
    const src = path.join(input.worktree, rel);
    const dst = path.join(snapshot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  // Hidden tests live outside the implementer's writable area; copy them in for execution only.
  const hiddenDir = path.join(snapshot, ".intentos_hidden");
  if (input.hiddenInvariantTestsDir && fs.existsSync(input.hiddenInvariantTestsDir)) copyDir(input.hiddenInvariantTestsDir, path.join(hiddenDir, "invariants"));
  if (input.hiddenTaskTestsDir && fs.existsSync(input.hiddenTaskTestsDir)) copyDir(input.hiddenTaskTestsDir, path.join(hiddenDir, "task"));
  // TypeScript repositories: the snapshot has no node_modules (ignored, never copied); the repository's is linked in, and a
  // vitest config that collects the hidden tests is written next to them ({hidden_tests_dir}/vitest.config.mjs).
  if (input.policy.language === "typescript") {
    if (!linkNodeModules(input.repoPath ?? input.worktree, snapshot) && !fs.existsSync(path.join(snapshot, "node_modules"))) limitations.push("node_modules not found in the repository; install the dependencies (npm ci) before verification can run the test suite.");
    writeHiddenVitestConfig(snapshot, hiddenDir);
    if (mode === "docker") limitations.push("verifier: the container image runs Python only; TypeScript test commands are refused in docker mode (host mode verifies them).");
  }

  const evidenceFor = (id: string): string[] => [...input.pack.invariants, ...input.pack.architecture_rules].find((c) => c.id === id)?.evidence_ids ?? [];
  const invariantByTestFile = new Map<string, string>();
  for (const inv of input.policy.invariants) for (const t of inv.verified_by) invariantByTestFile.set(path.basename(t), inv.id);
  const blockingConstraint = new Set([...input.contract.business_invariants, ...input.contract.architecture_constraints].filter((c) => c.enforcement === "blocking").map((c) => c.id));

  let findingCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${String(++findingCounter).padStart(3, "0")}`;

  for (const v of input.contract.verification) {
    const cmd = input.policy.commands[v.command_id];
    if (!cmd) {
      findings.push({ id: nextId("F-CMD"), category: "process", severity: "blocking", rule_id: "UNKNOWN-COMMAND", source_evidence_ids: [], test: null, expected: "trusted command", observed: v.command_id, message: `verification command ${v.command_id} is not in the trusted allowlist`, location: null, log_path: null, authority: "deterministic" });
      continue;
    }
    if (cmd.builtin === "scope_check") continue; // already executed above
    if (cmd.builtin === "architecture_rules") {
      const t0 = Date.now();
      const out = runArchitectureRules(snapshot, input.policy, input.contract, changed, evidenceFor);
      findings.push(...out.findings);
      for (const e of out.errors) findings.push({ id: nextId("F-ARCHERR"), category: "process", severity: "blocking", rule_id: "ARCH-CHECK-ERROR", source_evidence_ids: [], test: null, expected: "architecture checker ran", observed: e.error, message: `architecture checker error${e.path ? ` in ${e.path}` : ""}: ${e.error}`, location: e.path || null, log_path: null, authority: "deterministic" });
      commands.push({ command_id: v.command_id, track: cmd.track, enforcement: cmd.enforcement, argv: null, builtin: cmd.builtin, exit_code: null, duration_ms: Date.now() - t0, status: out.findings.some((f) => f.severity === "blocking") || out.errors.length ? "failed" : "passed", stdout_path: null, stderr_path: null, summary: `${out.checked_files} file(s) checked, ${out.findings.length} finding(s)`, tests_passed: null, tests_failed: null });
      continue;
    }
    if (cmd.builtin === "counterexamples") {
      const probes = generateCounterexamples(input.policy, input.contract, path.join(hiddenDir, "counterexamples"));
      if (!probes.length) {
        commands.push({ command_id: v.command_id, track: cmd.track, enforcement: "advisory", argv: null, builtin: cmd.builtin, exit_code: null, duration_ms: 0, status: "skipped", stdout_path: null, stderr_path: null, summary: "no counterexample templates bound to the contract's invariants", tests_passed: null, tests_failed: null });
        continue;
      }
      const argv = [python, "-m", "pytest", path.join(hiddenDir, "counterexamples"), "-q", "-p", "no:cacheprovider", "-o", "pythonpath=.", `--junit-xml=${path.join(attemptDir, "counterexamples.junit.xml")}`];
      const cxCmd: PolicyCommand = { ...cmd, enforcement: "advisory" };
      if (unavailable) {
        commands.push(unavailableRecord(v.command_id, cxCmd)); // probes execute candidate code: never run them on the host in docker mode
        continue;
      }
      const rec = execCommand(v.command_id, cxCmd, argv, snapshot, attemptDir, execContext(v.command_id));
      commands.push(rec);
      for (const c of parseJunitIfPresent(path.join(attemptDir, "counterexamples.junit.xml"))) {
        if (c.status !== "failed" && c.status !== "error") continue;
        const probe = probes.find((p) => c.classname.includes(path.basename(p.file, ".py")) || (c.file ?? "").includes(path.basename(p.file)));
        const authoritative = probe?.authority === "authoritative";
        findings.push({ id: nextId("F-CX"), category: "counterexample", severity: authoritative ? "blocking" : "review", rule_id: probe?.invariant_id ?? null, source_evidence_ids: probe ? evidenceFor(probe.invariant_id) : [], test: c.name, expected: probe ? `invariant ${probe.invariant_id} holds for generated edge case` : null, observed: c.message, message: `counterexample probe ${probe?.counterexample_id ?? ""} failed: ${c.name}${c.message ? ` — ${c.message}` : ""} [${authoritative ? "authoritative" : "exploratory, non-blocking"}]`, location: c.file, log_path: rec.stdout_path, authority: authoritative ? "trusted_policy" : "exploratory" });
      }
      continue;
    }
    if (cmd.builtin === "architecture_surprise") {
      // Review-only triage computed from the diff; it never blocks and runs on the host (no candidate code executes).
      const t0 = Date.now();
      const out = runArchitecturalSurprise({ snapshot, repoPath: input.repoPath ?? input.worktree, baseSha: input.baseSha, changed, policy: input.policy });
      findings.push(...out.findings);
      limitations.push(...out.limitations);
      findings.push(...precedentFindings(input.pack, changed, nextId));
      const errs = out.errors.length ? `; ${out.errors.length} file(s) not analysed (${out.errors.map((e) => e.path || e.error).slice(0, 3).join(", ")})` : "";
      commands.push({ command_id: v.command_id, track: cmd.track, enforcement: "advisory", argv: null, builtin: cmd.builtin, exit_code: null, duration_ms: Date.now() - t0, status: "passed", stdout_path: null, stderr_path: null, summary: `${out.findings.length} signal(s) in ${out.checked_files} changed Python file(s)${errs}`, tests_passed: null, tests_failed: null });
      continue;
    }
    if (!cmd.argv) continue;
    if (cmd.requires_task_tests && !input.hiddenTaskTestsDir) {
      commands.push({ command_id: v.command_id, track: cmd.track, enforcement: cmd.enforcement, argv: null, builtin: null, exit_code: null, duration_ms: 0, status: "skipped", stdout_path: null, stderr_path: null, summary: "no hidden task tests for this task", tests_passed: null, tests_failed: null });
      continue;
    }
    if (cmd.track === "business_invariant") {
      // Fail closed: every bound blocking invariant that the policy says is verified by a hidden test must have that test available.
      for (const b of input.contract.business_invariants.filter((x) => x.enforcement === "blocking")) {
        const inv = input.policy.invariants.find((i) => i.id === b.id);
        for (const t of inv?.verified_by ?? []) {
          const present = !!input.hiddenInvariantTestsDir && fs.existsSync(path.join(input.hiddenInvariantTestsDir, path.basename(t)));
          if (!present) findings.push({ id: nextId("F-INV"), category: "business_invariant", severity: "blocking", rule_id: b.id, source_evidence_ids: evidenceFor(b.id), test: path.basename(t), expected: `${b.id} verified by ${t}`, observed: "hidden test file unavailable to the verifier", message: `${b.id} is blocking but its hidden test ${path.basename(t)} is not available; cannot verify — failing closed`, location: null, log_path: null, authority: "trusted_policy" });
        }
      }
      if (!input.hiddenInvariantTestsDir) {
        commands.push({ command_id: v.command_id, track: cmd.track, enforcement: cmd.enforcement, argv: null, builtin: null, exit_code: null, duration_ms: 0, status: "skipped", stdout_path: null, stderr_path: null, summary: "no hidden invariant tests configured", tests_passed: null, tests_failed: null });
        continue;
      }
    }
    const junit = path.join(attemptDir, `${v.command_id}.junit.xml`);
    const vars: CommandVars = { python, snapshot, hidden_tests_dir: hiddenDir, junit };
    const argv = fillArgv(cmd.argv, vars);
    if (unavailable) {
      // Fail closed: in docker mode nothing that executes candidate code may run on the host.
      commands.push(unavailableRecord(v.command_id, cmd));
      if (cmd.enforcement === "blocking") {
        findings.push({ id: nextId("F-VERIFIER"), category: "process", severity: "blocking", rule_id: "VERIFIER-UNAVAILABLE", source_evidence_ids: [], test: null, expected: "trusted command executed inside the isolated verifier container", observed: docker?.preflight.reason ?? "docker unavailable", message: `${v.command_id}: container verifier unavailable (${docker?.preflight.reason ?? "docker unavailable"}); command not executed — failing closed`, location: null, log_path: null, authority: "deterministic" });
      }
      continue;
    }
    const rec = execCommand(v.command_id, cmd, argv, snapshot, attemptDir, execContext(v.command_id), fillEnv(cmd.env, vars));
    commands.push(rec);
    const cases = parseJunitIfPresent(junit);
    rec.tests_passed = cases.filter((c) => c.status === "passed").length;
    rec.tests_failed = cases.filter((c) => c.status === "failed" || c.status === "error").length;
    const category = cmd.track === "business_invariant" ? "business_invariant" : "functional";
    // Hidden tests are trusted config: the set of reported test names must equal the set discovered statically.
    // Candidate code runs inside the pytest process and could forge the JUnit file; this check raises the bar
    // (and ARCH-style forbidden_names rules catch the common tampering patterns), but only isolation removes the risk.
    const hiddenSubdir = cmd.requires_task_tests ? path.join(hiddenDir, "task") : cmd.track === "business_invariant" ? path.join(hiddenDir, "invariants") : null;
    if (hiddenSubdir) {
      const expected = discoverTestNames(hiddenSubdir);
      const reported = new Set(cases.map((c) => leafTestName(c.name)));
      const missing = [...expected].filter((n) => !reported.has(n));
      const extra = [...reported].filter((n) => !expected.has(n));
      if (expected.size && (missing.length || extra.length)) {
        findings.push({ id: nextId("F-FORGE"), category, severity: "blocking", rule_id: "TEST-INVENTORY-MISMATCH", source_evidence_ids: [], test: null, expected: `${expected.size} hidden test(s): ${[...expected].slice(0, 6).join(", ")}${expected.size > 6 ? ", …" : ""}`, observed: `${reported.size} reported${missing.length ? `; missing ${missing.slice(0, 4).join(", ")}` : ""}${extra.length ? `; unexpected ${extra.slice(0, 4).join(", ")}` : ""}`, message: `${v.command_id}: reported test results do not match the hidden test inventory (possible tampering with the test process or report)`, location: null, log_path: rec.stdout_path, authority: "deterministic" });
      }
    }
    const authority = cmd.track === "business_invariant" || v.command_id.includes("hidden") ? "hidden_test" : "project_test";
    // A command that did not run to a clean exit is a failure in itself, whether or not any test case was recorded.
    if (rec.status !== "passed" && !cases.some((c) => c.status === "failed" || c.status === "error")) {
      findings.push({ id: nextId("F-CMD"), category, severity: cmd.enforcement === "blocking" ? "blocking" : "review", rule_id: null, source_evidence_ids: [], test: null, expected: "command completed with exit code 0", observed: rec.summary, message: `${v.command_id}: ${rec.status} — ${rec.summary}`, location: null, log_path: rec.stdout_path, authority });
    }
    // "Passed" with nothing collected is not evidence of anything.
    if (rec.status === "passed" && cases.length === 0) {
      const hiddenExpected = v.command_id.includes("hidden") || cmd.track === "business_invariant";
      findings.push({ id: nextId("F-CMD"), category, severity: hiddenExpected && cmd.enforcement === "blocking" ? "blocking" : "review", rule_id: null, source_evidence_ids: [], test: null, expected: "at least one test executed", observed: "0 tests collected", message: `${v.command_id}: no tests were collected; nothing was verified by this command`, location: null, log_path: rec.stdout_path, authority });
    }
    for (const c of cases) {
      if (c.status !== "failed" && c.status !== "error") continue;
      // pytest: file attribute or dotted classname; vitest/jest: the classname is the file path.
      const fileBase = c.file ? path.basename(c.file) : c.classname.includes("/") ? path.basename(c.classname) : (c.classname.split(".").pop() ?? "");
      const invId = invariantByTestFile.get(fileBase) ?? invariantByTestFile.get(`${fileBase}.py`) ?? inferInvariantFromClassname(c.classname, invariantByTestFile);
      const isInvariant = cmd.track === "business_invariant";
      const isHiddenTask = v.command_id.includes("hidden");
      const blocking = cmd.enforcement === "blocking" && (!isInvariant || !invId || blockingConstraint.has(invId));
      findings.push({
        id: nextId(isInvariant ? "F-INV" : "F-FUNC"),
        category: isInvariant ? "business_invariant" : "functional",
        severity: blocking ? "blocking" : "review",
        rule_id: invId ?? null,
        source_evidence_ids: invId ? evidenceFor(invId) : [],
        test: `${c.classname}::${c.name}`,
        expected: invId ? input.policy.invariants.find((i) => i.id === invId)?.statement ?? null : "test passes",
        observed: c.message,
        message: `${v.command_id}: ${c.classname}::${c.name} ${c.status}${c.message ? ` — ${c.message}` : ""}`,
        location: c.file,
        log_path: rec.stdout_path,
        authority: isInvariant || isHiddenTask ? "hidden_test" : "project_test",
      });
    }
  }

  // Tracks summary
  const tracks: VerificationResult["tracks"] = {};
  for (const track of ["functional", "architecture", "business_invariant", "scope", ...(input.coordination ? ["coordination"] : [])]) {
    const recs = commands.filter((c) => c.track === track);
    const fs_ = findings.filter((f) => (track === "business_invariant" ? f.category === "business_invariant" || f.category === "counterexample" : f.category === track || (track === "functional" && f.category === "process" && f.rule_id?.startsWith("TESTS")))); // eslint-disable-line
    const blocking = fs_.filter((f) => f.severity === "blocking").length;
    const review = fs_.filter((f) => f.severity === "review").length;
    const ran = recs.some((r) => r.status !== "skipped");
    tracks[track] = { status: !ran ? "not_run" : blocking ? "failed" : recs.every((r) => r.enforcement === "advisory") ? "advisory" : "passed", blocking_findings: blocking, review_findings: review };
  }

  const unverified: string[] = [];
  const boundInv = new Set(input.contract.business_invariants.map((b) => b.id));
  for (const inv of input.policy.invariants) if (!boundInv.has(inv.id)) unverified.push(`${inv.id} (not applicable to this task's scope; not verified)`);
  if (!input.policy.invariants.length) unverified.push("business invariants: none defined in trusted policy — business correctness not verified");
  if (!input.hiddenTaskTestsDir) unverified.push("task acceptance: no hidden task tests — functional result rests on the project suite only");
  if (!input.policy.architecture_rules.length) unverified.push("architecture: no approved rules — only scope checked");

  // Consistency guard: every blocking command that did not pass must be reflected in a blocking finding.
  for (const c of commands) {
    if (c.enforcement !== "blocking" || c.status === "passed" || c.status === "skipped") continue;
    if (!findings.some((f) => f.severity === "blocking")) {
      findings.push({ id: `F-GUARD-${c.command_id}`, category: "process", severity: "blocking", rule_id: "VERIFIER-CONSISTENCY", source_evidence_ids: [], test: null, expected: "passed", observed: c.status, message: `${c.command_id} did not pass (${c.summary}) but produced no finding; blocking by consistency guard`, location: null, log_path: c.stdout_path, authority: "deterministic" });
    }
  }

  return {
    status: summarizeStatus(findings),
    run_id: input.runId,
    attempt: input.attempt,
    snapshot_path: snapshot,
    base_sha: input.baseSha,
    contract_hash: input.contractHash,
    started_at: startedAt,
    finished_at: nowIso(),
    commands,
    findings,
    tracks,
    changed_files: scope.changed_files,
    unverified_areas: unverified,
    limitations,
    simulated: input.simulated,
    verifier: { mode, image: docker?.settings.image ?? null, image_digest: docker?.preflight.imageDigest ?? null },
    coordination,
  };
}

function inferInvariantFromClassname(classname: string, map: Map<string, string>): string | undefined {
  for (const [file, id] of map) if (classname.includes(file.replace(/\.py$/, "").replace(/\.(test|spec)\.[cm]?[jt]sx?$/, ""))) return id;
  return undefined;
}

function parseJunitIfPresent(file: string) {
  return fs.existsSync(file) ? parseJunit(fs.readFileSync(file, "utf8")) : [];
}

interface ExecContext {
  mode: VerifierMode;
  /** Present only in docker mode with a passing preflight. */
  container: { name: string; settings: DockerSettings; resultsDir: string; hiddenDir: string; python: string } | null;
}

function execCommand(commandId: string, cmd: PolicyCommand, argv: string[], cwd: string, logDir: string, exec: ExecContext = { mode: "host", container: null }, extraEnv: Record<string, string> = {}): CommandRecord {
  const t0 = Date.now();
  const stdoutPath = path.join(logDir, `${commandId}.log`);
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0", LANG: "C.UTF-8", ...extraEnv };
  let spawnArgv = argv;
  if (exec.mode === "docker") {
    if (!exec.container) throw new Error("docker verifier mode requires a container context (preflight must pass before executing commands)");
    try {
      spawnArgv = planCommand(argv, { snapshot: cwd, resultsDir: exec.container.resultsDir, hiddenDir: exec.container.hiddenDir, name: exec.container.name, settings: exec.container.settings, python: exec.container.python });
    } catch (e) {
      fs.writeFileSync(stdoutPath, `$ ${argv.join(" ")}\n(cwd ${cwd})\n\nrefused: ${(e as Error).message}\n`);
      return { command_id: commandId, track: cmd.track, enforcement: cmd.enforcement, argv, builtin: null, exit_code: null, duration_ms: Date.now() - t0, status: "error", stdout_path: stdoutPath, stderr_path: null, summary: `refused to run in container: ${(e as Error).message}`, tests_passed: null, tests_failed: null };
    }
    Object.assign(env, dockerClientEnv());
  }
  const res = spawnSync(spawnArgv[0]!, spawnArgv.slice(1), { cwd, env, encoding: "utf8", timeout: cmd.timeout_s * 1000, maxBuffer: 64 * 1024 * 1024 });
  const duration = Date.now() - t0;
  const timedOut = !!res.error && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  if (timedOut && exec.container) killContainer(exec.container.name, exec.container.settings);
  const out = `$ ${argv.join(" ")}\n(cwd ${cwd})${exec.mode === "docker" ? `\n(container ${exec.container?.name}) $ ${spawnArgv.join(" ")}` : ""}\n\n${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  fs.writeFileSync(stdoutPath, out);
  let status: CommandRecord["status"];
  let summary: string;
  if (timedOut) {
    status = "timeout";
    summary = `timed out after ${cmd.timeout_s}s${exec.container ? " (container killed)" : ""}`;
  } else if (res.error) {
    status = "error";
    summary = `failed to start: ${res.error.message}`;
  } else if (res.status === 0) {
    status = "passed";
    summary = lastLine(res.stdout);
  } else if (res.status === 5) {
    status = "passed"; // pytest: no tests collected
    summary = "no tests collected";
  } else {
    status = "failed";
    summary = lastLine(res.stdout) || lastLine(res.stderr) || `exit ${res.status}`;
  }
  return { command_id: commandId, track: cmd.track, enforcement: cmd.enforcement, argv, builtin: null, exit_code: res.status ?? null, duration_ms: duration, status, stdout_path: stdoutPath, stderr_path: null, summary, tests_passed: null, tests_failed: null };
}

function lastLine(s: string | null | undefined): string {
  const lines = (s ?? "").trim().split("\n").filter(Boolean);
  return (lines[lines.length - 1] ?? "").replace(/=+/g, "").trim();
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "__pycache__") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

export { resolvePaths };
