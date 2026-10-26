import fs from "node:fs";
import path from "node:path";
import { McpServer, acceptedContent, inputRequired, inputResponse, type CallToolResult, type ElicitRequestFormParams, type InputRequiredResult, type PrimitiveSchemaDefinition, type ServerContext } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { getUiCapability, registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { ensureHome, resolvePaths } from "./config.ts";
import type { KnowledgeStore } from "./knowledge/storage.ts";
import { loadIndexedRepo } from "./knowledge/repo.ts";
import { buildEvidencePack } from "./knowledge/retrieval.ts";
import { fallbackPolicy, policyForRepo } from "./knowledge/policy.ts";
import { renderEvidencePack } from "./reports/explain.ts";
import { decide, defaultReviewer, finishReview, loadReviewState, publicState, reviewPage, startReviewServer, type Decision, type ReviewServer, type ReviewState } from "./review.ts";
import type { Candidate } from "./suggest.ts";
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
 */

export const REVIEW_RESOURCE_URI = "ui://intentos/review.html";

export interface McpOptions {
  store: KnowledgeStore;
  /** Where to log client info and tool calls (stderr is reserved for the transport's diagnostics). */
  logFile?: string;
  log?: (line: string) => void;
}

interface Session {
  state: ReviewState;
  token: string;
  http: ReviewServer | null;
  started_at: string;
}

const text = (t: string, structured?: Record<string, unknown>): CallToolResult => ({ content: [{ type: "text", text: t }], ...(structured ? { structuredContent: structured } : {}) });
const fail = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }], isError: true });

export function createIntentosMcpServer(opts: McpOptions): { server: McpServer; current: () => Session | null; close: () => Promise<void> } {
  const server = new McpServer({ name: "intentos", version: "0.1.0" });
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
        if (session?.http) await session.http.close();
        const state = await loadReviewState(args.repo, { policyId: args.policy_id, outDir: args.out_dir, policyFile: args.policy_file, hiddenTestsRoot: args.hidden_tests_root, by: args.by ?? defaultReviewer(), includeFiltered: args.include_filtered, store: opts.store, log });
        const widget = uiSupported();
        const http = widget ? null : await startReviewServer(state, { port: 0, open: false, log });
        session = { state, token: crypto.randomBytes(16).toString("hex"), http, started_at: nowIso() };
        log(`review_start ${args.repo}: ${state.candidates.length} candidates, ui=${widget ? "widget" : "link"}; ${describeClient()}`);
        const pending = state.candidates.filter((c) => !state.decisions.some((d) => d.id === c.id)).length;
        const summary = state.candidates.slice(0, 40).map((c) => ({ id: c.id, kind: c.kind, title: c.title, score: c.score, relevance: c.relevance, decided: state.decisions.find((d) => d.id === c.id)?.action ?? null }));
        const head = `Policy review for ${state.policy_id}: ${state.candidates.length} candidate(s), ${pending} pending. Approvals go to ${state.policy_file}.`;
        const body = widget ? "The review is rendered inline; the reviewer approves or rejects each candidate there. Do not try to approve on their behalf." : `This host does not render MCP Apps. Ask the reviewer to open this link in a browser to approve or reject candidates: ${http!.url}`;
        return text(`${head}\n${body}`, { policy_id: state.policy_id, policy_file: state.policy_file, candidates: summary, pending, ui: widget ? "widget" : "link", ...(http ? { url: http.url } : {}) });
      } catch (e) {
        return fail((e as Error).message);
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
      c.suggested_hidden_test ? `hidden test: lifted from ${c.suggested_hidden_test.from}${c.suggested_hidden_test.standalone ? "" : " (needs attention after approval)"}` : c.kind === "invariant" ? "no hidden test: the verifier cannot execute this invariant" : "",
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
      description: "Present the next pending policy candidate (or a given id) to the reviewer through the host's own prompt and apply their decision (approve / reject / skip, editable statement). The decision comes from the reviewer via elicitation, never from the model; the result reports what they chose. Call review_start first; call again for the next candidate.",
      inputSchema: z.object({ id: z.string().optional().describe("candidate id; default: next pending") }),
    },
    async ({ id }, ctx: ServerContext): Promise<CallToolResult | InputRequiredResult> => {
      if (!session) return fail("no review in progress; call review_start first");
      const state = session.state;
      if (state.finished) return fail("this review is finished; call review_start to begin a new one");
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
export async function serveStdio(opts: McpOptions): Promise<void> {
  const { server } = createIntentosMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  opts.log?.("intentos MCP server ready on stdio");
}

export function codexRegistrationCommand(projectRoot: string): string {
  return `codex mcp add intentos -- node --disable-warning=ExperimentalWarning ${path.join(projectRoot, "bin", "intentos.js")} mcp`;
}

export function defaultMcpLogFile(): string {
  return path.join(ensureHome(resolvePaths()).home, "mcp.log");
}
