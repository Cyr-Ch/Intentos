import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { resolvePaths } from "../config.ts";
import { fileExists } from "../util/paths.ts";

/**
 * Trusted policy configuration. Policies live in the IntentOS checkout
 * (`policies/*.yaml`), never inside the target repository, so repository text
 * cannot promote itself to authoritative policy.
 */

export const SourceRefSchema = z.object({
  path: z.string(),
  heading: z.string().optional(),
  line_start: z.number().int().optional(),
  line_end: z.number().int().optional(),
  /** Optional pin: if the section hash differs at index time the source is flagged `conflicted`. */
  content_sha256: z.string().optional(),
});

export const CommandSchema = z.object({
  description: z.string(),
  track: z.enum(["functional", "architecture", "business_invariant", "scope"]),
  /** argv with placeholders: {python}, {snapshot}, {hidden_tests_dir}, {junit}, {node_modules} (the repository's node_modules). */
  argv: z.array(z.string()).optional(),
  /** Extra environment for the command (same placeholders), e.g. JEST_JUNIT_OUTPUT_FILE={junit} for jest-junit. */
  env: z.record(z.string(), z.string()).default({}),
  /** Built-in verifier implemented in TypeScript/Python instead of a shell command. */
  builtin: z.enum(["architecture_rules", "counterexamples", "scope_check", "architecture_surprise"]).optional(),
  timeout_s: z.number().int().positive().default(300),
  /** Blocking commands gate review_ready; advisory ones only produce findings. */
  enforcement: z.enum(["blocking", "advisory"]).default("blocking"),
  /** Only applicable when the task defines hidden task tests. */
  requires_task_tests: z.boolean().default(false),
  required: z.boolean().default(true),
});

export const InvariantSchema = z.object({
  id: z.string().regex(/^INV-\d{3,}$/),
  statement: z.string(),
  scope: z.array(z.string()).default([]),
  /** Repo path globs this invariant applies to; used to decide applicability from affected files. */
  applies_to_paths: z.array(z.string()).default([]),
  authority: z.enum(["approved_policy", "approved_decision", "executable_contract"]),
  approved_by: z.string(),
  sources: z.array(SourceRefSchema).min(1),
  verified_by: z.array(z.string()).default([]),
  enforcement: z.enum(["blocking", "advisory"]).default("blocking"),
});

export const ArchitectureRuleSchema = z.object({
  id: z.string().regex(/^ARCH-\d{3,}$/),
  kind: z.enum(["forbidden_import", "forbidden_call", "frozen_paths", "required_import", "forbidden_names"]),
  statement: z.string(),
  paths: z.array(z.string()).default([]),
  forbidden_modules: z.array(z.string()).default([]),
  /** For forbidden_call: dotted attribute/function names (suffix match on the callee). */
  forbidden_callees: z.array(z.string()).default([]),
  /** Paths exempt from a forbidden_call rule (where the call is allowed). */
  allowed_paths: z.array(z.string()).default([]),
  /** For required_import: files matching `paths` that define functions must import one of these. */
  required_modules: z.array(z.string()).default([]),
  /** For forbidden_names: dotted names (suffix match) that must not appear, e.g. sys.argv, os._exit. */
  forbidden_names: z.array(z.string()).default([]),
  /** For forbidden_names: case-insensitive substrings forbidden in string literals, e.g. "junit". */
  forbidden_literals: z.array(z.string()).default([]),
  authority: z.enum(["approved_policy", "approved_decision", "executable_contract"]),
  approved_by: z.string(),
  sources: z.array(SourceRefSchema).default([]),
  enforcement: z.enum(["blocking", "advisory"]).default("blocking"),
  scope: z.array(z.string()).default([]),
});

export const PolicyDecisionSchema = z.object({
  id: z.string().regex(/^DEC-\d{3,}$/),
  statement: z.string(),
  status: z.enum(["approved", "superseded", "proposed", "rejected"]),
  scope: z.array(z.string()).default([]),
  approved_by: z.string().optional(),
  sources: z.array(SourceRefSchema).default([]),
  supersedes: z.string().optional(),
  rationale: z.string().optional(),
});

export const CounterexampleSchema = z.object({
  id: z.string().regex(/^CX-\d{3,}$/),
  invariant: z.string(),
  description: z.string(),
  /** Python test body template. Placeholders `{name}` are substituted from the grid. */
  template: z.string(),
  grid: z.record(z.string(), z.array(z.union([z.string(), z.number()]))),
  /** Exploratory probes never block; authoritative ones require approved sources. */
  authority: z.enum(["exploratory", "authoritative"]).default("exploratory"),
  max_cases: z.number().int().positive().default(50),
});

/** Defaults for the architectural-surprise detectors (used when the policy omits the block or a field). */
export const SURPRISE_DEFAULTS = { api_paths: ["app/api/**"], domain_paths: ["app/domain/**"], ignore_names: [] as string[] };

export const ArchitectureSurpriseSchema = z.object({
  /** Files that form the API layer (domain objects should not be constructed there). */
  api_paths: z.array(z.string()).default(SURPRISE_DEFAULTS.api_paths),
  /** Files that define domain objects. */
  domain_paths: z.array(z.string()).default(SURPRISE_DEFAULTS.domain_paths),
  /** Function names never reported as duplicate helpers. */
  ignore_names: z.array(z.string()).default(SURPRISE_DEFAULTS.ignore_names),
});

export const PolicySchema = z.object({
  schema_version: z.literal("1.0"),
  policy_id: z.string(),
  applies_to: z.object({
    project_name: z.string().optional(),
    path_basename: z.string().optional(),
  }),
  description: z.string().optional(),
  /** Primary language of the repository: decides which hidden-test shape, test runner and AST checker apply. */
  language: z.enum(["python", "typescript"]).default("python"),
  /** Globs the implementer may edit (the universe for contract allowed_paths). */
  default_allowed_paths: z.array(z.string()).min(1),
  /** Globs the implementer must never edit (in addition to global protections). */
  protected_paths: z.array(z.string()).default([]),
  /** Module scope tags by path glob, e.g. { "app/services/pricing.py": ["pricing","billing"] }. */
  scope_tags: z.record(z.string(), z.array(z.string())).default({}),
  commands: z.record(z.string(), CommandSchema),
  invariants: z.array(InvariantSchema).default([]),
  architecture_rules: z.array(ArchitectureRuleSchema).default([]),
  decisions: z.array(PolicyDecisionSchema).default([]),
  counterexamples: z.array(CounterexampleSchema).default([]),
  /** Task-term synonyms to improve lexical retrieval. */
  synonyms: z.record(z.string(), z.array(z.string())).default({}),
  /** Architectural-surprise review signals (spec §7.5): optional block, defaults apply when absent. */
  architecture_surprise: ArchitectureSurpriseSchema.default(SURPRISE_DEFAULTS),
});

export type Policy = z.infer<typeof PolicySchema>;
export type PolicyInvariant = z.infer<typeof InvariantSchema>;
export type PolicyArchitectureRule = z.infer<typeof ArchitectureRuleSchema>;
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export type PolicyCommand = z.infer<typeof CommandSchema>;
export type SourceRef = z.infer<typeof SourceRefSchema>;

/** Placeholder values for a command's argv/env: {python} {snapshot} {hidden_tests_dir} {junit} {node} {node_modules}. */
export interface CommandVars {
  python: string;
  snapshot: string;
  hidden_tests_dir: string;
  junit: string;
  node?: string;
  node_modules?: string;
}

/** Substitute the placeholders in one string. `{node}` defaults to the running Node binary, `{node_modules}` to `<snapshot>/node_modules`. */
export function fillPlaceholders(s: string, vars: CommandVars): string {
  const node = vars.node ?? process.execPath;
  const nodeModules = vars.node_modules ?? path.join(vars.snapshot, "node_modules");
  return s.replaceAll("{python}", vars.python).replaceAll("{snapshot}", vars.snapshot).replaceAll("{hidden_tests_dir}", vars.hidden_tests_dir).replaceAll("{junit}", vars.junit).replaceAll("{node}", node).replaceAll("{node_modules}", nodeModules);
}

export function fillArgv(argv: string[], vars: CommandVars): string[] {
  return argv.map((a) => fillPlaceholders(a, vars));
}

export function fillEnv(env: Record<string, string>, vars: CommandVars): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, fillPlaceholders(v, vars)]));
}

/** The functional project-suite command: `pytest_project` (Python) or `test_project` (TypeScript), whichever the policy has. */
export function projectTestCommand(policy: Policy): { name: string; cmd: PolicyCommand } | null {
  for (const name of ["pytest_project", "test_project"]) {
    const cmd = policy.commands[name];
    if (cmd?.argv) return { name, cmd };
  }
  const entry = Object.entries(policy.commands).find(([, c]) => c.track === "functional" && c.argv && !c.requires_task_tests && !c.argv.some((a) => a.includes("{hidden_tests_dir}")));
  return entry ? { name: entry[0], cmd: entry[1] } : null;
}

export function loadPolicyFile(file: string): Policy {
  const raw = YAML.parse(fs.readFileSync(file, "utf8"));
  const parsed = PolicySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid policy ${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

export function loadAllPolicies(dir = resolvePaths().policies): Policy[] {
  if (!fileExists(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort()
    .map((f) => loadPolicyFile(path.join(dir, f)));
}

/** The project names a repository declares: `[project].name` in pyproject.toml and `name` in package.json. */
function projectNames(repoPath: string): string[] {
  const names: string[] = [];
  const pyproject = path.join(repoPath, "pyproject.toml");
  if (fileExists(pyproject)) {
    const m = fs.readFileSync(pyproject, "utf8").match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (m?.[1]) names.push(m[1]);
  }
  const pkg = path.join(repoPath, "package.json");
  if (fileExists(pkg)) {
    try {
      const name = (JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: unknown }).name;
      if (typeof name === "string" && name) names.push(name);
    } catch {
      /* unreadable package.json: fall back to the basename match */
    }
  }
  return names;
}

/** Find the trusted policy applicable to a repository, or null when none matches. */
export function policyForRepo(repoPath: string, policies = loadAllPolicies()): Policy | null {
  const names = projectNames(repoPath);
  const base = path.basename(path.resolve(repoPath));
  for (const p of policies) {
    if (p.applies_to.project_name && names.includes(p.applies_to.project_name)) return p;
  }
  for (const p of policies) {
    if (p.applies_to.path_basename && p.applies_to.path_basename === base) return p;
  }
  return null;
}

/** A minimal fallback policy for repositories without trusted configuration. */
export function fallbackPolicy(repoPath: string): Policy {
  return PolicySchema.parse({
    schema_version: "1.0",
    policy_id: `fallback:${path.basename(path.resolve(repoPath))}`,
    applies_to: { path_basename: path.basename(path.resolve(repoPath)) },
    description: "Auto-generated fallback policy: no approved invariants or architecture rules are known for this repository.",
    default_allowed_paths: ["**"],
    protected_paths: [],
    commands: {
      pytest_project: {
        description: "Project pytest suite (editable by the implementer; lower authority than hidden tests)",
        track: "functional",
        argv: ["{python}", "-m", "pytest", "-q", "-p", "no:cacheprovider", "-o", "pythonpath=.", "--junit-xml={junit}"],
        timeout_s: 600,
      },
      scope_check: { description: "Changed files must stay inside allowed paths", track: "scope", builtin: "scope_check" },
      architecture_surprise: { description: "Architectural-surprise review signals: new cross-module dependencies, duplicate helpers, domain construction in the API layer (advisory)", track: "architecture", builtin: "architecture_surprise", enforcement: "advisory" },
    },
  });
}
