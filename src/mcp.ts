import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { McpServer, acceptedContent, inputRequired, inputResponse, type CallToolResult, type ElicitRequestFormParams, type InputRequiredResult, type PrimitiveSchemaDefinition, type ServerContext } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { getUiCapability, registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { PROJECT_ROOT, ensureHome, resolvePaths } from "./config.ts";
import type { KnowledgeStore } from "./knowledge/storage.ts";
import { loadIndexedRepo } from "./knowledge/repo.ts";
import { repoIdFor } from "./knowledge/indexer.ts";
import { buildEvidencePack } from "./knowledge/retrieval.ts";
import { fallbackPolicy, loadPolicyFile, policyForRepo } from "./knowledge/policy.ts";
import { policyIdFor, runProbe } from "./onboard.ts";
import { isGitRepo } from "./util/git.ts";
import { renderEvidencePack } from "./reports/explain.ts";
import { decide, defaultReviewer, finishReview, loadReviewState, publicState, reviewPage, startReviewServer, type Decision, type ReviewServer, type ReviewState } from "./review.ts";
import type { Candidate } from "./suggest.ts";
import { describeAuthor, ingestProposals, loadMined, minedRows, SKILL_NAME, skillText, type Author } from "./propose.ts";
import { mineWithModel, resolveMiningModel } from "./mine.ts";
import type { CodingEngine } from "./codex/adapter.ts";
import { nowIso } from "./util/ids.ts";
import crypto from "node:crypto";

/**
 * `intentos mcp`: IntentOS as an MCP server, so a coding agent (Codex, Claude, …) can read the evidence pack and the
 * approved policy from inside its session, and so the policy review can run as an MCP Apps widget rendered by the host.
 *
 * Trust boundary: `explain`, `policy` and `review_start` are visible to the model. The tools that change the policy
 * (`review_session`, `review_state`, `review_decide`, `review_finish`) are app-only (`_meta.ui.visibility: ["app"]`)
 * so hosts do not offer them to the model, and they additionally require a widget token that only the view receives.
 * A model-initiated approval is refused twice over. Hosts without the UI extension get the token-protected local URL
 * instead, and the approval still happens in a browser the model does not control.
 *
 * Hosts that support elicitation (Codex does) get a third path: `review_next` asks the host to show the reviewer a
 * form for one candidate (approve / reject / skip, editable statement, fold related tests). The answer travels
 * host → server; the model only sees the outcome. `review_close` confirms finishing the same way.
 *
 * Onboarding from the host: `status` says where a repository stands and which tool to call next; `onboard` runs the
 * CLI (`intentos onboard`, then `intentos suggest --classify`) in a child process and returns at once with a job id,
 * because hosts time out tool calls long before a venv, a test run and an index are done; the model polls `status`.
 * The server's MCP `instructions` carry the working order (status → onboard → status… → review_start → review_next…
 * → review_close), so a host needs one sentence from the user and no knowledge of the CLI.
 *
 * Two miners: the host can author the candidates itself (the skill, `propose`), or ask for the independent miner
 * (`mine`): IntentOS runs the same skill in a separate read-only Codex thread with a model the user names, so the
 * model that finds the rules is not the one that drives the session or later implements under them. Both go through
 * the same checks; the review list records who authored it.
 */

const SERVER_INSTRUCTIONS = [
  "IntentOS keeps a repository's business rules as an approved policy (invariants, architecture rules, decisions) backed by hidden tests, and gives you an evidence pack before you plan a change. Always pass absolute repository paths.",
  `Working order for a repository: (1) status: where it stands and which tool to call next. (2) onboard when it is not onboarded; it runs in the background for a few minutes, so poll status about every 20 seconds until phase is "done". (3) Mine the business rules, one of two ways. (a) The independent miner: call mine with a model other than yourself, when the user asks for an independent, second or unbiased opinion, names a model, or when status says INTENTOS_MINING_MODEL is set; it runs the ${SKILL_NAME} skill in a separate read-only Codex thread with that model, checks and tests the result like propose, sends rejections back once, and writes the review list in the background: poll status until phase is "done". The review list then records that model as its author; do not resubmit its candidates with propose (that would record you as the author) and do not rewrite its tests: IntentOS already ran them. (b) Yourself: follow the skill (call mining_guide if it is not installed in this host): read the tests, the git history, the documents and the structure; state each rule with evidence; pick an existing test or write one that proves it; submit the list with propose. mined gives the deterministic miner's raw list as a starting point. IntentOS checks every reference and runs every test; fix the rejected ones and call propose again with append=true. (4) review_start. If its result says ui=widget, the reviewer works inside the inline widget: do not call review_next (it would show the same candidate again as a form); wait for the reviewer to say they are done. If it says ui=link, give the reviewer the link. Otherwise call review_next repeatedly: each call shows the reviewer one candidate through this host's own prompt and the reviewer decides. Never approve, reject or edit candidates on their behalf, and never submit a candidate without evidence from the repository. (5) review_close when no candidates remain, or when the reviewer says they are done and the widget did not finish.`,
  "Before planning or implementing a change: explain for the evidence pack, policy for the approved rules.",
].join("\n");

export const REVIEW_RESOURCE_URI = "ui://intentos/review.html";

export interface McpOptions {
  store: KnowledgeStore;
  /** Where to log client info and tool calls (stderr is reserved for the transport's diagnostics). */
  logFile?: string;
  log?: (line: string) => void;
  /** Tests: a stand-in for the Codex SDK thread the independent miner runs with the named model. */
  mineEngine?: (model: string) => CodingEngine;
}

interface Session {
  state: ReviewState;
  token: string;
  http: ReviewServer | null;
  /** How the host shows this review: inline widget, or a link to the local page (with elicitation forms on top). */
  ui: "widget" | "link";
  started_at: string;
}

const text = (t: string, structured?: Record<string, unknown>): CallToolResult => ({ content: [{ type: "text", text: t }], ...(structured ? { structuredContent: structured } : {}) });
const fail = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }], isError: true });

export function createIntentosMcpServer(opts: McpOptions): { server: McpServer; current: () => Session | null; close: () => Promise<void> } {
  const server = new McpServer({ name: "intentos", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });
  let session: Session | null = null;
  const log = (line: string) => {
    opts.log?.(line);
    if (opts.logFile) {
      try {
        fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
        fs.appendFileSync(opts.logFile, `${nowIso()} ${line}\n`);
      } catch {
        /* logging must never break a tool call */
      }
    }
  };
  const uiSupported = (): boolean => !!getUiCapability(server.server.getClientCapabilities());
  const describeClient = (): string => {
    const caps = server.server.getClientCapabilities();
    const ui = getUiCapability(caps);
    return `client ui=${ui ? `yes (${(ui.mimeTypes ?? []).join(",")})` : "no"} capabilities=${JSON.stringify(caps ?? {})}`;
  };
  const requireToken = (token: string | undefined): Session | CallToolResult => {
    if (!session) return fail("no review in progress; call review_start first");
    if (!token || token !== session.token) return fail("refused: this tool is for the review widget only (missing or wrong widget token); a person approves in the review page, not the model");
    return session;
  };

  // What the host declared on connect (UI extension, elicitation, protocol era) is the first thing a test run needs to know.
  server.server.oninitialized = () => log(`initialized: ${describeClient()} protocol=${server.server.getNegotiatedProtocolVersion?.() ?? "?"} clientInfo=${JSON.stringify(server.server.getClientVersion?.() ?? null)}`);
  const elicitationModes = () => {
    const caps = server.server.getClientCapabilities() as { elicitation?: { form?: unknown; url?: unknown } } | undefined;
    const e = caps?.elicitation;
    return { form: !!e && (e.form !== undefined || Object.keys(e).length === 0), url: !!e?.url };
  };
  /** 2026-07-28 and later use the multi-round-trip `input_required` result; earlier hosts take the push-style request. */
  const modernEra = () => (server.server.getNegotiatedProtocolVersion?.() ?? "") >= "2026-07-28";

  registerAppResource(server, "IntentOS policy review", REVIEW_RESOURCE_URI, { description: "Approve or reject mined policy candidates one by one; approvals land in the policy file, the hidden tests and the repository's policy notes." }, async () => ({
    contents: [{ uri: REVIEW_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: reviewPage(null, "widget") }],
  }));

  server.registerTool(
    "explain",
    {
      description: "IntentOS evidence pack for a task in an indexed repository: reusable symbols with locations, relevant tests and documents, applicable approved invariants and architecture rules, probable impact. Read it before planning a change.",
      inputSchema: z.object({ repo: z.string().describe("absolute path of the indexed repository root"), task: z.string().min(8).describe("the change request in one or two sentences") }),
    },
    async ({ repo, task }) => {
      try {
        const indexed = loadIndexedRepo(opts.store, repo);
        const pack = buildEvidencePack(opts.store, indexed, task);
        log(`explain ${repo}: ${pack.reusable_symbols.length} symbols, ${pack.invariants.length} invariants`);
        return text(renderEvidencePack(pack), { revision: pack.revision, policy_id: indexed.policy.policy_id, reusable_symbols: pack.reusable_symbols.slice(0, 15), invariants: pack.invariants, architecture_rules: pack.architecture_rules, allowed_path_universe: pack.allowed_path_universe, protected_paths: pack.protected_paths });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "policy",
    {
      description: "The approved IntentOS policy for a repository: invariants, architecture rules and decisions with their sources, allowed and protected paths. These are binding for every change; the fallback policy is reported when none is approved.",
      inputSchema: z.object({ repo: z.string().describe("absolute path of the repository root") }),
    },
    async ({ repo }) => {
      try {
        const policy = policyForRepo(repo) ?? fallbackPolicy(repo);
        const lines = [`Policy ${policy.policy_id}${policy.policy_id.startsWith("fallback:") ? " (fallback: nothing approved yet)" : ""}`, `allowed: ${policy.default_allowed_paths.join(", ")}; protected: ${policy.protected_paths.join(", ") || "none"}`, "Invariants:", ...policy.invariants.map((i) => `- ${i.id} [${i.enforcement}] ${i.statement} (source: ${i.sources.map((s) => `${s.path}${s.heading ? `#${s.heading}` : ""}`).join("; ")})`), "Architecture rules:", ...policy.architecture_rules.map((r) => `- ${r.id} [${r.kind}, ${r.enforcement}] ${r.statement}`), "Decisions:", ...policy.decisions.map((d) => `- ${d.id} [${d.status}] ${d.statement}`)];
        return text(lines.join("\n"), { policy_id: policy.policy_id, default_allowed_paths: policy.default_allowed_paths, protected_paths: policy.protected_paths, invariants: policy.invariants, architecture_rules: policy.architecture_rules, decisions: policy.decisions });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // ---- Background jobs: onboarding (the CLI in a child process) and the independent miner (a Codex side thread); the model polls status.
  interface Job {
    id: string;
    kind: "onboard" | "mine";
    repo: string;
    phase: "onboarding" | "mining" | "classifying" | "checking" | "done" | "failed";
    started_at: string;
    finished_at: string | null;
    log: string[];
    result: { policy_id: string | null; policy_file: string | null; suite: string | null; index: string | null; candidates: number | null; kept: number | null; filtered: number | null; note: string | null; model: string | null; accepted: number | null; rejected: number | null; rounds: number | null };
    error: string | null;
  }
  const jobs = new Map<string, Job>();
  const running = (j: Job | undefined): j is Job => !!j && j.phase !== "done" && j.phase !== "failed";
  const kindOf = (j: Job): string => (j.kind === "mine" ? "mining" : "onboarding");
  const newJob = (kind: Job["kind"], repo: string, phase: Job["phase"]): Job => ({ id: crypto.randomBytes(4).toString("hex"), kind, repo, phase, started_at: nowIso(), finished_at: null, log: [], result: { policy_id: null, policy_file: null, suite: null, index: null, candidates: null, kept: null, filtered: null, note: null, model: null, accepted: null, rejected: null, rounds: null }, error: null });
  const push = (job: Job, line: string) => {
    job.log.push(line);
    if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
  };
  const runMineJob = async (job: Job, a: { model: string; reasoning?: string; rounds?: number; append?: boolean; policy_id?: string; policy_file?: string; out_dir?: string }): Promise<void> => {
    try {
      job.phase = "mining";
      const r = await mineWithModel(job.repo, { model: a.model, reasoningEffort: a.reasoning, rounds: a.rounds, append: a.append, policyId: a.policy_id, policyFile: a.policy_file, outDir: a.out_dir, engine: opts.mineEngine?.(a.model) }, (l) => {
        push(job, l);
        if (/checking references/.test(l)) job.phase = "checking";
        else if (/^round \d+: \d+ accepted/.test(l)) job.phase = "mining";
      });
      Object.assign(job.result, { policy_id: r.policy_id, model: r.model, accepted: r.accepted.length, rejected: r.rejected.length, rounds: r.rounds.length, candidates: r.candidates.length, kept: r.candidates.length, filtered: 0, note: r.rejected.length ? `${r.rejected.length} candidate(s) still rejected after ${r.rounds.length} round(s): ${r.rejected.map((x) => x.title).join("; ")}` : null });
      job.phase = "done";
      log(`mine ${job.repo}: job ${job.id} done (${r.model ?? r.engine}: ${r.accepted.length} accepted, ${r.rejected.length} still rejected, ${r.rounds.length} round(s))`);
    } catch (e) {
      job.phase = "failed";
      job.error = (e as Error).message;
      log(`mine ${job.repo}: job ${job.id} failed: ${job.error}`);
    } finally {
      job.finished_at = nowIso();
    }
  };
  const runJob = async (job: Job, a: { policy_id?: string; policy_file?: string; classify: boolean; install: boolean; run_tests: boolean; force: boolean }): Promise<void> => {
    try {
      job.phase = "onboarding";
      const r1 = await runCli(["onboard", job.repo, ...(a.policy_id ? ["--policy-id", a.policy_id] : []), ...(a.policy_file ? ["--out", a.policy_file] : []), ...(a.install ? [] : ["--no-install"]), ...(a.run_tests ? [] : ["--no-test"]), ...(a.force ? ["--force"] : [])], (l) => push(job, l));
      if (r1.status !== 0) throw new Error(`intentos onboard failed: ${lastLine(r1.stderr) ?? `exit ${r1.status}`}`);
      const onboard = JSON.parse(r1.stdout) as { policy_id: string; policy_file: string; smoke: { status: string; summary: string }; index: { mode: string } | null };
      job.result.policy_id = onboard.policy_id;
      job.result.policy_file = onboard.policy_file;
      job.result.suite = `${onboard.smoke.status}: ${onboard.smoke.summary}`;
      job.result.index = onboard.index?.mode ?? null;
      job.phase = a.classify ? "classifying" : "mining";
      const r2 = await runCli(["suggest", job.repo, "--policy-id", onboard.policy_id, ...(a.classify ? ["--classify"] : [])], (l) => push(job, l));
      if (r2.status !== 0) throw new Error(`intentos suggest failed: ${lastLine(r2.stderr) ?? `exit ${r2.status}`}`);
      const s = JSON.parse(r2.stdout) as { candidates: Candidate[]; classification: { used: boolean; kept: number; filtered: number; note: string | null } };
      job.result.candidates = s.candidates.length;
      job.result.kept = s.classification.used ? s.classification.kept : s.candidates.length;
      job.result.filtered = s.classification.used ? s.classification.filtered : 0;
      job.result.note = s.classification.note;
      job.phase = "done";
      log(`onboard ${job.repo}: job ${job.id} done (${job.result.candidates} candidates, ${job.result.kept} kept; suite ${onboard.smoke.status})`);
    } catch (e) {
      job.phase = "failed";
      job.error = (e as Error).message;
      log(`onboard ${job.repo}: job ${job.id} failed: ${job.error}`);
    } finally {
      job.finished_at = nowIso();
    }
  };
  const inspect = (repoInput: string, policyIdOverride?: string, policyFileOverride?: string, outDirOverride?: string) => {
    const repo = path.resolve(repoInput);
    if (!fs.existsSync(repo) || !isGitRepo(repo)) throw new Error(`${repo} is not a Git repository`);
    const paths = resolvePaths();
    const job = jobs.get(repo);
    const policyId = policyIdFor(runProbe(repo), repo, policyIdOverride);
    const policyFile = policyFileOverride ? path.resolve(policyFileOverride) : path.join(paths.policies, `${policyId}.yaml`);
    const policyExists = fs.existsSync(policyFile);
    let approved = 0;
    if (policyExists) {
      try {
        const p = loadPolicyFile(policyFile);
        approved = p.invariants.length + p.architecture_rules.length + p.decisions.length;
      } catch {
        /* a draft being written, or a hand-edited file: counted as zero */
      }
    }
    const outDir = outDirOverride ? path.resolve(outDirOverride) : path.join(paths.home, "onboard", repoIdFor(repo));
    const suggestionsFile = path.join(outDir, "suggestions.json");
    let suggestions: { total: number; classified: number; kept: number; authored_by: "codex" | "miner"; author: Author | null; file: string } | null = null;
    if (fs.existsSync(suggestionsFile)) {
      const parsed = JSON.parse(fs.readFileSync(suggestionsFile, "utf8")) as { candidates: Candidate[]; authored_by?: string; author?: Author };
      const cs = parsed.candidates;
      const byHost = parsed.authored_by === "codex";
      suggestions = { total: cs.length, classified: cs.filter((c) => c.classification).length, kept: cs.filter((c) => !c.classification || c.classification.keep).length, authored_by: byHost ? "codex" : "miner", author: byHost ? (parsed.author ?? { via: "host", model: null }) : null, file: suggestionsFile };
    }
    const decisionsFile = path.join(outDir, "review-decisions.json");
    const decided = fs.existsSync(decisionsFile) ? (JSON.parse(fs.readFileSync(decisionsFile, "utf8")) as Decision[]).filter((d) => d.action !== "skip").length : 0;
    const pending = suggestions ? Math.max(0, suggestions.kept - decided) : null;
    const indexed = !!opts.store.getRepository(repoIdFor(repo));
    const failed = job && job.phase === "failed" ? job : null;
    const miningModel = resolveMiningModel();
    const mineHint = miningModel ? `call mine (INTENTOS_MINING_MODEL=${miningModel} is set: a model other than you does the mining)` : "call mine with model=<slug> for the independent miner (a model other than you)";
    const next = running(job)
      ? `${kindOf(job)} in progress (${job.phase}); call status again in about 20 seconds`
      : failed
        ? `${kindOf(failed)} failed: ${failed.error}; fix the cause and call ${failed.kind} again${failed.kind === "onboard" ? " (force=true if the draft policy was already written)" : ""}`
        : !policyExists
          ? `not onboarded: call onboard with repo=${repo}`
          : !suggestions
            ? `onboarded; now mine the business rules: ${mineHint}, or do it yourself with the ${SKILL_NAME} skill (mining_guide has the text: call mined, write the candidates with a test each, submit them with propose)`
            : suggestions.authored_by !== "codex"
              ? `the current ${suggestions.total} candidate(s) are the deterministic miner's; replace them: ${mineHint}, or author your own with the ${SKILL_NAME} skill and propose; or call review_start to review them as they are`
              : pending
                ? `${pending} candidate(s) await the reviewer: call review_start (the reviewer decides in the widget, or through review_next prompts when review_start says so)`
                : `review complete (${approved} approved rule(s)): call explain before planning a change and policy to read the rules`;
    return { repo, policy_id: policyId, policy_file: policyFile, policy: { exists: policyExists, approved_rules: approved }, indexed, suggestions, decided, pending, mining_model: miningModel, job: job ? { id: job.id, kind: job.kind, phase: job.phase, started_at: job.started_at, finished_at: job.finished_at, result: job.result, error: job.error, log_tail: job.log.slice(-12) } : null, next };
  };

  server.registerTool(
    "status",
    {
      description: "Where a repository stands with IntentOS: policy file present, index present, candidates mined / classified / awaiting the reviewer and who authored them, the progress of a running onboard or mine job, and the next tool to call. Call this first, and poll it while onboard or mine runs.",
      inputSchema: z.object({ repo: z.string().describe("absolute path of the repository root"), policy_id: z.string().optional(), policy_file: z.string().optional().describe("policy file (default policies/<policy-id>.yaml)"), out_dir: z.string().optional().describe("directory of the review files (default .intentos/onboard/<repo-id>)") }),
    },
    async ({ repo, policy_id, policy_file, out_dir }) => {
      try {
        const s = inspect(repo, policy_id, policy_file, out_dir);
        log(`status ${s.repo}: ${s.next}`);
        const tail = s.job?.log_tail.slice(-5) ?? [];
        return text(
          `${s.repo}: policy ${s.policy.exists ? `${s.policy_file} (${s.policy.approved_rules} approved rule(s))` : "none"}; index ${s.indexed ? "yes" : "no"}; candidates ${s.suggestions ? `${s.suggestions.total} (${s.suggestions.authored_by === "codex" ? `authored by ${describeAuthor(s.suggestions.author)}` : "from the deterministic miner"}), ${s.suggestions.kept} kept, ${s.pending} undecided` : "none"}${s.job ? `; job ${s.job.id} (${s.job.kind}) ${s.job.phase}${tail.length ? `\n  ${tail.join("\n  ")}` : ""}` : ""}\nNext: ${s.next}`,
          s,
        );
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "onboard",
    {
      description: 'Bring a repository under IntentOS, in the background: probe it, create a per-repo venv with its dependencies, write the DRAFT policy, run its test suite once, index it, mine the deterministic raw candidate list. Returns at once with a job id; poll status until phase is "done" (minutes), then mine the business rules with the intentos-policy-mining skill (mined, propose) and call review_start. Refuses to overwrite an existing policy unless force=true.',
      inputSchema: z.object({
        repo: z.string().describe("absolute path of the repository root (a Git checkout)"),
        policy_id: z.string().optional().describe("policy id (default: sanitised project name)"),
        policy_file: z.string().optional().describe("where to write the draft policy (default policies/<policy-id>.yaml)"),
        classify: z.boolean().optional().describe("let a Codex side thread sort the mined candidates (default false: you author the candidates yourself with the intentos-policy-mining skill after onboarding)"),
        install: z.boolean().optional().describe("create the venv and install dependencies (default true)"),
        run_tests: z.boolean().optional().describe("run the suite once at the base revision (default true)"),
        force: z.boolean().optional().describe("overwrite an existing policy file; approved rules in it are lost (default false)"),
      }),
    },
    async (a) => {
      try {
        const repo = path.resolve(a.repo);
        if (!fs.existsSync(repo) || !isGitRepo(repo)) return fail(`${repo} is not a Git repository`);
        const current = jobs.get(repo);
        if (running(current)) return text(`${kindOf(current)} of ${repo} is already running (job ${current.id}, phase ${current.phase}); call status until it is done`, { job_id: current.id, phase: current.phase, repo });
        const policyId = policyIdFor(runProbe(repo), repo, a.policy_id);
        const policyFile = a.policy_file ? path.resolve(a.policy_file) : path.join(resolvePaths().policies, `${policyId}.yaml`);
        if (fs.existsSync(policyFile) && !a.force) return fail(`${policyFile} already exists: this repository is onboarded. Call status or review_start to continue, or onboard with force=true to start over (the draft is rewritten; approved rules in that file are lost).`);
        const classify = a.classify ?? false;
        const job = newJob("onboard", repo, "onboarding");
        jobs.set(repo, job);
        log(`onboard ${repo}: job ${job.id} started (classify=${classify}, install=${a.install ?? true}, run_tests=${a.run_tests ?? true}, force=${a.force ?? false})`);
        void runJob(job, { policy_id: a.policy_id, policy_file: a.policy_file, classify, install: a.install ?? true, run_tests: a.run_tests ?? true, force: a.force ?? false });
        return text(`Onboarding started for ${repo} (job ${job.id}): venv and dependencies, draft policy ${policyFile}, one run of the suite, index, raw candidate mining${classify ? ", classification by Codex" : ""}. This takes a few minutes. Call status with repo=${repo} about every 20 seconds until phase is "done", then follow the ${SKILL_NAME} skill (mined, propose) and call review_start.`, { job_id: job.id, phase: job.phase, repo, policy_id: policyId, policy_file: policyFile });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // ---- Mining by the host (the intentos-policy-mining skill): the raw list, the guide, the submission.
  server.registerTool(
    "mined",
    {
      description: "The deterministic miner's raw candidate list for a repository (rule-like tests with hidden-test drafts, fix commits, must/never sentences from documents, layer imports, frozen directories), cached per revision. A starting point for the intentos-policy-mining skill, never the review list; cite an entry in propose with from_mined to inherit its evidence and test.",
      inputSchema: z.object({ repo: z.string().describe("absolute path of the repository root"), policy_id: z.string().optional(), out_dir: z.string().optional() }),
    },
    async ({ repo, policy_id, out_dir }) => {
      try {
        const mined = loadMined(repo, { policyId: policy_id, outDir: out_dir });
        const rows = minedRows(mined);
        log(`mined ${repo}: ${rows.length} raw candidate(s) at ${mined.head.slice(0, 7)}`);
        const lines = rows.map((r) => `${r.id} [${r.kind}, ${r.score.toFixed(2)}] ${r.title}: ${r.statement}${r.test ? ` (test ${r.test})` : ""}`);
        return text(`${rows.length} raw candidate(s) at ${mined.head.slice(0, 7)}; noise included, select and restate per the skill:\n${lines.join("\n")}`, { head: mined.head, count: rows.length, candidates: rows });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "mining_guide",
    { description: `The ${SKILL_NAME} skill text: how to mine a repository's business rules, what counts, where to look, how to write a candidate and its test, and the propose contract. Read it when the skill is not installed in this host.`, inputSchema: z.object({}) },
    async () => text(skillText()),
  );

  server.registerTool(
    "propose",
    {
      description: "Submit host-authored policy candidates for a repository, written per the intentos-policy-mining skill. Each candidate: kind, title, statement, category, rationale, confidence, relevance, evidence[{type, ref, excerpt}], applies_to_paths[], test {existing | source} (required for invariants), rule (architecture rules), sources, from_mined. IntentOS checks every reference against the repository, lifts an existing test or runs the one you wrote in the repository's venv at the current revision, and keeps only what passes; the result lists rejections with reasons. Replaces the review list unless append=true. Then call review_start.",
      inputSchema: z.object({
        repo: z.string().describe("absolute path of the repository root"),
        candidates: z.array(z.record(z.string(), z.unknown())).min(1).max(40).describe("candidate objects; mining_guide documents the fields"),
        append: z.boolean().optional().describe("add to the candidates accepted by an earlier propose instead of replacing them"),
        policy_id: z.string().optional(),
        policy_file: z.string().optional(),
        out_dir: z.string().optional(),
      }),
    },
    async ({ repo, candidates, append, policy_id, policy_file, out_dir }) => {
      try {
        const r = await ingestProposals(repo, candidates, { policyId: policy_id, policyFile: policy_file, outDir: out_dir, append }, log);
        log(`propose ${repo}: ${r.accepted.length} accepted, ${r.rejected.length} rejected (${r.candidates.length} in the review list)`);
        const acc = r.accepted.map((a) => `${a.id} ${a.title} [${a.kind}; test: ${a.verified}${a.notes.length ? `; ${a.notes.join("; ")}` : ""}]`);
        const rej = r.rejected.map((x) => `- ${x.title}: ${x.reasons.join(" | ")}`);
        const next = r.rejected.length ? "Fix the rejected candidates and call propose again with append=true for them only; then call review_start." : "Call review_start.";
        return text(`${r.accepted.length} accepted${acc.length ? `:\n${acc.join("\n")}` : ""}\n${r.rejected.length} rejected${rej.length ? `:\n${rej.join("\n")}` : ""}\nReview list: ${r.candidates.length} candidate(s) at ${r.head.slice(0, 7)}. ${next}`, { accepted: r.accepted, rejected: r.rejected, total: r.candidates.length, head: r.head, files: r.files });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "mine",
    {
      description: `Mine a repository's business rules with an independent model, in the background: IntentOS runs the ${SKILL_NAME} skill in a separate read-only Codex thread with the model you name (one other than yourself, so the model that finds the rules is not the one that drives this session or later implements under them), checks every reference and lifts or runs every test exactly as propose does, sends the rejections back to that thread once, and writes the review list with the author recorded. Returns at once with a job id; poll status about every 20 seconds until phase is "done" (minutes), then call review_start. Requires model unless INTENTOS_MINING_MODEL is set. append=true keeps the current list and adds this model's candidates (a second opinion next to yours).`,
      inputSchema: z.object({
        repo: z.string().describe("absolute path of the repository root (onboarded)"),
        model: z.string().optional().describe("Codex model slug for the side thread, e.g. gpt-6-astra; one the account can run and other than your own (default: INTENTOS_MINING_MODEL)"),
        reasoning: z.enum(["low", "medium", "high", "xhigh"]).optional().describe("reasoning effort for the side thread (default: the model's own)"),
        rounds: z.number().int().min(1).max(3).optional().describe("rounds at most, the first included: rejections go back to the model until none remain or the rounds are used up (default 2)"),
        append: z.boolean().optional().describe("add to the current review list instead of replacing it"),
        policy_id: z.string().optional(),
        policy_file: z.string().optional(),
        out_dir: z.string().optional(),
      }),
    },
    async (a) => {
      try {
        const repo = path.resolve(a.repo);
        if (!fs.existsSync(repo) || !isGitRepo(repo)) return fail(`${repo} is not a Git repository`);
        const current = jobs.get(repo);
        if (running(current)) return text(`${kindOf(current)} of ${repo} is already running (job ${current.id}, phase ${current.phase}); call status until it is done`, { job_id: current.id, phase: current.phase, repo });
        const policyId = policyIdFor(runProbe(repo), repo, a.policy_id);
        const policyFile = a.policy_file ? path.resolve(a.policy_file) : path.join(resolvePaths().policies, `${policyId}.yaml`);
        if (!fs.existsSync(policyFile)) return fail(`${repo} is not onboarded (no ${policyFile}). Call onboard first, poll status until phase is "done", then mine.`);
        const model = resolveMiningModel(a.model);
        if (!model) return fail("name the model: pass model=<slug> (one the Codex account can run, other than the model in this session) or set INTENTOS_MINING_MODEL in the server's environment. The point of mine is that a model other than the one in this session finds the rules; to mine yourself, follow the intentos-policy-mining skill and call propose.");
        const job = newJob("mine", repo, "mining");
        jobs.set(repo, job);
        log(`mine ${repo}: job ${job.id} started (model=${model}, reasoning=${a.reasoning ?? "default"}, rounds=${a.rounds ?? 2}, append=${a.append ?? false})`);
        void runMineJob(job, { model, reasoning: a.reasoning, rounds: a.rounds, append: a.append, policy_id: a.policy_id, policy_file: a.policy_file, out_dir: a.out_dir });
        return text(`Independent mining started for ${repo} with ${model} (job ${job.id}): the side thread reads the repository and follows the ${SKILL_NAME} skill, IntentOS checks and tests its candidates and sends rejections back once. This takes a few minutes. Call status with repo=${repo} about every 20 seconds until phase is "done", then call review_start.${a.append ? " The current review list is kept and this model's candidates are added to it." : " The review list is replaced by this model's candidates."}`, { job_id: job.id, phase: job.phase, repo, model, policy_id: policyId, policy_file: policyFile });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  registerAppTool(
    server,
    "review_start",
    {
      description: "Start the IntentOS policy review for a repository: the candidates mined by `intentos suggest` are shown one by one for a person to approve or reject. In hosts that render MCP Apps the review appears inline; otherwise the result contains a local URL for the reviewer to open. The model cannot approve candidates.",
      inputSchema: z.object({
        repo: z.string().describe("absolute path of the repository root"),
        include_filtered: z.boolean().optional().describe("also show candidates the classifier set aside"),
        policy_id: z.string().optional(),
        policy_file: z.string().optional().describe("policy file to append to (default policies/<policy-id>.yaml)"),
        out_dir: z.string().optional().describe("directory of the last suggest run"),
        hidden_tests_root: z.string().optional(),
        by: z.string().optional().describe("reviewer name for approved_by (default: git user.name)"),
      }),
      _meta: { ui: { resourceUri: REVIEW_RESOURCE_URI } },
    },
    async (args) => {
      try {
        const job = jobs.get(path.resolve(args.repo));
        if (running(job)) return fail(`${kindOf(job)} of ${args.repo} is still running (job ${job.id}, phase ${job.phase}); call status until it is done, then review_start`);
        if (session?.http) await session.http.close();
        const state = await loadReviewState(args.repo, { policyId: args.policy_id, outDir: args.out_dir, policyFile: args.policy_file, hiddenTestsRoot: args.hidden_tests_root, by: args.by ?? defaultReviewer(), includeFiltered: args.include_filtered, store: opts.store, log });
        const widget = uiSupported();
        const http = widget ? null : await startReviewServer(state, { port: 0, open: false, log });
        session = { state, token: crypto.randomBytes(16).toString("hex"), http, ui: widget ? "widget" : "link", started_at: nowIso() };
        log(`review_start ${args.repo}: ${state.candidates.length} candidates, ui=${widget ? "widget" : "link"}; ${describeClient()}`);
        const pending = state.candidates.filter((c) => !state.decisions.some((d) => d.id === c.id)).length;
        const summary = state.candidates.slice(0, 40).map((c) => ({ id: c.id, kind: c.kind, title: c.title, score: c.score, relevance: c.relevance, decided: state.decisions.find((d) => d.id === c.id)?.action ?? null }));
        const unclassified = state.candidates.length > 0 && state.candidates.every((c) => !c.classification);
        const head = `Policy review for ${state.policy_id}: ${state.candidates.length} candidate(s), ${pending} pending. Approvals go to ${state.policy_file}.${state.author ? ` Candidates authored by ${describeAuthor(state.author)}, checked and tested by IntentOS.` : ""}${unclassified ? " These candidates are ranked but not classified (noise included); onboard with classify=true first for a filtered list." : ""}`;
        const body = widget ? "The review is rendered inline; the reviewer approves, rejects and finishes there. Do not try to approve on their behalf, and do not call review_next: it would show the same candidate a second time as a form. Wait for the reviewer to say they are done." : `This host does not render MCP Apps. Ask the reviewer to open this link in a browser to approve or reject candidates: ${http!.url}`;
        return text(`${head}\n${body}`, { policy_id: state.policy_id, policy_file: state.policy_file, candidates: summary, pending, ui: widget ? "widget" : "link", ...(http ? { url: http.url } : {}) });
      } catch (e) {
        const msg = (e as Error).message;
        if (/run intentos onboard/.test(msg)) return fail(`${args.repo} is not onboarded (no policy file). Call onboard with repo=${args.repo}, poll status until phase is "done", then call review_start again.`);
        return fail(msg);
      }
    },
  );

  // ---- Elicitation path: the host shows the reviewer a form; the model only sees the outcome.
  const DECISION_SCHEMA = z.object({ decision: z.enum(["approve", "reject", "skip"]), statement: z.string().optional(), reason: z.string().optional(), fold_related: z.boolean().optional() });
  const CONFIRM_SCHEMA = z.object({ finish: z.boolean() });

  const nextPending = (state: ReviewState, id?: string): Candidate | null => {
    if (id) return state.candidates.find((c) => c.id === id) ?? null;
    return state.candidates.find((c) => !state.decisions.some((d) => d.id === c.id)) ?? null;
  };
  const relatedFoldable = (state: ReviewState, c: Candidate): Candidate[] => (c.cluster_members ?? []).map((m) => state.candidates.find((x) => x.id === m)).filter((m): m is Candidate => !!m && m.kind === "invariant" && c.kind === "invariant" && !!m.suggested_hidden_test && !state.decisions.some((d) => d.id === m.id));

  const decisionForm = (state: ReviewState, c: Candidate) => {
    const proposed = (c.classification?.rule ?? c.statement).slice(0, 400);
    const related = relatedFoldable(state, c);
    const pending = state.candidates.filter((x) => !state.decisions.some((d) => d.id === x.id)).length;
    const lines = [
      `IntentOS policy review — ${c.id} (${pending} pending) · ${c.kind.replace("_", " ")} · score ${c.score.toFixed(2)} (${c.relevance})`,
      `${c.title}`,
      c.classification ? `classifier: ${c.classification.category.replace("_", " ")}, ${c.classification.keep ? "keep" : "set aside"} — ${c.classification.reason}` : "",
      "Evidence:",
      ...c.evidence.slice(0, 4).map((e) => `- ${e.type} ${e.ref}: ${e.excerpt}`.slice(0, 200)),
      c.applies_to_paths?.length ? `applies to: ${c.applies_to_paths.join(", ")}` : "",
      c.sources?.length ? `source: ${c.sources.map((s) => `${s.path}${s.heading ? `#${s.heading}` : ""}`).join(", ")}` : `no document source: approving adds a section to ${state.doc_file}`,
      c.suggested_hidden_test ? `hidden test: ${c.suggested_hidden_test.from.startsWith("codex:") ? "written by you, passing at the base revision" : `lifted from ${c.suggested_hidden_test.from}`}${c.suggested_hidden_test.standalone ? "" : " (needs attention after approval)"}` : c.kind === "invariant" ? "no hidden test: the verifier cannot execute this invariant" : "",
      related.length ? `related candidates with tests that can be folded into this rule: ${related.map((r) => `${r.id} ${r.title}`).join("; ")}` : "",
      "",
      "Approving writes the policy entry with your name, the hidden test and the policy-notes section. Edit the statement if needed.",
    ].filter(Boolean);
    const properties: Record<string, PrimitiveSchemaDefinition> = {
      decision: { type: "string", title: "Decision", oneOf: [{ const: "approve", title: "Approve: add to the policy" }, { const: "reject", title: "Reject" }, { const: "skip", title: "Skip for now" }], default: "skip" },
      statement: { type: "string", title: "Rule statement", description: "One sentence that must hold; edit before approving", default: proposed, maxLength: 400 },
      reason: { type: "string", title: "Reason (for rejections, optional)", maxLength: 300 },
    };
    if (related.length) properties.fold_related = { type: "boolean", title: `Fold the ${related.length} related candidate(s) into this rule as extra hidden tests`, default: true };
    const form: Omit<ElicitRequestFormParams, "mode"> = { message: lines.join("\n"), requestedSchema: { type: "object", properties, required: ["decision"] } };
    return form;
  };

  const applyDecision = (state: ReviewState, c: Candidate, content: z.infer<typeof DECISION_SCHEMA>): Decision => {
    const merge_ids = content.fold_related ? relatedFoldable(state, c).map((r) => r.id) : [];
    return decide(state, { id: c.id, action: content.decision === "approve" ? "accept" : content.decision, statement: content.statement, reason: content.reason, merge_ids });
  };

  const decisionText = (state: ReviewState, d: Decision): string => {
    const pending = state.candidates.filter((x) => !state.decisions.some((dd) => dd.id === x.id)).length;
    const next = nextPending(state);
    const tail = next ? ` ${pending} pending; next: ${next.id} ${next.title}. Call review_next again to continue.` : " No candidates pending; call review_close to finish (feedback + re-index).";
    if (d.action === "accept") return `${d.id} approved as ${d.result!.assigned_id}${d.merged_ids?.length ? ` (folded ${d.merged_ids.join(", ")})` : ""}; policy ${d.result!.policy_file}${d.result!.hidden_test ? `; hidden test ${d.result!.hidden_test}` : ""}${d.result!.warnings.length ? `; note: ${d.result!.warnings.join(" | ")}` : ""}.${tail}`;
    return `${d.id} ${d.action === "reject" ? `rejected${d.reason ? ` (${d.reason})` : ""}` : "skipped"}.${tail}`;
  };

  server.registerTool(
    "review_next",
    {
      description: "Present the next pending policy candidate (or a given id) to the reviewer through the host's own prompt and apply their decision (approve / reject / skip, editable statement). The decision comes from the reviewer via elicitation, never from the model; the result reports what they chose. Call review_start first; call again for the next candidate. Not for hosts where review_start rendered the widget (ui=widget): the reviewer decides inside it.",
      inputSchema: z.object({ id: z.string().optional().describe("candidate id; default: next pending") }),
    },
    async ({ id }, ctx: ServerContext): Promise<CallToolResult | InputRequiredResult> => {
      if (!session) return fail("no review in progress; call review_start first");
      const state = session.state;
      if (state.finished) return fail("this review is finished; call review_start to begin a new one");
      // A host that rendered the widget (the Codex app does) must not also get the form: one prompt per candidate.
      if (session.ui === "widget") return text(`The review is rendered inline as a widget by this host; the reviewer approves, rejects and finishes it there. review_next is not needed and would show the same candidate a second time. Wait for the reviewer to say they are done, then call status.`, { ui: "widget", deferred: true, pending: state.candidates.filter((x) => !state.decisions.some((d) => d.id === x.id)).length });
      const c = nextPending(state, id);
      if (!c) return text("No candidates pending; call review_close to finish the review.", { pending: 0 });
      if (state.decisions.some((d) => d.id === c.id && (d.action === "accept" || d.action === "merge"))) return fail(`${c.id} was already decided`);
      const modes = elicitationModes();
      if (!modes.form) return fail(`this host does not support form elicitation; ask the reviewer to open the review page instead (${session.http?.url ?? "call review_start for the link"})`);
      const form = decisionForm(state, c);
      // Modern hosts: multi-round-trip. A retry arrives with the reviewer's answer under `decision`.
      if (modernEra()) {
        const responses = ctx.mcpReq.inputResponses;
        if (!responses) return inputRequired({ inputRequests: { decision: inputRequired.elicit(form) } });
        const content = acceptedContent(responses, "decision", DECISION_SCHEMA);
        if (!content) {
          const view = inputResponse(responses, "decision");
          const what = view.kind === "elicit" ? view.action : "gave no usable answer";
          log(`review_next ${c.id}: reviewer ${what}`);
          return text(`${c.id} left undecided (reviewer ${what}). Call review_next again to retry or pass another id.`, { pending: true });
        }
        try {
          const d = applyDecision(state, c, content);
          log(`review_next ${c.id} ${d.action}${d.result ? ` -> ${d.result.assigned_id}` : ""} (elicitation, modern)`);
          return text(decisionText(state, d), { decision: d });
        } catch (e) {
          return fail((e as Error).message);
        }
      }
      // Legacy hosts: push-style request; the handler waits for the reviewer.
      try {
        const result = await ctx.mcpReq.elicitInput({ mode: "form", ...form });
        if (result.action !== "accept" || !result.content) {
          log(`review_next ${c.id}: reviewer ${result.action}`);
          return text(`${c.id} left undecided (reviewer ${result.action}). Call review_next again to retry or pass another id.`, { pending: true });
        }
        const parsed = DECISION_SCHEMA.safeParse(result.content);
        if (!parsed.success) return fail(`the reviewer's answer did not match the form: ${parsed.error.message}`);
        const d = applyDecision(state, c, parsed.data);
        log(`review_next ${c.id} ${d.action}${d.result ? ` -> ${d.result.assigned_id}` : ""} (elicitation, legacy)`);
        return text(decisionText(state, d), { decision: d });
      } catch (e) {
        return fail(`elicitation failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "review_close",
    { description: "Ask the reviewer (through the host's own prompt) to confirm finishing the policy review; on confirmation records feedback for the next suggest run and re-indexes. The confirmation comes from the reviewer, not the model.", inputSchema: z.object({}) },
    async (_args, ctx: ServerContext): Promise<CallToolResult | InputRequiredResult> => {
      if (!session) return fail("no review in progress");
      const state = session.state;
      if (state.finished) return text("already finished", { finished: state.finished });
      const pending = state.candidates.filter((x) => !state.decisions.some((d) => d.id === x.id)).length;
      const finishField: PrimitiveSchemaDefinition = { type: "boolean", title: "Finish now", default: true };
      const form: Omit<ElicitRequestFormParams, "mode"> = { message: `Finish the IntentOS policy review for ${state.policy_id}? ${state.decisions.filter((d) => d.action === "accept").length} approved, ${state.decisions.filter((d) => d.action === "reject").length} rejected, ${pending} still pending. Finishing records feedback for the next run and re-indexes the repository.`, requestedSchema: { type: "object", properties: { finish: finishField }, required: ["finish"] } };
      let confirmed: boolean | null = null;
      if (modernEra()) {
        const responses = ctx.mcpReq.inputResponses;
        if (!responses) return inputRequired({ inputRequests: { confirm: inputRequired.elicit(form) } });
        confirmed = acceptedContent(responses, "confirm", CONFIRM_SCHEMA)?.finish ?? null;
      } else {
        try {
          const r = await ctx.mcpReq.elicitInput({ mode: "form", ...form });
          confirmed = r.action === "accept" ? (CONFIRM_SCHEMA.safeParse(r.content).data?.finish ?? null) : null;
        } catch (e) {
          return fail(`elicitation failed: ${(e as Error).message}`);
        }
      }
      if (!confirmed) return text("review left open (reviewer did not confirm)", { finished: null });
      const finished = finishReview(state);
      if (session.http) await session.http.close().catch(() => {});
      log(`review_close: approved ${finished.accepted}, merged ${finished.merged}, rejected ${finished.rejected}`);
      return text(`Review finished: approved ${finished.accepted}${finished.assigned.length ? ` (${finished.assigned.join("; ")})` : ""}, folded ${finished.merged}, rejected ${finished.rejected}, skipped ${finished.skipped}, pending ${finished.pending}.${finished.feedback ? ` Feedback recorded (${finished.feedback.accept_tokens.length} accept / ${finished.feedback.reject_tokens.length} reject terms).` : ""}${finished.index ? ` Re-indexed (${finished.index.mode}).` : ""} Commit the policy, the hidden tests and any new policy-notes section.`, { finished });
    },
  );

  // App-only tools: hidden from the model by visibility, and guarded by the widget token.
  const appOnly = { ui: { visibility: ["app" as const] } };
  server.registerTool("review_session", { description: "Widget only: the review session token and state.", inputSchema: z.object({}), _meta: appOnly }, async () => {
    if (!session) return fail("no review in progress");
    return text("session", { token: session.token, ...publicState(session.state) });
  });
  server.registerTool("review_state", { description: "Widget only: current review state.", inputSchema: z.object({ token: z.string() }), _meta: appOnly }, async ({ token }) => {
    const s = requireToken(token);
    if ("content" in s) return s;
    return text("state", publicState(s.state));
  });
  server.registerTool(
    "review_decide",
    { description: "Widget only: record the reviewer's decision on one candidate (approve, reject, skip); approvals land in the policy, the hidden tests and the policy notes.", inputSchema: z.object({ token: z.string(), id: z.string(), action: z.enum(["accept", "reject", "skip"]), statement: z.string().optional(), reason: z.string().optional(), merge_ids: z.array(z.string()).optional() }), _meta: appOnly },
    async ({ token, id, action, statement, reason, merge_ids }) => {
      const s = requireToken(token);
      if ("content" in s) return s;
      try {
        const decision = decide(s.state, { id, action, statement, reason, merge_ids });
        log(`review_decide ${id} ${action}${decision.result ? ` -> ${decision.result.assigned_id}` : ""}`);
        return text(decision.action === "accept" ? `approved as ${decision.result!.assigned_id}` : decision.action, { decision });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );
  server.registerTool("review_finish", { description: "Widget only: finish the review (feedback for the next suggest run, re-index).", inputSchema: z.object({ token: z.string() }), _meta: appOnly }, async ({ token }) => {
    const s = requireToken(token);
    if ("content" in s) return s;
    const finished = s.state.finished ?? finishReview(s.state);
    log(`review_finish: approved ${finished.accepted}, merged ${finished.merged}, rejected ${finished.rejected}`);
    if (s.http) await s.http.close().catch(() => {});
    return text(`finished: approved ${finished.accepted}, rejected ${finished.rejected}, skipped ${finished.skipped}`, { finished });
  });

  return { server, current: () => session, close: async () => { if (session?.http) await session.http.close().catch(() => {}); await server.close(); } };
}

/** Run the server on stdio (what `codex mcp add intentos -- node bin/intentos.js mcp` launches). */
/** GUI hosts start MCP servers with a bare PATH (the Codex app: none at all); the CLI children need node, git, python, codex. */
export function augmentedPath(env: NodeJS.ProcessEnv = process.env): string {
  const current = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of [path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin"), "/usr/bin", "/bin"]) {
    if (!current.includes(dir) && fs.existsSync(dir)) current.push(dir);
  }
  return current.join(path.delimiter);
}

/** Run one `intentos` CLI command with `--json`: stdout is the result, stderr progress lines go to `onLine`. */
function runCli(args: string[], onLine: (line: string) => void): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(PROJECT_ROOT, "bin", "intentos.js"), "--json", ...args], { env: { ...process.env, PATH: augmentedPath() }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) onLine(l.replace(/^\[(onboard|suggest)\] /, ""));
    });
    child.on("error", (e) => resolve({ status: null, stdout, stderr: `${stderr}\n${e.message}` }));
    child.on("close", (status) => {
      if (buf.trim()) onLine(buf.trim());
      resolve({ status, stdout, stderr });
    });
  });
}
const lastLine = (s: string): string | null => s.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? null;

export async function serveStdio(opts: McpOptions): Promise<void> {
  process.env.PATH = augmentedPath();
  const { server } = createIntentosMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  opts.log?.("intentos MCP server ready on stdio");
}

export function codexRegistrationCommand(projectRoot: string): string {
  // The absolute node path: the Codex app launches servers without a PATH, so a bare `node` fails to spawn.
  return `codex mcp add intentos -- ${process.execPath} --disable-warning=ExperimentalWarning ${path.join(projectRoot, "bin", "intentos.js")} mcp`;
}

export function defaultMcpLogFile(): string {
  return path.join(ensureHome(resolvePaths()).home, "mcp.log");
}
