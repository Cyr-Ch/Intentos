import { describe, expect, it } from "vitest";
import { enclosingDefinitions, firstParagraphs, hunkRanges, linkPrecedent, pullRefsInText, sameFileByTail, type GraphLookup, type PrecedentRecord } from "../../src/knowledge/precedents.ts";
import { precedentFindings, PRECEDENT_RULE_IDS } from "../../src/verification/precedents.ts";
import type { EvidencePack, PrecedentHit } from "../../src/knowledge/retrieval.ts";

const SOURCE = `import warnings


def set_holidays(df, holidays):
    """Tag holidays."""
    if holidays is None:
        warnings.warn("no holidays")
    return df


class ElecSlp:
    def __init__(self, year):
        self.year = year

    def get_profile(self, df):

        return set_holidays(df, None)


def tail():
    pass
`.split("\n");

describe("enclosingDefinitions", () => {
  it("finds the function containing a changed line", () => {
    expect(enclosingDefinitions(SOURCE, 7)).toEqual(["set_holidays"]);
  });
  it("walks up through a class to its method", () => {
    expect(enclosingDefinitions(SOURCE, 17)).toEqual(["ElecSlp", "get_profile"]);
  });
  it("attributes a definition header to that definition and a blank line to the following block", () => {
    expect(enclosingDefinitions(SOURCE, 4)).toEqual(["set_holidays"]);
    expect(enclosingDefinitions(SOURCE, 16)).toEqual(["ElecSlp", "get_profile"]);
  });
  it("returns nothing for module-level lines", () => {
    expect(enclosingDefinitions(SOURCE, 1)).toEqual([]);
  });
});

describe("hunkRanges", () => {
  it("reads new-file ranges, including single-line and zero-line hunks", () => {
    const diff = "@@ -1,3 +1,4 @@\n+x\n@@ -10 +11 @@\n-y\n+z\n@@ -20,2 +22,0 @@\n-a\n-b\n";
    expect(hunkRanges(diff)).toEqual([
      { start: 1, count: 4 },
      { start: 11, count: 1 },
      { start: 22, count: 0 },
    ]);
  });
});

describe("pullRefsInText", () => {
  it("takes full pull request URLs from any repository", () => {
    expect(pullRefsInText("Resolved upstream by [#100](https://github.com/oemof/oemof-demand/pull/100) (author @x)", null)).toEqual([{ repo: "oemof/oemof-demand", number: 100 }]);
  });
  it("takes #n only when the text presents it as a pull request and a default repository is known", () => {
    expect(pullRefsInText("Addresses #84. Merged in #100.", "acme/repo")).toEqual([{ repo: "acme/repo", number: 100 }]);
    expect(pullRefsInText("Addresses #84.", "acme/repo")).toEqual([]);
    expect(pullRefsInText("PR #7 and pull request #8", null)).toEqual([]);
  });
});

describe("firstParagraphs", () => {
  it("drops the reconstruction footer and headings and cuts at a paragraph", () => {
    const body = "## Context\nFirst paragraph.\n\nSecond paragraph that is long enough to be cut somewhere in the middle of it.\n\n---\nResolved upstream by #1";
    const out = firstParagraphs(body, 40);
    expect(out).toBe("Context\nFirst paragraph.…");
    expect(firstParagraphs(body, 1000)).not.toContain("Resolved upstream");
  });
});

describe("sameFileByTail", () => {
  const files = new Set(["src/oemof/demand/bdew/elec_slp.py", "src/oemof/demand/tools.py", "examples/tools.py"]);
  it("maps a moved package file by its unique path tail", () => {
    expect(sameFileByTail("src/demandlib/bdew/elec_slp.py", files)).toBe("src/oemof/demand/bdew/elec_slp.py");
  });
  it("refuses an ambiguous tail", () => {
    expect(sameFileByTail("demandlib/tools.py", files)).toBeNull();
  });
  it("needs at least a directory and a name", () => {
    expect(sameFileByTail("elec_slp.py", files)).toBeNull();
  });
});

function record(diff: PrecedentRecord["pull"] extends infer P ? (P extends { diff: infer D } ? D : never) : never): PrecedentRecord {
  return {
    id: "PREC-1",
    number: 1,
    url: "https://github.com/acme/repo/issues/1",
    title: "Warn when a profile is created without holidays",
    body: "Without holidays every profile treats public holidays as weekdays.",
    labels: ["enhancement"],
    author: "a",
    created_at: "2026-01-01T00:00:00Z",
    closed_at: "2026-01-02T00:00:00Z",
    pull: { number: 2, url: "https://github.com/acme/repo/pull/2", title: "Warn when no holidays", body: null, author: "a", merged_at: "2026-01-02T00:00:00Z", merge_sha: "a".repeat(40), diff },
  };
}

function lookup(files: string[], symbols: Array<[string, string]>, tests: string[] = []): GraphLookup {
  const l: GraphLookup = { files: new Set(files), symbolByQn: new Map(), symbolsByPathName: new Map(), testByKey: new Map(tests.map((t) => [t, `TEST:${t}`])), moduleByPath: new Map() };
  for (const [qn, p] of symbols) {
    l.symbolByQn.set(qn, { id: `SY:${qn}`, path: p, line_start: 1, name: qn.split(".").pop()! });
    const k = `${p}\0${qn.split(".").pop()!}`;
    l.symbolsByPathName.set(k, [...(l.symbolsByPathName.get(k) ?? []), `SY:${qn}`]);
  }
  return l;
}

describe("linkPrecedent", () => {
  const diff = { base_sha: "b".repeat(40), files: [{ path: "pkg/tools.py", status: "modified" as const }, { path: "tests/test_tools.py", status: "modified" as const }], symbols: ["pkg.tools.set_holidays"], tests_added: [{ path: "tests/test_tools.py", name: "test_warning_without_holidays" }] };

  it("is current when the definition and the test still exist", () => {
    const a = linkPrecedent(record(diff), lookup(["pkg/tools.py", "tests/test_tools.py"], [["pkg.tools.set_holidays", "pkg/tools.py"]], ["tests/test_tools.py::test_warning_without_holidays"]), "EV-1");
    expect(a.staleness).toBe("current");
    expect(a.symbols[0]).toMatchObject({ symbol_id: "SY:pkg.tools.set_holidays", match: "exact", current: true });
    expect(a.tests_added[0]).toMatchObject({ test_id: "TEST:tests/test_tools.py::test_warning_without_holidays", current: true });
  });

  it("follows a traced rename to the definition's new qualified name", () => {
    const a = linkPrecedent(record(diff), lookup(["core/tools.py", "tests/test_tools.py"], [["core.tools.set_holidays", "core/tools.py"]]), "EV-1", new Map([["pkg/tools.py", "core/tools.py"]]));
    expect(a.staleness).toBe("current");
    expect(a.files[0]).toMatchObject({ current: true, renamed_to: "core/tools.py" });
    expect(a.symbols[0]).toMatchObject({ symbol_id: "SY:core.tools.set_holidays", match: "renamed" });
    expect(a.staleness_reasons.join(" ")).toContain("pkg/tools.py → core/tools.py");
  });

  it("falls back to the path tail when git traced no rename, then to the bare name inside that file", () => {
    const a = linkPrecedent(record(diff), lookup(["src/acme/pkg/tools.py"], [["acme.pkg.tools.Holidays.set_holidays", "src/acme/pkg/tools.py"]]), "EV-1");
    expect(a.files[0]).toMatchObject({ current: true, renamed_to: "src/acme/pkg/tools.py" });
    expect(a.symbols[0]).toMatchObject({ symbol_id: "SY:acme.pkg.tools.Holidays.set_holidays", match: "name" });
    expect(a.staleness).toBe("current");
  });

  it("is stale when none of the definitions exist any more, partially stale when some do", () => {
    const stale = linkPrecedent(record(diff), lookup(["pkg/tools.py"], [["pkg.tools.other", "pkg/tools.py"]]), "EV-1");
    expect(stale.staleness).toBe("stale");
    expect(stale.staleness_reasons[0]).toContain("none of the definitions");
    const two = { ...diff, symbols: ["pkg.tools.set_holidays", "pkg.tools.gone"] };
    const partial = linkPrecedent(record(two), lookup(["pkg/tools.py"], [["pkg.tools.set_holidays", "pkg/tools.py"]]), "EV-1");
    expect(partial.staleness).toBe("partially_stale");
  });

  it("is text-only without a linked diff", () => {
    const rec = record(diff);
    rec.pull = null;
    const a = linkPrecedent(rec, lookup([], []), "EV-1");
    expect(a.staleness).toBe("unlinked");
    expect(a.symbols).toEqual([]);
  });
});

describe("precedentFindings", () => {
  const hit = (over: Partial<PrecedentHit>): PrecedentHit => ({
    precedent_id: "PREC-1",
    number: 1,
    url: "u",
    title: "Warn when a profile is created without holidays",
    excerpt: null,
    labels: [],
    closed_at: null,
    pull: { number: 2, url: "p", title: "t", merged_at: null, merge_sha: null, author: null },
    files: [
      { path: "pkg/tools.py", status: "modified", current: true, is_test: false, renamed_to: null },
      { path: "tests/test_tools.py", status: "modified", current: true, is_test: true, renamed_to: null },
    ],
    symbols: [{ qualified_name: "pkg.tools.set_holidays", symbol_id: "SY:pkg.tools.set_holidays", path: "pkg/tools.py", line_start: 4, current: true, match: "exact" }],
    tests_added: [],
    staleness: "current",
    staleness_reasons: [],
    relevance: 1,
    reasons: [],
    evidence_id: "EV-P1",
    authority: "historical_precedent",
    basis: "fact",
    ...over,
  });
  const pack = (precedents: PrecedentHit[]) => ({ precedents }) as unknown as EvidencePack;
  let n = 0;
  const nextId = (p: string) => `${p}-${++n}`;

  it("reports FOLLOWED (info) when the change lands where the precedent did", () => {
    const f = precedentFindings(pack([hit({})]), [{ path: "pkg/tools.py", status: "modified" }], nextId);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule_id: PRECEDENT_RULE_IDS.followed, severity: "info", source_evidence_ids: ["EV-P1"] });
    expect(f[0]!.message).toContain("pkg.tools.set_holidays");
  });
  it("reports DIVERGENCE (review, never blocking) when it lands elsewhere", () => {
    const f = precedentFindings(pack([hit({})]), [{ path: "pkg/profiles.py", status: "modified" }, { path: "tests/test_x.py", status: "added" }], nextId);
    expect(f[0]).toMatchObject({ rule_id: PRECEDENT_RULE_IDS.diverged, severity: "review" });
    expect(f[0]!.message).toContain("pkg/profiles.py");
  });
  it("ignores weak, stale and test-only situations", () => {
    expect(precedentFindings(pack([hit({ relevance: 0.5 })]), [{ path: "pkg/profiles.py", status: "modified" }], nextId)).toEqual([]);
    expect(precedentFindings(pack([hit({ staleness: "stale" })]), [{ path: "pkg/profiles.py", status: "modified" }], nextId)).toEqual([]);
    expect(precedentFindings(pack([hit({})]), [{ path: "tests/test_tools.py", status: "modified" }], nextId)).toEqual([]);
  });
});
