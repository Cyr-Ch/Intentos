import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../../src/config.ts";
import { PolicySchema } from "../../src/knowledge/policy.ts";
import { renderEditedPolicy } from "../../src/dashboard.ts";
import YAML from "yaml";

describe("dashboard policy edits", () => {
  const before = fs.readFileSync(path.join(PROJECT_ROOT, "policies", "oemof_demand.yaml"), "utf8");
  const policy = PolicySchema.parse(YAML.parse(before));
  const original = policy.invariants[0]!;
  const policy_hash = crypto.createHash("sha256").update(before).digest("hex");

  it("validates an edited rule while preserving its test bindings and sources", () => {
    const next = renderEditedPolicy(before, { kind: "invariants", id: original.id, statement: `${original.statement} Reviewed.`, enforcement: "advisory", policy_hash });
    const edited = PolicySchema.parse(YAML.parse(next));
    expect(edited.invariants[0]).toMatchObject({ id: original.id, statement: `${original.statement} Reviewed.`, enforcement: "advisory", verified_by: original.verified_by, sources: original.sources });
    expect(edited.invariants).toHaveLength(policy.invariants.length);
  });

  it("refuses to overwrite a policy changed since the page loaded", () => {
    expect(() => renderEditedPolicy(before, { kind: "invariants", id: original.id, statement: "Changed", enforcement: "blocking", policy_hash: "old" })).toThrow(/changed since/);
  });
});
