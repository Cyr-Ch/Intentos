import { describe, expect, it } from "vitest";
import { expandQuery } from "../../src/knowledge/retrieval.ts";
import { fallbackPolicy } from "../../src/knowledge/policy.ts";

describe("expandQuery", () => {
  it("survives task words that are Object.prototype properties", () => {
    const policy = fallbackPolicy(process.cwd());
    for (const word of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
      const q = expandQuery(`the ${word} fails when warnings are escalated`, policy);
      expect(q.primary).toContain("fails");
      expect(Array.isArray(q.expanded)).toBe(true);
    }
  });
});
