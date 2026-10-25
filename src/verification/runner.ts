import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Policy, PolicyCommand } from "../knowledge/policy.ts";
import type { ChangeContract } from "../contracts/schemas.ts";
import type { EvidencePack } from "../knowledge/retrieval.ts";
import { changedFiles, diffAgainstBase, workingTreeFiles, headSha } from "../util/git.ts";
import { ensureDir } from "../util/paths.ts";
import { resolvePaths, resolvePython } from "../config.ts";
import { parseJunit } from "./junit.ts";
import { runArchitectureRules, runScopeCheck } from "./policy.ts";
import { generateCounterexamples } from "./counterexamples.ts";
import { summarizeStatus, type CommandRecord, type Finding, type VerificationResult } from "./results.ts";
import { nowIso } from "../util/ids.ts";

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
  simulated: boolean;
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
  const limitations: string[] = [
    "Verification runs the candidate code on the host (no container isolation); use only trusted fixture repositories.",
    "Network access during verification is not technically blocked; architecture rules forbid network libraries statically.",
  ];
  if (input.simulated) limitations.push("Implementation was produced by the simulated offline engine; results measure the orchestration path, not agent performance.");

  // Integrity: the worktree must still be at the base revision (implementer must not commit).
  const wtHead = headSha(input.worktree);
  if (wtHead !== input.baseSha) {
    findings.push({ id: "F-INTEGRITY-001", category: "process", severity: "blocking", rule_id: "WORKTREE-HEAD", source_evidence_ids: [], test: null, expected: input.baseSha, observed: wtHead, message: "worktree HEAD moved from the base revision (implementer committed or rebased)", location: null, log_path: null, authority: "deterministic" });
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
      const argv = [resolvePython(), "-m", "pytest", path.join(hiddenDir, "counterexamples"), "-q", "-p", "no:cacheprovider", "-o", "pythonpath=.", `--junit-xml=${path.join(attemptDir, "counterexamples.junit.xml")}`];
      const rec = execCommand(v.command_id, { ...cmd, enforcement: "advisory" }, argv, snapshot, attemptDir);
      commands.push(rec);
      for (const c of parseJunitIfPresent(path.join(attemptDir, "counterexamples.junit.xml"))) {
        if (c.status !== "failed" && c.status !== "error") continue;
        const probe = probes.find((p) => c.classname.includes(path.basename(p.file, ".py")) || (c.file ?? "").includes(path.basename(p.file)));
        const authoritative = probe?.authority === "authoritative";
        findings.push({ id: nextId("F-CX"), category: "counterexample", severity: authoritative ? "blocking" : "review", rule_id: probe?.invariant_id ?? null, source_evidence_ids: probe ? evidenceFor(probe.invariant_id) : [], test: c.name, expected: probe ? `invariant ${probe.invariant_id} holds for generated edge case` : null, observed: c.message, message: `counterexample probe ${probe?.counterexample_id ?? ""} failed: ${c.name}${c.message ? ` — ${c.message}` : ""} [${authoritative ? "authoritative" : "exploratory, non-blocking"}]`, location: c.file, log_path: rec.stdout_path, authority: authoritative ? "trusted_policy" : "exploratory" });
      }
      continue;
    }
    if (!cmd.argv) continue;
    if (cmd.requires_task_tests && !input.hiddenTaskTestsDir) {
      commands.push({ command_id: v.command_id, track: cmd.track, enforcement: cmd.enforcement, argv: null, builtin: null, exit_code: null, duration_ms: 0, status: "skipped", stdout_path: null, stderr_path: null, summary: "no hidden task tests for this task", tests_passed: null, tests_failed: null });
      continue;
    }
    if (cmd.track === "business_invariant" && !input.hiddenInvariantTestsDir) {
      commands.push({ command_id: v.command_id, track: cmd.track, enforcement: cmd.enforcement, argv: null, builtin: null, exit_code: null, duration_ms: 0, status: "skipped", stdout_path: null, stderr_path: null, summary: "no hidden invariant tests configured", tests_passed: null, tests_failed: null });
      continue;
    }
    const junit = path.join(attemptDir, `${v.command_id}.junit.xml`);
    const argv = cmd.argv.map((a) => a.replace("{python}", resolvePython()).replace("{snapshot}", snapshot).replace("{hidden_tests_dir}", hiddenDir).replace("{junit}", junit));
    const rec = execCommand(v.command_id, cmd, argv, snapshot, attemptDir);
    commands.push(rec);
    const cases = parseJunitIfPresent(junit);
    rec.tests_passed = cases.filter((c) => c.status === "passed").length;
    rec.tests_failed = cases.filter((c) => c.status === "failed" || c.status === "error").length;
    const category = cmd.track === "business_invariant" ? "business_invariant" : "functional";
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
      const fileBase = c.file ? path.basename(c.file) : c.classname.split(".").pop() ?? "";
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
  for (const track of ["functional", "architecture", "business_invariant", "scope"]) {
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
  };
}

function inferInvariantFromClassname(classname: string, map: Map<string, string>): string | undefined {
  for (const [file, id] of map) if (classname.includes(file.replace(/\.py$/, ""))) return id;
  return undefined;
}

function parseJunitIfPresent(file: string) {
  return fs.existsSync(file) ? parseJunit(fs.readFileSync(file, "utf8")) : [];
}

function execCommand(commandId: string, cmd: PolicyCommand, argv: string[], cwd: string, logDir: string): CommandRecord {
  const t0 = Date.now();
  const stdoutPath = path.join(logDir, `${commandId}.log`);
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0", LANG: "C.UTF-8" };
  const res = spawnSync(argv[0]!, argv.slice(1), { cwd, env, encoding: "utf8", timeout: cmd.timeout_s * 1000, maxBuffer: 64 * 1024 * 1024 });
  const duration = Date.now() - t0;
  const out = `$ ${argv.join(" ")}\n(cwd ${cwd})\n\n${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  fs.writeFileSync(stdoutPath, out);
  let status: CommandRecord["status"];
  let summary: string;
  if (res.error && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    status = "timeout";
    summary = `timed out after ${cmd.timeout_s}s`;
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
