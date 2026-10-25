import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexSettings, resolvePython } from "../config.ts";

/**
 * The only module that touches `@openai/codex-sdk`. Verified against the installed
 * SDK 0.164.0 type definitions (dist/index.d.ts): Codex, startThread/resumeThread,
 * thread.run(input, {outputSchema, signal}), thread.runStreamed, thread.id, Usage.
 */

export interface Usage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens?: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export interface EngineEvent {
  timestamp: string;
  type: string;
  payload: unknown;
}

export interface PlanRequest {
  cwd: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  signal?: AbortSignal;
  onEvent?: (e: EngineEvent) => void;
}
export interface PlanResult {
  text: string;
  usage: Usage | null;
  threadId: string | null;
  simulated: boolean;
  engine: string;
  model: string | null;
  items: unknown[];
}
export interface ImplementRequest {
  cwd: string;
  prompt: string;
  /** Resume an existing implementer thread (repairs). */
  threadId?: string | null;
  signal?: AbortSignal;
  onEvent?: (e: EngineEvent) => void;
}
export interface ImplementResult {
  finalResponse: string;
  usage: Usage | null;
  threadId: string | null;
  simulated: boolean;
  engine: string;
  model: string | null;
  items: unknown[];
  /** File paths the agent reported changing (from file_change items); informational only. */
  reportedChanges: string[];
}

export interface CodingEngine {
  readonly name: string;
  readonly simulated: boolean;
  plan(req: PlanRequest): Promise<PlanResult>;
  implement(req: ImplementRequest): Promise<ImplementResult>;
}

export interface CodexAuthStatus {
  available: boolean;
  mode: "api_key_env" | "chatgpt_session" | "none";
  detail: string;
}

/** Detects credentials the Codex CLI would use; does not validate them against the server. */
export function codexAuthStatus(): CodexAuthStatus {
  if (process.env.CODEX_API_KEY) return { available: true, mode: "api_key_env", detail: "CODEX_API_KEY is set" };
  if (process.env.OPENAI_API_KEY) return { available: true, mode: "api_key_env", detail: "OPENAI_API_KEY is set" };
  const authFile = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "auth.json");
  if (fs.existsSync(authFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(authFile, "utf8")) as { auth_mode?: string; tokens?: unknown; OPENAI_API_KEY?: string | null };
      if (parsed.tokens || parsed.OPENAI_API_KEY) return { available: true, mode: "chatgpt_session", detail: `~/.codex/auth.json (auth_mode=${parsed.auth_mode ?? "unknown"})` };
    } catch {
      /* fall through */
    }
  }
  return { available: false, mode: "none", detail: "no CODEX_API_KEY/OPENAI_API_KEY and no ~/.codex/auth.json session" };
}

type SdkModule = typeof import("@openai/codex-sdk");

export class LiveCodexEngine implements CodingEngine {
  readonly name = "codex-sdk";
  readonly simulated = false;
  private sdk: SdkModule | null = null;
  private readonly settings = codexSettings();

  private async codex() {
    if (!this.sdk) this.sdk = await import("@openai/codex-sdk");
    const { Codex } = this.sdk;
    const opts: ConstructorParameters<typeof Codex>[0] = {};
    if (this.settings.codexPathOverride) opts.codexPathOverride = this.settings.codexPathOverride;
    // Let the agent run the project's test runner: expose the verifier's interpreter directory on PATH
    // (the SDK inherits process.env). Verification itself never depends on what the agent ran.
    const pyDir = path.dirname(resolvePython());
    if (pyDir !== "." && !(process.env.PATH ?? "").split(path.delimiter).includes(pyDir)) {
      process.env.PATH = `${pyDir}${path.delimiter}${process.env.PATH ?? ""}`;
    }
    return new Codex(opts);
  }

  private threadOptions(cwd: string, sandboxMode: "read-only" | "workspace-write") {
    return {
      workingDirectory: cwd,
      sandboxMode,
      approvalPolicy: "never" as const,
      networkAccessEnabled: false,
      webSearchMode: "disabled" as const,
      skipGitRepoCheck: false,
      ...(this.settings.model ? { model: this.settings.model } : {}),
      ...(this.settings.reasoningEffort ? { modelReasoningEffort: this.settings.reasoningEffort as "low" } : {}),
    };
  }

  private withTimeout(signal: AbortSignal | undefined): { signal: AbortSignal; clear: () => void } {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`Codex turn exceeded ${this.settings.turnTimeoutMs} ms`)), this.settings.turnTimeoutMs);
    signal?.addEventListener("abort", () => ac.abort(signal.reason), { once: true });
    return { signal: ac.signal, clear: () => clearTimeout(timer) };
  }

  async plan(req: PlanRequest): Promise<PlanResult> {
    const codex = await this.codex();
    const thread = codex.startThread(this.threadOptions(req.cwd, "read-only"));
    const { signal, clear } = this.withTimeout(req.signal);
    try {
      const streamed = await thread.runStreamed(req.prompt, { outputSchema: req.outputSchema, signal });
      let finalText = "";
      let usage: Usage | null = null;
      let completed = false;
      let lastError: string | null = null;
      const items: unknown[] = [];
      for await (const ev of streamed.events) {
        req.onEvent?.({ timestamp: new Date().toISOString(), type: ev.type, payload: ev });
        if (ev.type === "item.completed") {
          items.push(ev.item);
          if (ev.item.type === "agent_message") finalText = ev.item.text;
        } else if (ev.type === "turn.completed") {
          usage = ev.usage;
          completed = true;
        } else if (ev.type === "turn.failed") throw new Error(`Codex planner turn failed: ${ev.error.message}`);
        else if (ev.type === "error") lastError = ev.message; // may be a transient "Reconnecting…" notice; fatal only if the turn never completes
      }
      if (!completed) throw new Error(`Codex planner stream ended without turn.completed${lastError ? `: ${lastError}` : ""}`);
      return { text: finalText, usage, threadId: thread.id, simulated: false, engine: this.name, model: this.settings.model, items };
    } finally {
      clear();
    }
  }

  async implement(req: ImplementRequest): Promise<ImplementResult> {
    const codex = await this.codex();
    const options = this.threadOptions(req.cwd, "workspace-write");
    const thread = req.threadId ? codex.resumeThread(req.threadId, options) : codex.startThread(options);
    const { signal, clear } = this.withTimeout(req.signal);
    try {
      const streamed = await thread.runStreamed(req.prompt, { signal });
      let finalResponse = "";
      let usage: Usage | null = null;
      let completed = false;
      let lastError: string | null = null;
      const items: unknown[] = [];
      const reportedChanges = new Set<string>();
      for await (const ev of streamed.events) {
        req.onEvent?.({ timestamp: new Date().toISOString(), type: ev.type, payload: ev });
        if (ev.type === "item.completed") {
          items.push(ev.item);
          if (ev.item.type === "agent_message") finalResponse = ev.item.text;
          if (ev.item.type === "file_change") for (const c of ev.item.changes) reportedChanges.add(c.path);
        } else if (ev.type === "turn.completed") {
          usage = ev.usage;
          completed = true;
        } else if (ev.type === "turn.failed") throw new Error(`Codex implementer turn failed: ${ev.error.message}`);
        else if (ev.type === "error") lastError = ev.message;
      }
      if (!completed) throw new Error(`Codex implementer stream ended without turn.completed${lastError ? `: ${lastError}` : ""}`);
      return { finalResponse, usage, threadId: thread.id, simulated: false, engine: this.name, model: this.settings.model, items, reportedChanges: [...reportedChanges] };
    } finally {
      clear();
    }
  }
}
