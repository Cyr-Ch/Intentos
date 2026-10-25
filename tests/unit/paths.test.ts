import { describe, expect, it } from "vitest";
import { globToRegExp, isSafeRelativePattern, matchesAny } from "../../src/util/paths.ts";

describe("glob matching", () => {
  it("matches ** across directories", () => {
    expect(matchesAny("app/services/pricing.py", ["app/**"])).toBe(true);
    expect(matchesAny("app/services/pricing.py", ["app/**/*.py"])).toBe(true);
    expect(matchesAny("docs/adr-001.md", ["app/**"])).toBe(false);
    expect(matchesAny("app/x.py", ["app/*.py"])).toBe(true);
    expect(matchesAny("app/a/x.py", ["app/*.py"])).toBe(false);
  });
  it("compiles ** alone to match anything", () => {
    expect(globToRegExp("**").test("any/thing/here.py")).toBe(true);
  });
  it("rejects traversal and absolute paths", () => {
    expect(isSafeRelativePattern("../etc/passwd")).toBe(false);
    expect(isSafeRelativePattern("app/../../x")).toBe(false);
    expect(isSafeRelativePattern("/abs/path")).toBe(false);
    expect(isSafeRelativePattern("app/**")).toBe(true);
    expect(isSafeRelativePattern("")).toBe(false);
  });
});
