import fs from "node:fs";
import path from "node:path";
import { LiveCodexEngine, type CodingEngine, type ImplementResult, type PlanRequest, type PlanResult } from "./codex/adapter.ts";
import { ensureHome, resolvePaths } from "./config.ts";
import { repoIdFor } from "./knowledge/indexer.ts";
import { policyIdFor, runProbe } from "./onboard.ts";
import { EVIDENCE_TYPES, ingestProposals, loadDigest, SKILL_NAME, skillText, type Author, type ProposeResult } from "./propose.ts";
import { renderDigest, type Candidate, type EvidenceDigest } from "./candidates.ts";
import { isGitRepo } from "./util/git.ts";
import { redact } from "./util/redact.ts";
import { appendRoleSkills, captureAgentSnapshot } from "./agent-skills.ts";

/**
 * The independent miner. The same `intentos-policy-mining` skill the host agent follows, run by IntentOS in a separate
 * read-only Codex thread with a model the user names, so that the model that finds the rules is not the model that
 * later implements changes under them, and so that a second model's reading of the repository can be put next to the
 * first's. The thread reads the repository and answers with candidates as structured output; `ingestProposals` checks
 * and tests them exactly as it does for the host's `propose`; the rejections go back to the same thread for one more
 * round. The review list records the author (`via: side_thread`, the model, the thread id) so the reviewer sees who
 * mined what.
 */

export interface MineOptions {
  /** Codex model slug for the side thread; default `INTENTOS_MINING_MODEL`. Required unless `engine` is given. */
  model?: string | null;
  /** Reasoning effort for the side thread; undefined keeps `INTENTOS_CODEX_REASONING`, null the model's own default. */
  reasoningEffort?: string | null;
  policyId?: string;
  policyFile?: string;
  outDir?: string;
  /** Add to the current review list (a second opinion next to the host's candidates) instead of replacing it. */
  append?: boolean;
  /** Rounds at most, the first included (default 2: one submission, one fix of what was rejected). */
  rounds?: number;
  /** A stand-in for the Codex SDK (tests, `--replay`). */
  engine?: CodingEngine;
  runTests?: boolean;
}

export interface MineRound {
  round: number;
  proposed: number;
  accepted: number;
  rejected: number;
  usage: unknown;
}

export interface MineResult {
  repo_path: string;
  policy_id: string;
  head: string;
  model: string | null;
  engine: string;
  thread_id: string | null;
  rounds: MineRound[];
  accepted: ProposeResult["accepted"];
  /** Still rejected after the last round (never resubmitted, or rejected again). */
  rejected: ProposeResult["rejected"];
  candidates: Candidate[];
  files: ProposeResult["files"] & { dir: string };
}

/** The model for the side thread: the explicit one, else `INTENTOS_MINING_MODEL`; never the host's own default. */
export function resolveMiningModel(explicit?: string | null): string | null {
  return explicit ?? process.env.INTENTOS_MINING_MODEL ?? null;
}

const LEVELS = ["high", "medium", "low"];
/** Structured output for the side thread: every field present, null or empty where it does not apply (strict schemas allow no optional keys). */
export const MINE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "title", "statement", "category", "rationale", "confidence", "relevance", "evidence", "applies_to_paths", "test", "rule", "sources"],
        properties: {
          kind: { type: "string", enum: ["invariant", "architecture_rule", "frozen_paths", "decision"] },
          title: { type: "string" },
          statement: { type: "string" },
          category: { type: "string", enum: ["business_rule", "robustness_rule"] },
          rationale: { type: "string" },
          confidence: { type: "string", enum: LEVELS },
          relevance: { type: "string", enum: LEVELS },
          evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["type", "ref", "excerpt"], properties: { type: { type: "string", enum: [...EVIDENCE_TYPES] }, ref: { type: "string" }, excerpt: { type: "string" } } } },
          applies_to_paths: { type: "array", items: { type: "string" } },
          test: { type: "object", additionalProperties: false, required: ["existing", "source"], properties: { existing: { type: ["string", "null"] }, source: { type: ["string", "null"] } } },
          rule: { type: "object", additionalProperties: false, required: ["kind", "paths", "forbidden_modules"], properties: { kind: { type: ["string", "null"] }, paths: { type: "array", items: { type: "string" } }, forbidden_modules: { type: "array", items: { type: "string" } } } },
          sources: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "heading"], properties: { path: { type: "string" }, heading: { type: ["string", "null"] } } } },
        },
      },
    },
  },
};

/** The structured answer uses nulls and empty lists where `propose` takes absent fields: strip them so `ProposalSchema` sees the same shape the host sends. */
export function normalizeProposal(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (v !== null && v !== undefined && v !== "") out[k] = v;
  const test = raw.test as { existing?: string | null; source?: string | null } | null | undefined;
  if (test && typeof test === "object") {
    const t: Record<string, string> = {};
    if (test.existing) t.existing = test.existing;
    if (test.source) t.source = test.source;
    if (Object.keys(t).length) out.test = t;
    else delete out.test;
  }
  const rule = raw.rule as { kind?: string | null; paths?: string[]; forbidden_modules?: string[] } | null | undefined;
  if (rule && typeof rule === "object") {
    if (rule.paths?.length) out.rule = { ...(rule.kind ? { kind: rule.kind } : {}), paths: rule.paths, ...(rule.forbidden_modules?.length ? { forbidden_modules: rule.forbidden_modules } : {}) };
    else delete out.rule;
  }
  const sources = raw.sources;
  if (Array.isArray(sources)) {
    const cleaned = sources.filter((s) => s && (typeof s === "string" || typeof (s as { path?: unknown }).path === "string")).map((s) => (typeof s === "string" ? s : { path: (s as { path: string }).path, ...((s as { heading?: string | null }).heading ? { heading: (s as { heading: string }).heading } : {}) }));
    if (cleaned.length) out.sources = cleaned;
    else delete out.sources;
  }
  if (Array.isArray(raw.evidence)) out.evidence = raw.evidence.filter((e) => e && typeof e === "object").map((e) => Object.fromEntries(Object.entries(e as Record<string, unknown>).filter(([, v]) => v !== null && v !== "")));
  return out;
}

export function buildMiningPrompt(a: { repoPath: string; policyId: string; digest: EvidenceDigest; skill: string }): string {
  const body = a.skill.replace(/^---[\s\S]*?\n---\n/, "").trim();
  const L: string[] = [];
  L.push("# IntentOS independent miner");
  L.push("");
  L.push(`You are the independent miner for the repository at ${a.repoPath} (IntentOS policy id \`${a.policyId}\`): a model other than the one driving the user's session finds the business rules, so that one model does not both write the rules and later implement changes under them. Follow the ${SKILL_NAME} skill below. You are in a read-only sandbox in the repository: read files, run git log and git show, grep, read the tests and the production code; do not try to modify anything.`);
  L.push("");
  L.push("Differences from the skill as written for an MCP host: there are no MCP tools here. The repository is already onboarded. The evidence digest is included below in place of an `evidence` call. Instead of calling `propose`, return the candidates as your final answer in the required JSON shape; IntentOS then checks every reference, lifts or runs every test at the current revision, and may send the rejected candidates back to you once for a fix. There is no review_start to call: the reviewer takes over after the check.");
  L.push("");
  L.push(`Output: a JSON object {"candidates": [...]} and nothing else. Every candidate carries every field; use null for a field that does not apply (\`test.existing\`, \`test.source\`, \`rule.kind\`, \`sources[].heading\`) and an empty list for \`applies_to_paths\`, \`rule.paths\`, \`rule.forbidden_modules\` and \`sources\` when they do not apply. \`rule.kind\` is \`forbidden_import\` or \`frozen_paths\`. \`test.source\` is a complete ${a.digest.language === "typescript" ? "vitest/jest" : "pytest"} module as the skill describes.`);
  L.push("");
  L.push("## The skill");
  L.push("");
  L.push(body);
  L.push("");
  L.push(`## The evidence digest (facts, not rules: select, read the code behind them, and state what holds)`);
  L.push("");
  L.push(renderDigest(a.digest));
  return redact(L.join("\n"));
}

export function buildFixPrompt(result: ProposeResult): string {
  const L: string[] = [];
  L.push(`IntentOS checked your candidates at ${result.head.slice(0, 7)}: ${result.accepted.length} accepted${result.accepted.length ? ` (${result.accepted.map((x) => x.title).join("; ")})` : ""}, ${result.rejected.length} rejected:`);
  L.push("");
  for (const r of result.rejected) L.push(`- ${r.title}: ${r.reasons.join(" | ")}`);
  L.push("");
  L.push('Fix what can be fixed: a reference that exists in the repository, a test that passes at the current revision, a test for an invariant that had none, the right field shape. Return only the fixed candidates in the same JSON shape; leave out any you cannot back with evidence, and return {"candidates": []} if none can be fixed. Do not resend the accepted ones.');
  return redact(L.join("\n"));
}

function parseCandidates(text: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("the model's answer is not JSON");
    parsed = JSON.parse(m[0]);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(list)) throw new Error("the model's answer has no candidates list");
  return list.filter((c): c is Record<string, unknown> => !!c && typeof c === "object");
}

/** Replays the saved answers of an earlier run (`<out>/mine/round-N.json`) through the checks, without calling Codex. */
export class ReplayEngine implements CodingEngine {
  readonly name = "replay";
  readonly simulated = true;
  private calls = 0;
  private readonly dir: string;
  private readonly model: string | null;
  constructor(dir: string, model: string | null = null) {
    this.dir = dir;
    this.model = model;
  }
  async plan(req: PlanRequest): Promise<PlanResult> {
    this.calls++;
    const file = path.join(this.dir, `round-${this.calls}.json`);
    req.onThreadStarted?.(`replay-${path.basename(this.dir)}`);
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : '{"candidates": []}';
    return { text, usage: null, threadId: `replay-${path.basename(this.dir)}`, simulated: true, engine: this.name, model: this.model, items: [] };
  }
  async implement(): Promise<ImplementResult> {
    throw new Error("the replay engine only mines");
  }
}

export async function mineWithModel(repoInput: string, opts: MineOptions = {}, log: (line: string) => void = () => {}): Promise<MineResult> {
  const repoPath = path.resolve(repoInput);
  if (!fs.existsSync(repoPath) || !isGitRepo(repoPath)) throw new Error(`${repoPath} is not a Git repository`);
  const paths = ensureHome(resolvePaths());
  const policyId = policyIdFor(runProbe(repoPath), repoPath, opts.policyId);
  const policyFile = path.resolve(opts.policyFile ?? path.join(paths.policies, `${policyId}.yaml`));
  if (!fs.existsSync(policyFile)) throw new Error(`${policyFile} not found; onboard the repository first (the tests run in its venv, and the review appends to the policy)`);
  const outDir = path.resolve(opts.outDir ?? path.join(paths.home, "onboard", repoIdFor(repoPath)));
  const dir = path.join(outDir, "mine");
  fs.mkdirSync(dir, { recursive: true });
  const agentConfig = captureAgentSnapshot();
  const role = agentConfig.roles.miner;
  const model = resolveMiningModel(opts.model ?? role.model);
  const reasoning = opts.reasoningEffort ?? role.reasoning;
  fs.writeFileSync(path.join(dir, "agent_config.json"), JSON.stringify({ role: { ...role, model, reasoning }, captured_at: agentConfig.captured_at }, null, 2) + "\n");
  if (!opts.engine && !model) throw new Error("no model named for the independent miner: pass --model <slug> (one the Codex account can run, other than the model that drives the session) or set INTENTOS_MINING_MODEL");
  if (!opts.engine && model && agentConfig.roles.implementer.model === model) throw new Error("miner model must differ from the implementer model");
  const engine = opts.engine ?? new LiveCodexEngine({ model, reasoningEffort: reasoning });
  const maxRounds = Math.max(1, Math.min(opts.rounds ?? 2, 5));
  const digest = loadDigest(repoPath, { policyId, outDir });
  log(`evidence digest: ${digest.counts.tests ?? 0} tests, ${digest.counts.commits ?? 0} commits, ${digest.counts.documents ?? 0} document sentences at ${digest.head.slice(0, 7)}; asking ${model ?? engine.name} to mine the rules (round 1 of at most ${maxRounds})…`);

  let threadId: string | null = null;
  let resolvedModel: string | null = model;
  let engineName = engine.name;
  let prompt = appendRoleSkills(buildMiningPrompt({ repoPath, policyId, digest, skill: skillText() }), role);
  const rounds: MineRound[] = [];
  const accepted: ProposeResult["accepted"] = [];
  const rejectedAll: ProposeResult["rejected"] = [];
  let last: ProposeResult | null = null;
  for (let round = 1; round <= maxRounds; round++) {
    fs.writeFileSync(path.join(dir, `prompt-${round}.txt`), prompt);
    const res = await engine.plan({
      cwd: repoPath,
      prompt,
      outputSchema: MINE_SCHEMA,
      threadId,
      onThreadStarted: (id) => {
        threadId = id;
      },
    });
    threadId = res.threadId ?? threadId;
    resolvedModel = res.model ?? resolvedModel;
    engineName = res.engine;
    fs.writeFileSync(path.join(dir, `round-${round}.json`), res.text);
    const proposals = parseCandidates(res.text);
    if (!proposals.length) {
      rounds.push({ round, proposed: 0, accepted: 0, rejected: 0, usage: res.usage });
      log(`round ${round}: ${resolvedModel ?? engineName} returned no candidates`);
      break;
    }
    log(`round ${round}: ${proposals.length} candidate(s) from ${resolvedModel ?? engineName}; checking references and running tests…`);
    const author: Author = { via: "side_thread", model: resolvedModel, engine: engineName, thread_id: threadId };
    last = await ingestProposals(repoPath, proposals.map(normalizeProposal), { policyId, policyFile, outDir, append: round === 1 ? opts.append : true, runTests: opts.runTests, author }, (l) => {
      if (/^rejected /.test(l)) log(l);
    });
    rounds.push({ round, proposed: proposals.length, accepted: last.accepted.length, rejected: last.rejected.length, usage: res.usage });
    accepted.push(...last.accepted);
    rejectedAll.push(...last.rejected);
    log(`round ${round}: ${last.accepted.length} accepted, ${last.rejected.length} rejected; the review list has ${last.candidates.length} candidate(s)`);
    if (!last.rejected.length || round === maxRounds) break;
    prompt = appendRoleSkills(buildFixPrompt(last), role);
  }
  if (!last) throw new Error(`${resolvedModel ?? engineName} returned no candidates; nothing to review`);
  const acceptedTitles = new Set(accepted.map((a) => a.title));
  const stillRejected = new Map<string, ProposeResult["rejected"][number]>();
  for (const r of rejectedAll) if (!acceptedTitles.has(r.title)) stillRejected.set(r.title, r);
  const result: MineResult = {
    repo_path: repoPath,
    policy_id: policyId,
    head: last.head,
    model: resolvedModel,
    engine: engineName,
    thread_id: threadId,
    rounds,
    accepted,
    rejected: [...stillRejected.values()],
    candidates: last.candidates,
    files: { ...last.files, dir },
  };
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2));
  log(`done: ${accepted.length} accepted, ${result.rejected.length} still rejected after ${rounds.length} round(s); the review list has ${last.candidates.length} candidate(s)`);
  return result;
}
