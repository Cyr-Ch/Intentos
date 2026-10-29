import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gitHead, gitStatus, setupTsFixtureEnv, TS_PATCHES, TS_TASK, type TestEnv } from "../helpers/fixture.ts";
import { createRun, executeRun, type RunOptions } from "../../src/orchestrator/runner.ts";
import type { VerificationResult } from "../../src/verification/results.ts";
import { discoverTestNames } from "../../src/verification/runner.ts";
import { runTsArchitectureRules } from "../../src/verification/ts_rules.ts";
import { renderDraftPolicy, runProbe } from "../../src/onboard.ts";
import { loadPolicyFile, policyForRepo, projectTestCommand, fillArgv } from "../../src/knowledge/policy.ts";
import { extractTypeScript } from "../../src/knowledge/ts_extract.ts";
import { ingestProposals, loadDigest } from "../../src/propose.ts";
import { renderDigest } from "../../src/candidates.ts";
import { writeHiddenTest } from "../../src/review.ts";
import { buildEvidencePack } from "../../src/knowledge/retrieval.ts";
import { PROJECT_ROOT } from "../../src/config.ts";

let env: TestEnv;
let baseHead: string;
beforeAll(() => {
  env = setupTsFixtureEnv();
  baseHead = gitHead(env.repo);
});
afterAll(() => env.cleanup());

const offline = (extra: Partial<RunOptions["offline"]> = {}): RunOptions => ({
  mode: "offline",
  offline: { route: "implement", patchFile: null, claimSuccess: false, fabricateEvidence: false, repairPatchFile: null, ...extra },
  taskId: "task-ts-transfer",
});

/** The fixture ignores `node_modules/`, which does not cover the symlink IntentOS links in; everything else must be clean. */
const repoStatus = () => gitStatus(env.repo).split("\n").filter((l) => l && !/\bnode_modules$/.test(l)).join("\n");

async function run(opts: RunOptions, task = TS_TASK) {
  const rs = createRun(env.store, env.indexed, task, opts);
  const outcome = await executeRun(env.store, rs, opts);
  return { rs, outcome, verification: rs.readJson<VerificationResult>("verification") };
}

describe("TypeScript repositories: probe, draft policy and index", () => {
  it("the probe recognises a vitest project and the draft policy is a valid TypeScript policy", () => {
    const probe = runProbe(env.repo);
    expect(probe.language).toBe("typescript");
    expect(probe.node?.runner).toBe("vitest");
    expect(probe.node?.source_dirs).toContain("src");
    const draft = renderDraftPolicy(probe, env.repo, "ts_ledger_draft");
    const file = path.join(env.home, "draft.yaml");
    fs.writeFileSync(file, draft);
    const policy = loadPolicyFile(file);
    expect(policy.language).toBe("typescript");
    expect(policy.protected_paths).toEqual(expect.arrayContaining(["package.json", "vitest.config.ts"]));
    const test = projectTestCommand(policy)!;
    expect(test.name).toBe("test_project");
    expect(test.cmd.argv!.join(" ")).toContain("vitest");
    const argv = fillArgv(test.cmd.argv!, { python: "python3", snapshot: "/snap", hidden_tests_dir: "/snap/.intentos_hidden", junit: "/j.xml", node: "/usr/bin/node", node_modules: "/snap/node_modules" });
    expect(argv[0]).toBe("/usr/bin/node");
    expect(argv[1]).toBe("/snap/node_modules/vitest/vitest.mjs");
    expect(policy.commands.hidden_invariants?.argv!.join(" ")).toContain("--config /snap/.intentos_hidden/vitest.config.mjs".replace("/snap/.intentos_hidden", "{hidden_tests_dir}"));
  });

  it("the trusted policy is matched through package.json's name", () => {
    expect(policyForRepo(env.repo)?.policy_id).toBe("ts_ledger");
    expect(env.indexed.policy.policy_id).toBe("ts_ledger");
    expect(env.indexed.policy.language).toBe("typescript");
  });

  it("the TypeScript extractor finds modules, classes, methods, imports and vitest tests", () => {
    const tracked = spawnSync("git", ["ls-files"], { cwd: env.repo, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    const out = extractTypeScript(env.repo, tracked);
    const names = out.symbols.map((s) => s.qualified_name);
    expect(names).toContain("src/domain/ledger");
    expect(names).toContain("src/domain/ledger.Ledger");
    expect(names).toContain("src/domain/ledger.Ledger.post");
    expect(names).toContain("src/domain/money.Money.add");
    expect(out.imports.some((i) => i.path === "src/api/handlers.ts" && i.to_module === "src/domain/ledger")).toBe(true);
    expect(out.tests.some((t) => t.path === "tests/ledger.test.ts" && t.name === "rejects a debit that would make the balance negative")).toBe(true);
    // and they land in the knowledge graph
    const nodes = env.store.nodes(env.indexed.repo.id, env.indexed.revision);
    expect(nodes.some((n) => n.id === "SY:src/domain/ledger.Ledger.post")).toBe(true);
    expect(nodes.some((n) => n.kind === "test" && /ledger\.test\.ts::rejects a debit/.test(n.id))).toBe(true);
  });

  it("the evidence pack for a transfer task reaches the ledger symbols and the balance invariant", () => {
    const pack = buildEvidencePack(env.store, env.indexed, TS_TASK);
    expect(pack.reusable_symbols.some((s) => s.qualified_name.startsWith("src/domain/ledger."))).toBe(true);
    expect(pack.invariants.map((i) => i.id)).toContain("INV-002");
    expect(pack.commands.map((c) => c.command_id)).toEqual(expect.arrayContaining(["test_project", "hidden_invariants", "architecture_rules", "scope_check"]));
  });
});

describe("TypeScript repositories: evidence digest and proposals", () => {
  it("the digest reads vitest tests, the fix commit, the import graph and the MUST sentences", () => {
    const digest = loadDigest(env.repo, { policyId: "ts_ledger", outDir: path.join(env.home, "onboard-digest") });
    expect(digest.language).toBe("typescript");
    expect(digest.tests.map((t) => t.ref)).toContain("tests/ledger.test.ts::rejects a debit that would make the balance negative");
    expect(digest.commits.some((c) => c.looks_like_fix && c.tests_added.includes("rejects a debit that would make the balance negative"))).toBe(true);
    expect(digest.imports.some((e) => e.from_dir === "src/api" && e.to_dir === "src/domain")).toBe(true);
    expect(digest.documents.some((d) => d.path === "docs/invariants.md")).toBe(true);
    const text = renderDigest(digest);
    expect(text).toContain("tests/ledger.test.ts");
    expect(text).toMatch(/MUST NOT be added|never go below zero/);
  });

  it("proposals: an existing vitest test is lifted (whole file, bound test marked .only), a written test runs, an invented reference is rejected", async () => {
    const outDir = path.join(env.home, "onboard-propose");
    const written = [
      'import { describe, expect, it } from "vitest";',
      'import { Money } from "../../src/domain/money.ts";',
      "",
      'describe("Money integers", () => {',
      '  it("rejects fractional cents", () => {',
      '    expect(() => new Money(1.5, "EUR")).toThrow(TypeError);',
      "  });",
      "});",
      "",
    ].join("\n");
    const res = await ingestProposals(
      env.repo,
      [
        { kind: "invariant", title: "Balances never go negative", statement: "An account balance never goes below zero through Ledger.post; overdrafts throw InsufficientFunds.", evidence: [{ type: "test", ref: "tests/ledger.test.ts::rejects a debit that would make the balance negative", excerpt: "toThrow(InsufficientFunds)" }, { type: "doc", ref: "docs/invariants.md", excerpt: "MUST never go below zero" }], applies_to_paths: ["src/domain/**"], test: { existing: "tests/ledger.test.ts::rejects a debit that would make the balance negative" } },
        { kind: "invariant", title: "Amounts are integer cents", statement: "Money only accepts integer minor units; a fractional amount is a TypeError at construction.", evidence: [{ type: "doc", ref: "docs/invariants.md", excerpt: "Amounts are integers in minor units" }], applies_to_paths: ["src/domain/**"], test: { source: written } },
        { kind: "invariant", title: "Invented", statement: "A rule whose test reference does not exist in the repository at all.", evidence: [{ type: "test", ref: "tests/ledger.test.ts::does not exist", excerpt: "nothing" }], test: { existing: "tests/ledger.test.ts::does not exist" } },
        { kind: "architecture_rule", title: "API never imports storage", statement: "Request handlers must not import src/db; they use the Ledger repository interface.", evidence: [{ type: "doc", ref: "docs/invariants.md", excerpt: "MUST NOT import src/db" }], rule: { kind: "forbidden_import", paths: ["src/api/**"], forbidden_modules: ["src/db"] }, sources: [{ path: "docs/invariants.md", heading: "Layering" }] },
      ],
      { policyId: "ts_ledger", outDir, policyFile: path.join(PROJECT_ROOT, "policies", "ts_ledger.yaml") },
    );
    expect(res.rejected.map((r) => r.title)).toEqual(["Invented"]);
    expect(res.candidates).toHaveLength(3);
    const lifted = res.candidates.find((c) => c.title === "Balances never go negative")!;
    expect(lifted.suggested_hidden_test?.language).toBe("typescript");
    expect(lifted.suggested_hidden_test?.source).toContain('it.only("rejects a debit that would make the balance negative"');
    expect(lifted.suggested_hidden_test?.source).toContain('from "../../src/domain/ledger.ts"');
    const authored = res.candidates.find((c) => c.title === "Amounts are integer cents")!;
    expect(authored.suggested_hidden_test?.from).toBe("codex:amounts-are-integer-cents");
    expect((authored.policy_block as { verified_by?: string[] }).verified_by?.[0]).toMatch(/benchmarks\/hidden_tests\/ts_ledger\/invariants\/inv_TODO_.*\.test\.ts$/);
    // nothing written into the repository
    expect(fs.existsSync(path.join(env.repo, ".intentos_hidden"))).toBe(false);
    expect(fs.existsSync(path.join(env.repo, "tests", "vitest.config.mjs"))).toBe(false);
    expect(repoStatus()).toBe("");
  });

  it("review writes an approved TypeScript hidden test as <id>.test.ts with a header comment", () => {
    const dir = path.join(env.home, "hidden-out");
    const { file, complete } = writeHiddenTest(dir, "INV-009", "Amounts are integer cents", { from: "codex:amounts", language: "typescript", imports: "", source: 'import { it } from "vitest";\nit("x", () => {});\n', notes: [], standalone: true });
    expect(complete).toBe(true);
    expect(path.basename(file)).toBe("inv_009_amounts_are_integer_cents.test.ts");
    const text = fs.readFileSync(file, "utf8");
    expect(text.startsWith("/**")).toBe(true);
    expect(text).toContain("INV-009");
    expect(text).toContain('import { it } from "vitest";');
  });
});

describe("TypeScript repositories: architecture rules and hidden tests", () => {
  it("the TypeScript checker reports forbidden imports by repository path and ignores clean layers", () => {
    const clean = runTsArchitectureRules(env.repo, env.indexed.policy.architecture_rules, []);
    expect(clean.errors).toEqual([]);
    expect(clean.findings).toEqual([]);
    const probe = path.join(env.home, "arch-probe");
    fs.cpSync(env.repo, probe, { recursive: true, filter: (p) => !p.includes("node_modules") && !p.includes(".git") });
    expect(spawnSync("git", ["apply", TS_PATCHES.bad], { cwd: probe, encoding: "utf8" }).status).toBe(0);
    const out = runTsArchitectureRules(probe, env.indexed.policy.architecture_rules, ["src/api/handlers.ts"]);
    expect(out.findings.map((f) => [f.rule_id, f.path, f.in_changed_file])).toEqual([["ARCH-001", "src/api/handlers.ts", true]]);
    expect(out.findings[0]!.message).toContain("../db/client.ts");
  });

  it("the checker also understands package specifiers, calls, required imports and forbidden names", () => {
    const dir = path.join(env.home, "rules-probe", "src");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.ts"), ['import { exec } from "node:child_process";', 'import fs from "fs";', "export function run() {", '  exec("ls");', "  process.exit(1);", '  const key = "SECRET_TOKEN";', "  return fs.readFileSync(key);", "}", ""].join("\n"));
    fs.writeFileSync(path.join(dir, "b.ts"), ["export const x = 1;", ""].join("\n"));
    const out = runTsArchitectureRules(path.dirname(dir), [
      { id: "R1", kind: "forbidden_import", statement: "", paths: ["src/**"], forbidden_modules: ["child_process"], forbidden_callees: [], allowed_paths: [], required_modules: [], forbidden_names: [], forbidden_literals: [], authority: "approved_decision", approved_by: "x", scope: [], sources: [], enforcement: "blocking" },
      { id: "R2", kind: "forbidden_call", statement: "", paths: ["src/**"], forbidden_modules: [], forbidden_callees: ["exec", "process.exit"], allowed_paths: ["src/b.ts"], required_modules: [], forbidden_names: [], forbidden_literals: [], authority: "approved_decision", approved_by: "x", scope: [], sources: [], enforcement: "blocking" },
      { id: "R3", kind: "required_import", statement: "", paths: ["src/**"], forbidden_modules: [], forbidden_callees: [], allowed_paths: [], required_modules: ["./logger"], forbidden_names: [], forbidden_literals: [], authority: "approved_decision", approved_by: "x", scope: [], sources: [], enforcement: "blocking" },
      { id: "R4", kind: "forbidden_names", statement: "", paths: ["src/**"], forbidden_modules: [], forbidden_callees: [], allowed_paths: [], required_modules: [], forbidden_names: ["fs.readFileSync"], forbidden_literals: ["secret_"], authority: "approved_decision", approved_by: "x", scope: [], sources: [], enforcement: "blocking" },
    ], []);
    const byRule = (id: string) => out.findings.filter((f) => f.rule_id === id).map((f) => `${f.path}:${f.line}`);
    expect(byRule("R1")).toEqual(["src/a.ts:1"]);
    expect(byRule("R2")).toEqual(["src/a.ts:4", "src/a.ts:5"]);
    expect(byRule("R3")).toEqual(["src/a.ts:1"]); // a.ts defines a function without importing ./logger; b.ts defines none
    expect(byRule("R4")).toEqual(expect.arrayContaining(["src/a.ts:6", "src/a.ts:7"]));
    expect(out.checked_files).toBe(2);
  });

  it("hidden test inventory discovery reads vitest titles", () => {
    const names = discoverTestNames(path.join(PROJECT_ROOT, "benchmarks", "hidden_tests", "ts_ledger", "invariants"));
    expect(names.has("add refuses a different currency")).toBe(true);
    expect(names.has("rejects an overdraft and records nothing")).toBe(true);
  });
});

describe("TypeScript repositories: offline pipeline", () => {
  it("the good patch passes the vitest suite, the hidden task tests, the hidden invariants and the rules", async () => {
    const { rs, outcome, verification } = await run(offline({ patchFile: TS_PATCHES.good }));
    expect(outcome.state, JSON.stringify(verification?.findings.map((f) => f.message))).toBe("REVIEW_READY");
    expect(verification!.status).toBe("passed");
    const ids = verification!.commands.map((c) => c.command_id);
    expect(ids).toEqual(expect.arrayContaining(["test_project", "hidden_task_tests", "hidden_invariants", "architecture_rules", "scope_check"]));
    const task = verification!.commands.find((c) => c.command_id === "hidden_task_tests")!;
    expect(task.status).toBe("passed");
    expect(task.tests_passed).toBe(2);
    const inv = verification!.commands.find((c) => c.command_id === "hidden_invariants")!;
    expect(inv.status).toBe("passed");
    expect(inv.tests_passed).toBe(4);
    expect(verification!.commands.find((c) => c.command_id === "test_project")!.tests_passed).toBe(6);
    expect(fs.existsSync(path.join(rs.row.worktree_path!, "node_modules"))).toBe(true);
    expect(gitHead(env.repo)).toBe(baseHead);
    expect(repoStatus()).toBe("");
  });

  it("the bad patch is blocked: the API layer imports storage (ARCH-001) and the hidden transfer tests fail", async () => {
    const { outcome, verification } = await run(offline({ patchFile: TS_PATCHES.bad, claimSuccess: true }));
    expect(outcome.state).toBe("FAILED");
    expect(verification!.commands.find((c) => c.command_id === "test_project")!.status).toBe("passed"); // the project's own tests still pass
    const rules = verification!.findings.filter((f) => f.severity === "blocking").map((f) => f.rule_id);
    expect(rules).toContain("ARCH-001");
    expect(verification!.commands.find((c) => c.command_id === "hidden_task_tests")!.status).toBe("failed");
    expect(gitHead(env.repo)).toBe(baseHead);
  });
});
