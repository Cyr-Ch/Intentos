import { describe, expect, it } from "vitest";
import { parseJunit } from "../../src/verification/junit.ts";

const XML = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="0" failures="1" skipped="0" tests="3">
<testcase classname="tests.test_a" name="test_ok" file="tests/test_a.py" line="3" time="0.001" />
<testcase classname="tests.test_a" name="test_bad" file="tests/test_a.py" line="7" time="0.002"><failure message="assert 1 == 2&#10;left: 1">traceback here</failure></testcase>
<testcase classname="tests.test_a" name="test_skip" time="0"><skipped type="pytest.skip" message="no" /></testcase>
</testsuite></testsuites>`;

describe("junit parser", () => {
  it("extracts statuses and messages", () => {
    const cases = parseJunit(XML);
    expect(cases.map((c) => c.status)).toEqual(["passed", "failed", "skipped"]);
    expect(cases[1]!.message).toContain("assert 1 == 2");
    expect(cases[1]!.file).toBe("tests/test_a.py");
  });
});
