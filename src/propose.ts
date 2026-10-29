import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { PROJECT_ROOT, ensureHome, resolvePaths, resolvePython } from "./config.ts";
import { repoIdFor } from "./knowledge/indexer.ts";
import { precedentsFile } from "./knowledge/precedents.ts";
import { loadPolicyFile, type Policy } from "./knowledge/policy.ts";
import { repoInterpreter } from "./knowledge/venv.ts";
import { jsRunner, jsTestInvocation } from "./knowledge/js.ts";
import { minimalEnv, policyIdFor, runProbe } from "./onboard.ts";
import { EVIDENCE_SCRIPT, renderCandidatesMarkdown, renderCandidatesYaml, runDigest, type Candidate, type CandidateList, type EvidenceDigest, type HiddenTestDraft, type IngestOutput } from "./candidates.ts";
import { isGitRepo } from "./util/git.ts";

/**
 * Model-authored policy candidates: the coding agent (the host through the `intentos-policy-mining` skill, or the
 * independent side thread) reads the evidence digest and the repository, states the rules and submits candidates with
 * a test each. IntentOS does not trust the submission: every reference is checked against the repository (Python
 * side), existing tests are lifted into self-contained hidden-test drafts and run at the current revision, tests the
 * agent wrote are run in the repository's environment (venv or node_modules), and only what passes reaches the review.
 * The result is written to `suggestions.json`, the list the review reads, marked `authored_by: "codex"` with the author.
 */

export const SKILL_NAME = "intentos-policy-mining";
export const SETUP_SKILL_NAME = "intentos-setup";
/** Skills shipped with IntentOS: mining the rules (followed by the host), and setting IntentOS up for a repository. */
export const SKILL_NAMES = [SKILL_NAME, SETUP_SKILL_NAME] as const;
/** The skills live inside the Codex plugin (plugins/intentos/skills), the one place Codex reads them from when the plugin is installed. */
export const skillDir = (name: string = SKILL_NAME): string => path.join(PROJECT_ROOT, "plugins", "intentos", "skills", name);
export const skillText = (name: string = SKILL_NAME): string => fs.readFileSync(path.join(skillDir(name), "SKILL.md"), "utf8");

/** Symlink the skill into a Codex skills directory (default `~/.agents/skills`, scanned by Codex for every project). */
export function installSkill(opts: { dir?: string; force?: boolean; name?: string } = {}): { link: string; target: string; created: boolean; name: string } {
  const name = opts.name ?? SKILL_NAME;
  const dir = path.resolve(opts.dir ?? path.join(os.homedir(), ".agents", "skills"));
  const link = path.join(dir, name);
  const target = skillDir(name);
  fs.mkdirSync(dir, { recursive: true });
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(link);
  } catch {
    st = null;
  }
  if (st) {
    if (st.isSymbolicLink()) {
      if (path.resolve(path.dirname(link), fs.readlinkSync(link)) === target) return { link, target, created: false, name };
      fs.unlinkSync(link);
    } else if (opts.force) {
      fs.rmSync(link, { recursive: true, force: true });
    } else {
      throw new Error(`${link} exists and is not a symlink; remove it or pass --force`);
    }
  }
  fs.symlinkSync(target, link, "dir");
  return { link, target, created: true, name };
}

export const EVIDENCE_TYPES = ["test", "commit", "doc", "adr", "changelog", "import", "history", "code", "ticket"] as const;
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
  /** Decisions: the ADR or decision id this one supersedes (recorded as a warning until both carry DEC ids). */
  supersedes: z.string().optional(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

/** Who wrote the candidates in the review list: the host agent itself, or IntentOS's independent side thread. */
export interface Author {
  via: "host" | "side_thread";
  model: string | null;
  engine?: string | null;
  thread_id?: string | null;
}

export const describeAuthor = (a: Author | null | undefined): string => (!a ? "an unrecorded author" : a.via === "side_thread" ? `${a.model ?? "an unnamed model"} in an independent side thread` : "the host agent");

export interface ProposeOptions {
  policyId?: string;
  outDir?: string;
  policyFile?: string;
  /** Keep the candidates of an earlier `propose` and add these (ids continue); default: replace the review list. */
  append?: boolean;
  /** Run the tests (default true; off only in unit tests of the plumbing). */
  runTests?: boolean;
  timeoutS?: number;
  /** Recorded in the review list (default: the host agent). */
  author?: Author;
}

export interface ProposeResult {
  repo_path: string;
  repo_id: string;
  policy_id: string;
  head: string;
  accepted: Array<{ id: string; kind: Candidate["kind"]; title: string; verified: "lifted" | "written" | "none"; notes: string[] }>;
  rejected: Array<{ title: string; reasons: string[] }>;
  candidates: Candidate[];
  files: { json: string; markdown: string; yaml: string };
}

/** The review list on disk (`<out>/suggestions.json`). */
export interface AuthoredSuggestions extends CandidateList {
  repo_path: string;
  repo_id: string;
  files: ProposeResult["files"];
  authored_by: "codex";
  author: Author;
  note: string;
  next_steps: string[];
}

type Draft = HiddenTestDraft & { pending_run?: boolean };

const titleOf = (raw: unknown): string => (raw && typeof raw === "object" && typeof (raw as { title?: unknown }).title === "string" ? (raw as { title: string }).title : "(untitled)");

/** `pythonpath=` from the policy's project test command: the agent's tests run with the same import roots. */
function pythonpathFor(policy: Policy | null): string[] {
  try {
    const argv = policy?.commands.pytest_project?.argv ?? [];
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

/** Run a vitest/jest test file (optionally one title) in the repository; the runner comes from the repository's node_modules. */
function runJsTest(repo: string, file: string, title: string | undefined, outDir: string, timeoutS: number, prefer: "vitest" | "jest" | null): { ok: boolean; tail: string } {
  const runner = jsRunner(repo, prefer);
  if (!runner) return { ok: false, tail: `neither vitest nor jest is installed in ${path.join(repo, "node_modules")}; run the package manager's install first` };
  const junit = path.join(outDir, "proposed_tests", `${path.basename(file)}.junit.xml`);
  fs.mkdirSync(path.dirname(junit), { recursive: true });
  const inv = jsTestInvocation(runner, { root: repo, file, title, junit });
  const res = spawnSync(inv.argv[0]!, inv.argv.slice(1), { cwd: repo, env: { ...minimalEnv(), ...inv.env }, encoding: "utf8", timeout: timeoutS * 1000, maxBuffer: 16 * 1024 * 1024 });
  const lines = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  if (res.error) return { ok: false, tail: res.error.message };
  const ran = fs.existsSync(junit) && /<testcase/.test(fs.readFileSync(junit, "utf8"));
  if (res.status === 0 && !ran) return { ok: false, tail: `${runner.kind} collected no test from ${path.relative(repo, file)}${title ? ` titled ${JSON.stringify(title)}` : ""}` };
  return { ok: res.status === 0, tail: lines.slice(-12).join("\n") };
}

/** The evidence digest for the repository, cached per HEAD in `<out>/evidence.json`. */
export function loadDigest(repoInput: string, opts: { policyId?: string; outDir?: string; maxCommits?: number } = {}): EvidenceDigest {
  const repoPath = path.resolve(repoInput);
  if (!fs.existsSync(repoPath) || !isGitRepo(repoPath)) throw new Error(`${repoPath} is not a Git repository`);
  const paths = ensureHome(resolvePaths());
  const outDir = path.resolve(opts.outDir ?? path.join(paths.home, "onboard", repoIdFor(repoPath)));
  const file = path.join(outDir, "evidence.json");
  const head = spawnSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  // Resolved tickets come from the synced precedents (never from the network here); a new sync invalidates the cache.
  const precedents = precedentsFile(paths, repoIdFor(repoPath));
  const syncedAt = precedentsSyncedAt(precedents);
  if (fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, "utf8")) as EvidenceDigest;
    if (cached.head === head && (cached.precedents_synced_at ?? null) === syncedAt && Array.isArray(cached.code_notes)) return cached;
  }
  const policyId = policyIdFor(runProbe(repoPath), repoPath, opts.policyId);
  const digest = runDigest(repoPath, policyId, opts.maxCommits ?? 300, syncedAt ? precedents : null);
  digest.precedents_synced_at = syncedAt;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(digest, null, 2));
  return digest;
}

function precedentsSyncedAt(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { source?: { synced_at?: string } };
    return parsed.source?.synced_at ?? "unknown";
  } catch {
    return null;
  }
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

  // 2. References, lifting and policy blocks (Python side): nothing in the submission is trusted.
  const previous = opts.append ? loadAuthored(outDir) : null;
  const start = previous ? previous.candidates.length + 1 : 1;
  const proposalsFile = path.join(outDir, "proposals.json");
  fs.writeFileSync(proposalsFile, JSON.stringify(valid, null, 2));
  const script = path.join(paths.python, EVIDENCE_SCRIPT);
  const precedents = precedentsFile(paths, repoId);
  const ingestArgs = ["-I", script, repoPath, "--policy-id", policyId, "--ingest", proposalsFile, "--start", String(start)];
  if (fs.existsSync(precedents)) ingestArgs.push("--precedents", precedents);
  const res = spawnSync(resolvePython(), ingestArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  if (res.error) throw new Error(`policy ingest failed to start: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`policy ingest exited ${res.status}: ${(res.stderr ?? "").trim()}`);
  const out = JSON.parse(res.stdout) as IngestOutput;
  rejected.push(...out.rejected);

  // 3. Tests: the agent's own module in the repository's environment; an existing test run as it stands. Failures reject.
  let policy: Policy | null = null;
  try {
    policy = loadPolicyFile(policyFile);
  } catch {
    policy = null;
  }
  const interpreter = repoInterpreter(repoPath);
  const pythonpath = pythonpathFor(policy);
  const preferRunner = policy?.commands.test_project?.argv?.some((a) => a.includes("/jest/")) ? "jest" : policy?.commands.test_project ? "vitest" : null;
  const timeoutS = opts.timeoutS ?? 120;
  const kept: Array<{ c: Candidate; verified: "lifted" | "written" | "none"; notes: string[] }> = [];
  // Written TypeScript tests run from <repo>/.intentos_hidden/proposed/ (their imports are relative to that depth) and
  // the vitest wrapper config lands in <repo>/.intentos_hidden/; the directory is removed afterwards and never committed.
  const hiddenRoot = path.join(repoPath, ".intentos_hidden");
  const tsScratch = path.join(hiddenRoot, "proposed");
  try {
    for (const c of out.candidates) {
      const draft = (c.suggested_hidden_test ?? null) as Draft | null;
      const notes: string[] = [];
      let verified: "lifted" | "written" | "none" = "none";
      if (draft) {
        const written = draft.from.startsWith("codex:");
        const ts = draft.language === "typescript";
        if (opts.runTests !== false) {
          if (written) {
            const slug = draft.from.slice("codex:".length).replace(/[^a-z0-9_]+/g, "_");
            let r: { ok: boolean; tail: string };
            if (ts) {
              fs.mkdirSync(tsScratch, { recursive: true });
              const file = path.join(tsScratch, `${slug}.test.ts`);
              fs.writeFileSync(file, draft.source);
              r = runJsTest(repoPath, file, undefined, outDir, timeoutS, preferRunner);
            } else {
              const dir = path.join(outDir, "proposed_tests");
              fs.mkdirSync(dir, { recursive: true });
              const file = path.join(dir, `test_${slug}.py`);
              fs.writeFileSync(file, draft.source);
              r = runPytest(interpreter, repoPath, file, pythonpath, timeoutS);
            }
            if (!r.ok) {
              rejected.push({ title: c.title, reasons: [`the test you wrote fails at ${out.head.slice(0, 7)} in the repository's ${ts ? "node_modules" : "venv"}:\n${r.tail}`] });
              log(`rejected "${c.title}": written test fails`);
              continue;
            }
          } else {
            const ref = c.evidence.find((e) => e.type === "test")?.ref ?? draft.from;
            const r = ts ? runJsTest(repoPath, path.join(repoPath, ref.split("::")[0]!), ref.split("::").slice(1).join("::"), outDir, timeoutS, preferRunner) : runPytest(interpreter, repoPath, ref, pythonpath, timeoutS);
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
  } finally {
    fs.rmSync(hiddenRoot, { recursive: true, force: true });
  }

  // 4. The review list: replace, or append to the earlier list with stable ids.
  const all = previous ? [...previous.candidates, ...kept.map((k) => k.c)] : kept.map((k) => k.c);
  all.forEach((c, i) => {
    c.id = `CAND-${String(i + 1).padStart(3, "0")}`;
    c.rank = i + 1;
  });
  const counts = Object.fromEntries(["invariant", "architecture_rule", "frozen_paths", "decision"].map((k) => [k, all.filter((c) => c.kind === k).length]));
  const files = { json: path.join(outDir, "suggestions.json"), markdown: path.join(outDir, "policy-suggestions.md"), yaml: path.join(outDir, "policy-suggestions.yaml") };
  const author: Author = opts.author ?? { via: "host", model: null };
  const list: CandidateList = { repo: repoPath, head: out.head, policy_id: policyId, candidates: all, counts, warnings: [] };
  fs.writeFileSync(files.markdown, renderCandidatesMarkdown(list, describeAuthor(author)));
  fs.writeFileSync(files.yaml, renderCandidatesYaml(list));
  const result: AuthoredSuggestions = {
    ...list,
    repo_path: repoPath,
    repo_id: repoId,
    files,
    authored_by: "codex",
    author,
    note: `authored by ${describeAuthor(author)} through the ${SKILL_NAME} skill; ${rejected.length} proposal(s) rejected`,
    next_steps: ["call review_start: the reviewer approves or rejects each candidate"],
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
