import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendRoleSkills, captureAgentSnapshot, deleteCustomSkill, listCustomSkills, readAgentConfig, saveCustomSkill, updateRoleSettings } from "../../src/agent-skills.ts";

let home: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.INTENTOS_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "intentos-agent-skills-"));
  process.env.INTENTOS_HOME = home;
});
afterEach(() => {
  if (previous === undefined) delete process.env.INTENTOS_HOME;
  else process.env.INTENTOS_HOME = previous;
  fs.rmSync(home, { recursive: true, force: true });
});

const skill = { id: "careful-api", title: "Careful API changes", description: "Check callers after public API changes.", instructions: "Before editing a public function, inspect its callers and update affected tests." };

describe("agent skills", () => {
  it("stores text skills, assigns them to a role, and captures immutable instructions", () => {
    saveCustomSkill(skill);
    const config = updateRoleSettings("planner", { model: "gpt-6-luna", reasoning: "low", skills: [skill.id] });
    expect(config.roles.planner.model).toBe("gpt-6-luna");
    expect(listCustomSkills()).toEqual([skill]);
    const frozen = captureAgentSnapshot();
    expect(frozen.roles.planner.skills[0]).toMatchObject({ id: skill.id, instructions: skill.instructions, sha256: expect.any(String) });
    expect(appendRoleSkills("Base prompt", frozen.roles.planner)).toContain(skill.instructions);
    saveCustomSkill({ ...skill, instructions: "Updated instructions for later runs only." });
    expect(frozen.roles.planner.skills[0]?.instructions).toBe(skill.instructions);
    expect(captureAgentSnapshot().roles.planner.skills[0]?.instructions).toContain("Updated instructions");
    deleteCustomSkill(skill.id);
    expect(readAgentConfig().roles.planner.skills).toEqual([]);
  });

  it("rejects path traversal, unknown assignments, and a side model matching the implementer", () => {
    expect(() => saveCustomSkill({ ...skill, id: "../outside" })).toThrow();
    expect(() => updateRoleSettings("planner", { model: null, reasoning: null, skills: ["missing-skill"] })).toThrow(/does not exist/);
    updateRoleSettings("implementer", { model: "gpt-6-luna", reasoning: null, skills: [] });
    expect(() => updateRoleSettings("miner", { model: "gpt-6-luna", reasoning: null, skills: [] })).toThrow(/must differ/);
  });
});
