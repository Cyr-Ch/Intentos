import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { PROJECT_ROOT, resolvePaths } from "./config.ts";
import { indexRepository, repoIdFor } from "./knowledge/indexer.ts";
import { PolicySchema, policyForRepo } from "./knowledge/policy.ts";
import { precedentsFile, readPrecedentsFile } from "./knowledge/precedents.ts";
import { KnowledgeStore } from "./knowledge/storage.ts";
import { git, isGitRepo } from "./util/git.ts";

type RuleKind = "invariants" | "architecture_rules" | "decisions";
const KINDS: RuleKind[] = ["invariants", "architecture_rules", "decisions"];

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let data = "";
  for await (const chunk of req) {
    data += String(chunk);
    if (data.length > 64_000) throw new Error("request is too large");
  }
  const parsed: unknown = JSON.parse(data || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object");
  return parsed as Record<string, unknown>;
}

function policyFile(repo: string): string | null {
  const policy = policyForRepo(repo);
  if (!policy) return null;
  for (const file of fs.readdirSync(resolvePaths().policies)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const full = path.join(resolvePaths().policies, file);
    try {
      if (YAML.parse(fs.readFileSync(full, "utf8"))?.policy_id === policy.policy_id) return full;
    } catch { /* the policy loader reports malformed files elsewhere */ }
  }
  return null;
}

function hash(text: string): string { return crypto.createHash("sha256").update(text).digest("hex"); }

function dashboardToken(): string {
  // Keep the link stable across demo/reset.sh, which replaces INTENTOS_HOME.
  const dir = path.join(os.homedir(), ".config", "intentos");
  const file = path.join(dir, "dashboard-token");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, crypto.randomBytes(18).toString("hex"), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const token = fs.readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9]{36}$/.test(token)) throw new Error(`Invalid dashboard token in ${file}`);
  return token;
}

export function renderEditedPolicy(before: string, edit: Record<string, unknown>): string {
  const kind = edit.kind;
  const id = edit.id;
  if (!KINDS.includes(kind as RuleKind) || typeof id !== "string") throw new Error("unknown rule");
  if (edit.policy_hash !== hash(before)) throw new Error("policy changed since this page loaded; refresh before saving");
  const doc = YAML.parseDocument(before, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors[0]!.message);
  const raw = doc.toJS() as Record<string, unknown>;
  const rows = raw[kind as RuleKind];
  if (!Array.isArray(rows)) throw new Error("policy section is missing");
  const at = rows.findIndex((item: unknown) => !!item && typeof item === "object" && (item as { id?: unknown }).id === id);
  if (at < 0) throw new Error("rule no longer exists; refresh the page");
  if (typeof edit.statement !== "string" || !edit.statement.trim()) throw new Error("statement cannot be empty");
  doc.setIn([kind as string, at, "statement"], edit.statement.trim());
  if (kind === "decisions") {
    if (!(["approved", "superseded", "proposed", "rejected"] as unknown[]).includes(edit.status)) throw new Error("invalid decision status");
    doc.setIn([kind as string, at, "status"], edit.status);
  } else {
    if (edit.enforcement !== "blocking" && edit.enforcement !== "advisory") throw new Error("invalid enforcement");
    doc.setIn([kind as string, at, "enforcement"], edit.enforcement);
  }
  const parsed = PolicySchema.safeParse(doc.toJS());
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  return doc.toString({ lineWidth: 0 });
}

function editRule(repo: string, edit: Record<string, unknown>): { policy_hash: string; index: string | null; warning: string | null } {
  const file = policyFile(repo);
  if (!file) throw new Error("no approved policy applies to this repository");
  const before = fs.readFileSync(file, "utf8");
  const next = renderEditedPolicy(before, edit);
  const temp = `${file}.dashboard-${process.pid}.tmp`;
  fs.writeFileSync(temp, next, { mode: 0o600 });
  fs.renameSync(temp, file);
  let index: string | null = null;
  let warning: string | null = null;
  try {
    const store = new KnowledgeStore(resolvePaths().db);
    try { index = indexRepository(store, repo).mode; } finally { store.close(); }
  } catch (error) { warning = `Policy saved; re-index failed: ${(error as Error).message}`; }
  return { policy_hash: hash(next), index, warning };
}

function liveState(repo: string, selected: string | null): unknown {
  const store = new KnowledgeStore(resolvePaths().db);
  try {
    const repoId = repoIdFor(repo);
    const indexed = store.getRepository(repoId);
    let hiddenRunIds = new Set<string>();
    const visibilityFile = path.join(resolvePaths().home, "dashboard.json");
    if (fs.existsSync(visibilityFile)) {
      const visibility = JSON.parse(fs.readFileSync(visibilityFile, "utf8")) as { hidden_run_ids?: unknown };
      if (Array.isArray(visibility.hidden_run_ids)) hiddenRunIds = new Set(visibility.hidden_run_ids.filter((id): id is string => typeof id === "string"));
    }
    const runs = store.listRuns(repoId).filter((run) => !hiddenRunIds.has(run.id)).slice(0, 20).map((run) => {
      const task = JSON.parse(run.task_json) as { task?: string; task_id?: string };
      const result = run.result_json ? JSON.parse(run.result_json) as { merge?: { merged?: boolean; tier?: number; blocked_by?: string[] } } : null;
      const merge = result?.merge;
      const displayState = merge?.merged ? "MERGED" : run.state === "HUMAN_REVIEW" || (run.state === "REVIEW_READY" && (merge?.tier ?? 0) > 0) ? "HUMAN_REVIEW" : run.state === "REVIEW_READY" && merge?.tier === 0 && !merge.blocked_by?.length ? "MERGE_READY" : run.state === "REVIEW_READY" ? "VERIFIED" : run.state;
      return { id: run.id, state: run.state, display_state: displayState, task: task.task ?? "", task_id: task.task_id ?? null, started_at: run.started_at, updated_at: run.updated_at, base: run.base_sha.slice(0, 10), merged: !!merge?.merged };
    });
    const runId = selected && runs.some((r) => r.id === selected) ? selected : runs[0]?.id;
    const run = runId ? store.getRun(runId) : null;
    const events: Array<{ id: number; at: string; type: string; payload: Record<string, unknown> }> = runId ? store.events(runId).map((e) => ({ id: e.id, at: e.timestamp, type: e.event_type, payload: JSON.parse(e.payload_json) as Record<string, unknown> })) : [];
    if (run?.worktree_path && fs.existsSync(run.worktree_path)) {
      try {
        const gitDir = git(run.worktree_path, ["rev-parse", "--git-dir"]).stdout.trim();
        const howMade = path.join(path.resolve(run.worktree_path, gitDir), "mergeguard", "howmade.jsonl");
        if (fs.existsSync(howMade)) {
          for (const [index, line] of fs.readFileSync(howMade, "utf8").split("\n").entries()) {
            if (!line.trim()) continue;
            const item = JSON.parse(line) as { ts?: string; event?: string; message?: string };
            if (item.event === "sync_note" || item.event === "stop_block") events.push({ id: -index - 1, at: item.ts ?? run.updated_at, type: `hook.${item.event}`, payload: item as Record<string, unknown> });
          }
        }
      } catch { /* a hook may be writing its log while this request is read */ }
    }
    events.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
    let verification: unknown = null;
    if (run) {
      const file = path.join(run.run_dir, "verification.json");
      if (fs.existsSync(file)) {
        try {
          const value = JSON.parse(fs.readFileSync(file, "utf8")) as { status: string; attempt: number; coordination?: { stale: boolean }; commands?: Array<{ command_id: string; status: string }> };
          verification = { status: value.status, attempt: value.attempt, coordination: value.coordination, commands: value.commands?.map((c) => ({ command_id: c.command_id, status: c.status })) ?? [] };
        } catch { /* a writer may be replacing the file */ }
      }
    }
    return { repo, indexed_at: indexed?.indexed_at ?? null, revision: indexed?.head_sha.slice(0, 10) ?? null, runs, selected: runId ?? null, events, verification, now: new Date().toISOString() };
  } finally { store.close(); }
}

function knowledgeState(repo: string): unknown {
  const store = new KnowledgeStore(resolvePaths().db);
  try {
    const repoId = repoIdFor(repo);
    const indexed = store.getRepository(repoId);
    const policy = policyForRepo(repo);
    const file = policyFile(repo);
    const source = file ? fs.readFileSync(file, "utf8") : null;
    const precedents = readPrecedentsFile(precedentsFile(resolvePaths(), repoId));
    const evidence = indexed ? store.evidence(repoId, indexed.head_sha) : [];
    return {
      repo, policy, policy_hash: source ? hash(source) : null, policy_file: file,
      revision: indexed?.head_sha.slice(0, 10) ?? null,
      evidence: evidence.filter((e) => ["code", "test", "doc", "policy", "precedent"].includes(e.source_type)).slice(0, 400),
      precedents: precedents?.precedents.map((p) => ({ id: p.id, number: p.number, title: p.title, url: p.url, labels: p.labels, pull: p.pull ? { number: p.pull.number, url: p.pull.url, files: p.pull.diff?.files.slice(0, 8) ?? [], symbols: p.pull.diff?.symbols.slice(0, 8) ?? [] } : null })) ?? [],
    };
  } finally { store.close(); }
}

export async function startDashboard(repoInput: string, opts: { port?: number; open?: boolean } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const repo = fs.realpathSync(path.resolve(repoInput));
  if (!isGitRepo(repo)) throw new Error(`${repo} is not a Git repository`);
  const token = dashboardToken();
  const html = fs.readFileSync(path.join(PROJECT_ROOT, "web", "dashboard.html"), "utf8").replaceAll("__TOKEN__", token);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.searchParams.get("token") !== token && req.headers["x-intentos-token"] !== token) return json(res, 403, { error: "use the URL printed by intentos dashboard" });
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(html);
      } else if (req.method === "GET" && url.pathname === "/api/live") json(res, 200, liveState(repo, url.searchParams.get("run")));
      else if (req.method === "GET" && url.pathname === "/api/knowledge") json(res, 200, knowledgeState(repo));
      else if (req.method === "POST" && url.pathname === "/api/policy/edit") json(res, 200, editRule(repo, await body(req)));
      else json(res, 404, { error: "not found" });
    } catch (error) { json(res, 400, { error: (error as Error).message }); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(opts.port ?? 8787, "127.0.0.1", resolve); });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/?token=${token}`;
  if (opts.open) {
    const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
    try { spawn(cmd[0]!, cmd.slice(1), { detached: true, stdio: "ignore" }).unref(); } catch { /* URL is printed */ }
  }
  return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
