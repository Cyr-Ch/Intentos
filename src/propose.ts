import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { PROJECT_ROOT, ensureHome, resolvePaths, resolvePython } from "./config.ts";
import { repoIdFor } from "./knowledge/indexer.ts";
import { loadPolicyFile } from "./knowledge/policy.ts";
import { repoInterpreter } from "./knowledge/venv.ts";
import { minimalEnv, policyIdFor, runProbe } from "./onboard.ts";
import { renderSuggestionsMarkdown, renderSuggestionsYaml, runMiner, type Candidate, type MinerOutput, type SuggestResult } from "./suggest.ts";
import { isGitRepo } from "./util/git.ts";

/**
 * Host-authored policy candidates: the coding agent follows the `intentos-policy-mining` skill, reads the repository
 * itself and submits candidates with a test each. IntentOS does not trust the submission: every reference is checked
 * against the repository (Python side), existing tests are lifted with the miner's machinery and run at the current
 * revision, tests the agent wrote are run in the repository's venv, and only what passes reaches the review. The
 * result is written in the same `suggestions.json` shape the review reads, marked `authored_by: "codex"`.
 */

export const SKILL_NAME = "intentos-policy-mining";
export const skillDir = (): string => path.join(PROJECT_ROOT, "skills", SKILL_NAME);
export const skillText = (): string => fs.readFileSync(path.join(skillDir(), "SKILL.md"), "utf8");

/** Symlink the skill into a Codex skills directory (default `~/.agents/skills`, scanned by Codex for every project). */
export function installSkill(opts: { dir?: string; force?: boolean } = {}): { link: string; target: string; created: boolean } {
  const dir = path.resolve(opts.dir ?? path.join(os.homedir(), ".agents", "skills"));
  const link = path.join(dir, SKILL_NAME);
  const target = skillDir();
  fs.mkdirSync(dir, { recursive: true });
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(link);
  } catch {
    st = null;
  }
  if (st) {
    if (st.isSymbolicLink()) {
      if (path.resolve(path.dirname(link), fs.readlinkSync(link)) === target) return { link, target, created: false };
      fs.unlinkSync(link);
    } else if (opts.force) {
      fs.rmSync(link, { recursive: true, force: true });
    } else {
      throw new Error(`${link} exists and is not a symlink; remove it or pass --force`);
    }
  }
  fs.symlinkSync(target, link, "dir");
  return { link, target, created: true };
}

export const EVIDENCE_TYPES = ["test", "commit", "doc", "adr", "changelog", "import", "history"] as const;
const EvidenceSchema = z.object({
  type: z.enum(EVIDENCE_TYPES),
  ref: z.string().min(1).max(300),
  excerpt: z.string().min(1).max(400),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
});
export const ProposalSchema = z.object({
  kind: z.enum(["invariant", "architecture_rule", "frozen_paths", "decision"]).default("invariant"),
  title: z.string().min(3).max(120),
  statement: z.string().min(10).max(400),
  category: z.enum(["business_rule", "robustness_rule"]).default("business_rule"),
  rationale: z.string().max(600).optional(),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
  relevance: z.enum(["high", "medium", "low"]).default("medium"),
  evidence: z.array(EvidenceSchema).max(8).default([]),
  applies_to_paths: z.array(z.string().min(1)).max(8).default([]),
  test: z.object({ existing: z.string().min(1).optional(), source: z.string().min(1).optional() }).optional(),
  rule: z.object({ kind: z.enum(["forbidden_import", "frozen_paths"]).optional(), paths: z.array(z.string().min(1)).min(1), forbidden_modules: z.array(z.string().min(1)).optional() }).optional(),
  /** Documents the rule cites: `{path, heading}` objects, or a path string (the headless run sent strings first). */
  sources: z.array(z.union([z.string().min(1).transform((p) => ({ path: p, heading: null as string | null })), z.object({ path: z.string().min(1), heading: z.string().nullable().optional() })])).optional(),
  status: z.string().optional(),
  /** Id from `mined`: inherit that candidate's evidence, paths and existing test. */
  from_mined: z.string().optional(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export interface ProposeOptions {
  policyId?: string;
  outDir?: string;
  policyFile?: string;
  /** Keep the candidates of an earlier `propose` and add these (ids continue); default: replace the review list. */
  append?: boolean;
  /** Run the tests (default true; off only in unit tests of the plumbing). */
  runTests?: boolean;
  timeoutS?: number;
}

export interface ProposeResult {
  repo_path: string;
  repo_id: string;
  policy_id: string;
  head: string;
  accepted: Array<{ id: string; kind: Candidate["kind"]; title: string; verified: "lifted" | "written" | "none"; notes: string[] }>;
  rejected: Array<{ title: string; reasons: string[] }>;
  candidates: Candidate[];
  files: SuggestResult["files"];
}

export type AuthoredSuggestions = SuggestResult & { authored_by?: "codex" };

type Draft = NonNullable<Candidate["suggested_hidden_test"]> & { pending_run?: boolean };

const titleOf = (raw: unknown): string => (raw && typeof raw === "object" && typeof (raw as { title?: unknown }).title === "string" ? (raw as { title: string }).title : "(untitled)");

/** `pythonpath=` from the policy's project test command: the agent's tests run with the same import roots. */
function pythonpathFor(policyFile: string): string[] {
  try {
    const argv = loadPolicyFile(policyFile).commands.pytest_project?.argv ?? [];
    const entry = argv.find((a) => a.startsWith("pythonpath="));
    const parts = entry ? entry.slice("pythonpath=".length).split(" ").filter(Boolean) : [];
    return parts.length ? parts : ["."];
  } catch {
    return ["."];
  }
}

function runPytest(interpreter: string, repo: string, target: string, pythonpath: string[], timeoutS: number): { ok: boolean; tail: string } {
  const argv = [interpreter, "-m", "pytest", target, "-q", "-p", "no:cacheprovider", "-o", `pythonpath=${pythonpath.map((p) => path.resolve(repo, p)).join(" ")}`];
  const res = spawnSync(argv[0]!, argv.slice(1), { cwd: repo, env: minimalEnv(), encoding: "utf8", timeout: timeoutS * 1000, maxBuffer: 16 * 1024 * 1024 });
  const lines = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  if (res.error) return { ok: false, tail: res.error.message };
  return { ok: res.status === 0, tail: lines.slice(-12).join("\n") };
}

/** The deterministic miner's raw list for the repository, cached per HEAD in `<out>/mined.json` (never the review list). */
export function loadMined(repoInput: string, opts: { policyId?: string; outDir?: string } = {}): MinerOutput {
  const repoPath = path.resolve(repoInput);
  if (!fs.existsSync(repoPath) || !isGitRepo(repoPath)) throw new Error(`${repoPath} is not a Git repository`);
  const paths = ensureHome(resolvePaths());
  const outDir = path.resolve(opts.outDir ?? path.join(paths.home, "onboard", repoIdFor(repoPath)));
  const file = path.join(outDir, "mined.json");
  const head = spawnSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  if (fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, "utf8")) as MinerOutput;
    if (cached.head === head) return cached;
  }
  const policyId = policyIdFor(runProbe(repoPath), repoPath, opts.policyId);
  const mined = runMiner(repoPath, policyId, 500, path.join(outDir, "feedback.json"));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(mined, null, 2));
  return mined;
}

function loadAuthored(outDir: string): AuthoredSuggestions | null {
  const file = path.join(outDir, "suggestions.json");
  if (!fs.existsSync(file)) return null;
  const s = JSON.parse(fs.readFileSync(file, "utf8")) as AuthoredSuggestions;
  return s.authored_by === "codex" ? s : null;
}

export async function ingestProposals(repoInput: string, proposals: unknown[], opts: ProposeOptions = {}, log: (line: string) => void = () => {}): Promise<ProposeResult> {
  const repoPath = path.resolve(repoInput);
  if (!fs.existsSync(repoPath) || !isGitRepo(repoPath)) throw new Error(`${repoPath} is not a Git repository`);
  const paths = ensureHome(resolvePaths());
  const repoId = repoIdFor(repoPath);
  const policyId = policyIdFor(runProbe(repoPath), repoPath, opts.policyId);
  const policyFile = path.resolve(opts.policyFile ?? path.join(paths.policies, `${policyId}.yaml`));
  if (!fs.existsSync(policyFile)) throw new Error(`${policyFile} not found; onboard the repository first so there is a policy and a venv to run the tests in`);
  const outDir = path.resolve(opts.outDir ?? path.join(paths.home, "onboard", repoId));
  fs.mkdirSync(outDir, { recursive: true });

  // 1. Shape: one rejection per malformed proposal, never one failure for the batch.
  const rejected: ProposeResult["rejected"] = [];
  const valid: Proposal[] = [];
  for (const raw of proposals) {
    const r = ProposalSchema.safeParse(raw);
    if (r.success) valid.push(r.data);
    else rejected.push({ title: titleOf(raw), reasons: r.error.issues.map((i) => `${i.path.join(".") || "proposal"}: ${i.message}`) });
  }

  // 2. from_mined: inherit evidence, paths and the existing test of a mined candidate.
  const minedFile = path.join(outDir, "mined.json");
  const mined = fs.existsSync(minedFile) ? (JSON.parse(fs.readFileSync(minedFile, "utf8")) as MinerOutput) : null;
  const ready: Proposal[] = [];
  for (const p of valid) {
    if (!p.from_mined) {
      ready.push(p);
      continue;
    }
    const m = mined?.candidates.find((c) => c.id === p.from_mined);
    if (!m) {
      rejected.push({ title: p.title, reasons: [`from_mined ${p.from_mined}: no such candidate in the last mined list (call mined first)`] });
      continue;
    }
    const seen = new Set(p.evidence.map((e) => `${e.type} ${e.ref}`));
    for (const e of m.evidence) if (!seen.has(`${e.type} ${e.ref}`)) p.evidence.push({ type: e.type as (typeof EVIDENCE_TYPES)[number], ref: e.ref, excerpt: e.excerpt || e.ref, path: e.path ?? undefined, line: e.line ?? undefined });
    if (!p.applies_to_paths.length) p.applies_to_paths = m.applies_to_paths ?? [];
    const testRef = m.evidence.find((e) => e.type === "test")?.ref;
    if (!p.test && testRef) p.test = { existing: testRef };
    ready.push(p);
  }

  // 3. References, lifting and policy blocks: the Python miner's machinery.
  const previous = opts.append ? loadAuthored(outDir) : null;
  const start = previous ? previous.candidates.length + 1 : 1;
  const proposalsFile = path.join(outDir, "proposals.json");
  fs.writeFileSync(proposalsFile, JSON.stringify(ready, null, 2));
  const script = path.join(paths.python, "policy_suggest.py");
  const res = spawnSync(resolvePython(), ["-I", script, repoPath, "--policy-id", policyId, "--ingest", proposalsFile, "--start", String(start)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  if (res.error) throw new Error(`policy ingest failed to start: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`policy ingest exited ${res.status}: ${(res.stderr ?? "").trim()}`);
  const out = JSON.parse(res.stdout) as { head: string; candidates: Candidate[]; rejected: ProposeResult["rejected"] };
  rejected.push(...out.rejected);

  // 4. Tests: the agent's own module in the repository's venv; an existing test run as it stands. Failures reject.
  const interpreter = repoInterpreter(repoPath);
  const pythonpath = pythonpathFor(policyFile);
  const timeoutS = opts.timeoutS ?? 120;
  const kept: Array<{ c: Candidate; verified: "lifted" | "written" | "none"; notes: string[] }> = [];
  for (const c of out.candidates) {
    const draft = (c.suggested_hidden_test ?? null) as Draft | null;
    const notes: string[] = [];
    let verified: "lifted" | "written" | "none" = "none";
    if (draft) {
      const written = draft.from.startsWith("codex:");
      if (opts.runTests !== false) {
        if (written) {
          const dir = path.join(outDir, "proposed_tests");
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `test_${draft.from.slice("codex:".length).replace(/[^a-z0-9_]+/g, "_")}.py`);
          fs.writeFileSync(file, draft.source);
          const r = runPytest(interpreter, repoPath, file, pythonpath, timeoutS);
          if (!r.ok) {
            rejected.push({ title: c.title, reasons: [`the test you wrote fails at ${out.head.slice(0, 7)} in the repository's venv:\n${r.tail}`] });
            log(`rejected "${c.title}": written test fails`);
            continue;
          }
        } else {
          const ref = c.evidence.find((e) => e.type === "test")?.ref ?? draft.from;
          const r = runPytest(interpreter, repoPath, ref, pythonpath, timeoutS);
          if (!r.ok) {
            rejected.push({ title: c.title, reasons: [`existing test ${ref} fails at ${out.head.slice(0, 7)}, so it does not establish the rule (or the repository is broken there):\n${r.tail}`] });
            log(`rejected "${c.title}": existing test fails at HEAD`);
            continue;
          }
        }
      }
      delete draft.pending_run;
      verified = written ? "written" : "lifted";
      notes.push(...draft.notes);
    }
    kept.push({ c, verified, notes });
  }

  // 5. The review list: replace, or append to the earlier host-authored list with stable ids.
  const all = previous ? [...previous.candidates, ...kept.map((k) => k.c)] : kept.map((k) => k.c);
  all.forEach((c, i) => {
    c.id = `CAND-${String(i + 1).padStart(3, "0")}`;
    c.rank = i + 1;
  });
  const counts = Object.fromEntries(["invariant", "architecture_rule", "frozen_paths", "decision"].map((k) => [k, all.filter((c) => c.kind === k).length]));
  const files = { json: path.join(outDir, "suggestions.json"), markdown: path.join(outDir, "policy-suggestions.md"), yaml: path.join(outDir, "policy-suggestions.yaml") };
  const minerShape: MinerOutput = { repo: repoPath, head: out.head, policy_id: policyId, candidates: all, counts, warnings: [] };
  fs.writeFileSync(files.markdown, renderSuggestionsMarkdown(minerShape, []));
  fs.writeFileSync(files.yaml, renderSuggestionsYaml(minerShape));
  const result: AuthoredSuggestions = {
    repo_path: repoPath,
    repo_id: repoId,
    policy_id: policyId,
    head: out.head,
    candidates: all,
    counts,
    files,
    adrs: [],
    adr_dir: null,
    codex: { used: false, model: null, usage: null, dropped: 0, note: null },
    classification: { used: true, model: "host", usage: null, classified: all.length, kept: all.length, filtered: 0, rewrites_rejected: 0, note: `authored by the host through the ${SKILL_NAME} skill; ${rejected.length} proposal(s) rejected` },
    filtered_out: [],
    vocabulary: [],
    warnings: [],
    next_steps: ["call review_start: the reviewer approves or rejects each candidate"],
    authored_by: "codex",
  };
  fs.writeFileSync(files.json, JSON.stringify(result, null, 2));
  if (!previous) fs.rmSync(path.join(outDir, "review-decisions.json"), { force: true });
  log(`${kept.length} accepted, ${rejected.length} rejected; review list has ${all.length} candidate(s)`);
  return {
    repo_path: repoPath,
    repo_id: repoId,
    policy_id: policyId,
    head: out.head,
    accepted: kept.map((k) => ({ id: k.c.id, kind: k.c.kind, title: k.c.title, verified: k.verified, notes: k.notes })),
    rejected,
    candidates: all,
    files,
  };
}
