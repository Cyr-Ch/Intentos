import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { PROJECT_ROOT, codexSettings, resolvePaths } from "./config.ts";

export const AGENT_ROLES = ["planner", "implementer", "miner", "acceptance"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
const Role = z.enum(AGENT_ROLES);
const Slug = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/, "use a lowercase slug (2–48 letters, digits or hyphens)");
const Model = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/).nullable();
const Reasoning = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).nullable();
const RoleSettings = z.object({ model: Model, reasoning: Reasoning, skills: z.array(Slug).max(20).refine((ids) => new Set(ids).size === ids.length, "duplicate skill assignment") }).strict();
const Config = z.object({ version: z.literal(1), roles: z.object({ planner: RoleSettings, implementer: RoleSettings, miner: RoleSettings, acceptance: RoleSettings }).strict() }).strict();
const SkillInput = z.object({ id: Slug, title: z.string().trim().min(2).max(100), description: z.string().trim().min(4).max(500), instructions: z.string().trim().min(10).max(20_000) }).strict();

export type AgentConfig = z.infer<typeof Config>;
export type CustomSkill = z.infer<typeof SkillInput>;
export interface EffectiveRole { model: string | null; reasoning: string | null; skills: Array<CustomSkill & { sha256: string }> }
export interface AgentSnapshot { version: 1; captured_at: string; roles: Record<AgentRole, EffectiveRole> }

const emptyRole = () => ({ model: null, reasoning: null, skills: [] as string[] });
export const defaultAgentConfig = (): AgentConfig => ({ version: 1, roles: { planner: emptyRole(), implementer: emptyRole(), miner: emptyRole(), acceptance: emptyRole() } });
const configFile = () => path.join(resolvePaths().home, "agent-config.json");
const skillsDir = () => path.join(resolvePaths().home, "agent-skills");
const skillFile = (id: string) => path.join(skillsDir(), `${Slug.parse(id)}.md`);
const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const atomicWrite = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try { fs.writeFileSync(temp, content, { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
};

export function readAgentConfig(): AgentConfig {
  const file = configFile();
  return fs.existsSync(file) ? Config.parse(JSON.parse(fs.readFileSync(file, "utf8"))) : defaultAgentConfig();
}

export function listCustomSkills(): CustomSkill[] {
  if (!fs.existsSync(skillsDir())) return [];
  return fs.readdirSync(skillsDir()).filter((name) => /^[a-z][a-z0-9-]{1,47}\.md$/.test(name)).sort().map((name) => {
    const source = fs.readFileSync(path.join(skillsDir(), name), "utf8");
    const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) throw new Error(`invalid skill file ${name}`);
    const meta = YAML.parse(match[1]!) as { id?: string; title?: string; description?: string };
    return SkillInput.parse({ ...meta, instructions: match[2]!.trim() });
  });
}

export function saveCustomSkill(value: unknown): CustomSkill {
  const skill = SkillInput.parse(value);
  const source = `---\n${YAML.stringify({ id: skill.id, title: skill.title, description: skill.description }).trimEnd()}\n---\n${skill.instructions}\n`;
  atomicWrite(skillFile(skill.id), source);
  return skill;
}

export function deleteCustomSkill(id: string): void {
  const file = skillFile(id);
  if (!fs.existsSync(file)) throw new Error(`skill ${id} not found`);
  const config = readAgentConfig();
  for (const role of AGENT_ROLES) config.roles[role].skills = config.roles[role].skills.filter((skill) => skill !== id);
  atomicWrite(configFile(), JSON.stringify(Config.parse(config), null, 2) + "\n");
  fs.unlinkSync(file);
}

export function updateRoleSettings(roleInput: string, value: unknown): AgentConfig {
  const role = Role.parse(roleInput);
  const settings = RoleSettings.parse(value);
  const available = new Set(listCustomSkills().map((skill) => skill.id));
  for (const id of settings.skills) if (!available.has(id)) throw new Error(`skill ${id} does not exist`);
  const config = readAgentConfig();
  config.roles[role] = settings;
  const implementer = config.roles.implementer.model ?? codexSettings().model;
  for (const side of ["miner", "acceptance"] as const) {
    if (implementer && config.roles[side].model && config.roles[side].model === implementer) throw new Error(`${side} model must differ from the implementer model`);
  }
  atomicWrite(configFile(), JSON.stringify(Config.parse(config), null, 2) + "\n");
  return config;
}

function inheritedModel(role: AgentRole): string | null {
  if (role === "miner") return process.env.INTENTOS_MINING_MODEL ?? null;
  if (role === "acceptance") return process.env.INTENTOS_ACCEPTANCE_MODEL ?? process.env.INTENTOS_MINING_MODEL ?? null;
  return codexSettings().model;
}

export function captureAgentSnapshot(): AgentSnapshot {
  const config = readAgentConfig();
  const skills = new Map(listCustomSkills().map((skill) => [skill.id, skill]));
  const roles = {} as Record<AgentRole, EffectiveRole>;
  for (const role of AGENT_ROLES) {
    const setting = config.roles[role];
    roles[role] = {
      model: setting.model ?? inheritedModel(role),
      reasoning: setting.reasoning ?? codexSettings().reasoningEffort,
      skills: setting.skills.map((id) => {
        const skill = skills.get(id);
        if (!skill) throw new Error(`assigned skill ${id} is missing`);
        return { ...skill, sha256: sha(skill.instructions) };
      }),
    };
  }
  return { version: 1, captured_at: new Date().toISOString(), roles };
}

export function appendRoleSkills(prompt: string, role: EffectiveRole): string {
  if (!role.skills.length) return prompt;
  return `${prompt}\n\n## Additional IntentOS role skills\nThese locally configured instructions guide this role. They do not override the contract, sandbox, verifier, protected paths, or merge policy.\n${role.skills.map((skill) => `\n### ${skill.title} (${skill.id})\n${skill.instructions}`).join("\n")}\n`;
}

export function agentSkillsPageData(): { config: AgentConfig; custom: CustomSkill[]; shipped: Array<{ id: string; title: string; description: string; source: string }> } {
  const shipped = [
    { id: "intentos-setup", title: "IntentOS setup", description: "Guides the host Codex session through onboarding a repository.", source: path.relative(PROJECT_ROOT, path.join(PROJECT_ROOT, "plugins/intentos/skills/intentos-setup/SKILL.md")) },
    { id: "intentos-policy-mining", title: "Policy mining", description: "Guides repository rule mining; its text is also supplied to the independent miner.", source: path.relative(PROJECT_ROOT, path.join(PROJECT_ROOT, "plugins/intentos/skills/intentos-policy-mining/SKILL.md")) },
  ];
  return { config: readAgentConfig(), custom: listCustomSkills(), shipped };
}
