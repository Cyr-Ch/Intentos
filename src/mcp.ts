import fs from "node:fs";
import path from "node:path";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { getUiCapability, registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { ensureHome, resolvePaths } from "./config.ts";
import type { KnowledgeStore } from "./knowledge/storage.ts";
import { loadIndexedRepo } from "./knowledge/repo.ts";
import { buildEvidencePack } from "./knowledge/retrieval.ts";
import { fallbackPolicy, policyForRepo } from "./knowledge/policy.ts";
import { renderEvidencePack } from "./reports/explain.ts";
import { decide, defaultReviewer, finishReview, loadReviewState, publicState, reviewPage, startReviewServer, type ReviewServer, type ReviewState } from "./review.ts";
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

  // What the host declared on connect (UI extension or not) is the first thing a test run needs to know.
  server.server.oninitialized = () => log(`initialized: ${describeClient()} clientInfo=${JSON.stringify(server.server.getClientVersion?.() ?? null)}`);

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
