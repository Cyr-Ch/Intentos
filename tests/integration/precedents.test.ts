import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { KnowledgeStore } from "../../src/knowledge/storage.ts";
import { indexRepository, repoIdFor } from "../../src/knowledge/indexer.ts";
import { loadIndexedRepo } from "../../src/knowledge/repo.ts";
import { buildEvidencePack } from "../../src/knowledge/retrieval.ts";
import { analyzePullDiff, precedentsFile, writePrecedentsFile, type PrecedentAttributes, type PrecedentsFile } from "../../src/knowledge/precedents.ts";
import { buildImplementationPrompt, buildPlanningPrompt } from "../../src/contracts/prompts.ts";
import { compileContract } from "../../src/contracts/compiler.ts";
import { buildOfflineContract } from "../../src/codex/offline.ts";
import { resolvePaths } from "../../src/config.ts";
import { renderEvidencePack } from "../../src/reports/explain.ts";

/**
 * A small repository whose history contains one "pull request": the commit that made `set_holidays` warn and added
 * a test. The precedents file links ticket #1 to that commit, exactly as `intentos precedents sync` would after
 * reading GitHub; here the file is written directly so the test needs no network.
 */
let home: string;
let repo: string;
let store: KnowledgeStore;
let prSha: string;
const TASK = "Raise an error instead of a warning when a profile is created without holidays";

function gitRun(args: string[]): string {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
}
function commit(message: string): string {
  gitRun(["add", "-A"]);
  gitRun(["commit", "-q", "-m", message]);
  return gitRun(["rev-parse", "HEAD"]);
}

const TOOLS_V1 = `import warnings


def set_holidays(df, holidays):
    """Tag public holidays in the frame."""
    df["holiday"] = False
    return df


def add_weekdays(df):
    df["weekday"] = 1
    return df
`;
const TOOLS_V2 = TOOLS_V1.replace('    df["holiday"] = False\n', '    if holidays is None:\n        warnings.warn("No holidays given, public holidays are treated as weekdays")\n    df["holiday"] = False\n');
const PROFILES = (pkg: string) => `from ${pkg}.tools import set_holidays


class ElecSlp:
    def __init__(self, year, holidays=None):
        self.year = year
        self.holidays = holidays

    def get_profile(self, df):
        return set_holidays(df, self.holidays)
`;
const TEST_V1 = (pkg: string) => `from ${pkg}.tools import set_holidays


def test_set_holidays_adds_column():
    assert set_holidays({}, []) == {"holiday": False}
`;
const TEST_V2 = (pkg: string) => `${TEST_V1(pkg)}

def test_warning_without_holidays():
    import warnings
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        set_holidays({}, None)
    assert w
`;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "intentos-precedents-"));
  process.env.INTENTOS_HOME = home;
  repo = path.join(home, "repo");
  fs.mkdirSync(repo);
  gitRun(["init", "-q", "-b", "main"]);
  write("pkg/__init__.py", "");
  write("pkg/tools.py", TOOLS_V1);
  write("pkg/profiles.py", PROFILES("pkg"));
  write("tests/__init__.py", "");
  write("tests/test_tools.py", TEST_V1("pkg"));
  write("README.md", "# demo\n");
  commit("base");
  write("pkg/tools.py", TOOLS_V2);
  write("tests/test_tools.py", TEST_V2("pkg"));
  prSha = commit("Warn when a profile is created without holidays (#1)");
  write("README.md", "# demo\n\nlater\n");
  commit("unrelated docs");

  const repoId = repoIdFor(repo);
  const file: PrecedentsFile = {
    version: 1,
    repo_id: repoId,
    source: { issues: "acme/demo", pulls: null, synced_at: "2026-01-03T00:00:00Z", tool: "test" },
    precedents: [
      {
        id: "PREC-1",
        number: 1,
        url: "https://github.com/acme/demo/issues/1",
        title: "Warn when a profile is created without holidays",
        body: "## Context\nWithout the `holidays` argument every profile class treats public holidays as the weekday they fall on.\n\n## What to do\nEmit a UserWarning in set_holidays when holidays is None.\n\n---\nResolved upstream by #2",
        labels: ["enhancement"],
        author: "a",
        created_at: "2026-01-01T00:00:00Z",
        closed_at: "2026-01-02T00:00:00Z",
        pull: { number: 2, url: "https://github.com/acme/demo/pull/2", title: "Warn when no holidays are given", body: null, author: "a", merged_at: "2026-01-02T00:00:00Z", merge_sha: prSha, diff: analyzePullDiff(repo, prSha) },
      },
      {
        id: "PREC-2",
        number: 2,
        url: "https://github.com/acme/demo/issues/2",
        title: "Update the CI Python matrix",
        body: "Test on 3.11 and 3.12.",
        labels: ["maintenance"],
        author: "a",
        created_at: "2026-01-01T00:00:00Z",
        closed_at: "2026-01-02T00:00:00Z",
        pull: null,
      },
    ],
  };
  writePrecedentsFile(precedentsFile(resolvePaths(), repoId), file);
  store = new KnowledgeStore(path.join(home, "intentos.db"));
});
afterAll(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function precedentNode(id: string): PrecedentAttributes {
  const indexed = loadIndexedRepo(store, repo);
  const n = store.node(indexed.repo.id, indexed.revision, id);
  if (!n) throw new Error(`${id} missing`);
  return JSON.parse(n.attributes_json) as PrecedentAttributes;
}

describe("precedents", () => {
  it("reads what the pull request changed from the local history", () => {
    const diff = analyzePullDiff(repo, prSha)!;
    expect(diff.files.map((f) => f.path).sort()).toEqual(["pkg/tools.py", "tests/test_tools.py"]);
    expect(diff.symbols).toEqual(["pkg.tools.set_holidays"]);
    expect(diff.tests_added).toEqual([{ path: "tests/test_tools.py", name: "test_warning_without_holidays" }]);
    expect(analyzePullDiff(repo, "0".repeat(40))).toBeNull();
  });

  it("links precedents to the graph at index time with evidence, TOUCHES and ADDS_TEST edges", () => {
    const summary = indexRepository(store, repo);
    expect(summary.precedents).toMatchObject({ total: 2, current: 1, unlinked: 1, stale: 0, partially_stale: 0 });
    expect(summary.counts["nodes.precedent"]).toBe(2);
    const indexed = loadIndexedRepo(store, repo);
    const a = precedentNode("PREC-1");
    expect(a.staleness).toBe("current");
    expect(a.symbols[0]).toMatchObject({ symbol_id: "SY:pkg.tools.set_holidays", current: true, match: "exact" });
    expect(a.tests_added[0]!.current).toBe(true);
    const edges = store.edges(indexed.repo.id, indexed.revision).filter((e) => e.from_node === "PREC-1");
    expect(edges.some((e) => e.relation === "TOUCHES" && e.to_node === "SY:pkg.tools.set_holidays")).toBe(true);
    expect(edges.some((e) => e.relation === "ADDS_TEST" && e.to_node === a.tests_added[0]!.test_id)).toBe(true);
    const ev = store.evidenceById(indexed.repo.id, indexed.revision, a.evidence_id)!;
    expect(ev).toMatchObject({ source_type: "precedent", authority: "historical_precedent", status: "supported", source_ref: "https://github.com/acme/demo/issues/1" });
    expect(precedentNode("PREC-2").staleness).toBe("unlinked");
  });

  it("explain ranks the similar ticket first, with its location, test and a suggestion; the planner can cite it", () => {
    const indexed = loadIndexedRepo(store, repo);
    const pack = buildEvidencePack(store, indexed, TASK);
    expect(pack.precedents[0]).toMatchObject({ precedent_id: "PREC-1", relevance: 1, staleness: "current" });
    expect(pack.precedents.map((p) => p.precedent_id)).not.toContain("PREC-2");
    const lead = pack.precedents[0]!;
    expect(lead.reasons.join(" ")).toMatch(/pkg\.tools\.set_holidays|title matches/);
    expect(pack.evidence_index[lead.evidence_id]).toMatchObject({ source_type: "precedent", authority: "historical_precedent" });
    expect(pack.suggestions.some((s) => s.text.includes("Precedent #1") && s.text.includes("pkg.tools.set_holidays"))).toBe(true);
    const rendered = renderEvidencePack(pack);
    expect(rendered).toContain("## Precedents");
    expect(rendered).toContain("test_warning_without_holidays");

    const prompt = buildPlanningPrompt(TASK, pack, { hasTaskTests: false });
    expect(prompt).toContain("## Precedents");
    expect(prompt).toContain(lead.evidence_id);
    expect(prompt).toContain("history, never policy");

    // A contract may cite the precedent's evidence id like any other evidence; the compiler knows it.
    const contract = buildOfflineContract(pack, { route: "implement", patchFile: null, claimSuccess: false, fabricateEvidence: false, repairPatchFile: null, taskId: "task-precedent" });
    contract.requirements[0]!.evidence_ids.push(lead.evidence_id);
    const compiled = compileContract(contract, pack, indexed.policy, { hasTaskTests: false });
    expect(compiled.issues.filter((i) => i.code === "unknown_evidence")).toEqual([]);
    const impl = buildImplementationPrompt(contract, pack, TASK);
    expect(impl).toContain("## Precedents");
    expect(impl).toContain("cited by the contract");
    expect(impl).toContain("pkg/tools.py");
  });

  it("survives a package rename: the precedent follows the file and the definition to their new names", () => {
    gitRun(["mv", "pkg", "core"]);
    write("core/profiles.py", PROFILES("core"));
    write("tests/test_tools.py", TEST_V2("core"));
    commit("rename package to core");
    const summary = indexRepository(store, repo);
    expect(summary.precedents).toMatchObject({ current: 1 });
    const a = precedentNode("PREC-1");
    expect(a.staleness).toBe("current");
    expect(a.files.find((f) => f.path === "pkg/tools.py")).toMatchObject({ current: true, renamed_to: "core/tools.py" });
    expect(a.symbols[0]).toMatchObject({ symbol_id: "SY:core.tools.set_holidays", current: true });
    expect(["renamed", "name"]).toContain(a.symbols[0]!.match);
    const pack = buildEvidencePack(store, loadIndexedRepo(store, repo), TASK);
    expect(pack.precedents[0]!.precedent_id).toBe("PREC-1");
    expect(renderEvidencePack(pack)).toContain("core.tools.set_holidays");
  });

  it("goes stale when the definition it changed is removed, and explain says so as a conflict", () => {
    write("core/tools.py", "def add_weekdays(df):\n    df[\"weekday\"] = 1\n    return df\n");
    write("core/profiles.py", "class ElecSlp:\n    def __init__(self, year, holidays=None):\n        self.year = year\n");
    write("tests/test_tools.py", "from core.tools import add_weekdays\n\n\ndef test_add_weekdays():\n    assert add_weekdays({}) == {\"weekday\": 1}\n");
    commit("drop holiday handling");
    const summary = indexRepository(store, repo);
    expect(summary.precedents).toMatchObject({ stale: 1 });
    const a = precedentNode("PREC-1");
    expect(a.staleness).toBe("stale");
    expect(a.symbols[0]!.current).toBe(false);
    const indexed = loadIndexedRepo(store, repo);
    expect(store.evidenceById(indexed.repo.id, indexed.revision, a.evidence_id)!.status).toBe("superseded");
    const pack = buildEvidencePack(store, indexed, TASK);
    const hit = pack.precedents.find((p) => p.precedent_id === "PREC-1");
    expect(hit?.staleness).toBe("stale");
    expect(pack.conflicts.some((c) => c.kind === "stale_precedent" && c.ids.includes("PREC-1"))).toBe(true);
    expect(pack.suggestions.some((s) => s.text.startsWith("Precedent #1"))).toBe(false);
  });
});
