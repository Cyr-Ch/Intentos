import fs from "node:fs";
import path from "node:path";
import type { KnowledgeStore, RunRow } from "../knowledge/storage.ts";
import { assertTransition, isRunState, type RunState } from "./workflow.ts";
import { nowIso } from "../util/ids.ts";
import { ensureDir, writeJson, readJson, fileExists } from "../util/paths.ts";
import { redactDeep } from "../util/redact.ts";

/** Artifact layout for a run directory (spec §13.3). */
export const RUN_FILES = {
  task: "task.json",
  baseCommit: "base_commit.txt",
  environment: "environment.json",
  evidence: "evidence.json",
  plannerPrompt: "planner_prompt.txt",
  plannerOutput: "planner_output.json",
  contract: "contract.json",
  contractValidation: "contract_validation.json",
  implementationPrompt: "implementation_prompt.txt",
  codexEvents: "codex_events.jsonl",
  implementerResult: "implementer_result.json",
  diff: "diff.patch",
  verification: "verification.json",
  reportJson: "report.json",
  reportMd: "report.md",
  metrics: "metrics.json",
  state: "state.json",
} as const;

export interface TaskRecord {
  task_id: string;
  task: string;
  repo_path: string;
  repo_id: string;
  mode: "live" | "offline";
  created_at: string;
  hidden_task_tests_dir: string | null;
  benchmark_task_id: string | null;
  /** Engine options recorded at creation so `resume` reproduces the same simulated behaviour. */
  engine_options: Record<string, unknown> | null;
}

/** Durable run state: SQLite row + events, mirrored to the run directory for inspectability. */
export class RunStore {
  readonly store: KnowledgeStore;
  readonly runDir: string;
  readonly runId: string;

  constructor(store: KnowledgeStore, runId: string, runDir: string) {
    this.store = store;
    this.runId = runId;
    this.runDir = ensureDir(runDir);
  }

  get row(): RunRow {
    const row = this.store.getRun(this.runId);
    if (!row) throw new Error(`run ${this.runId} not found`);
    return row;
  }

  get state(): RunState {
    const s = this.row.state;
    if (!isRunState(s)) throw new Error(`run ${this.runId} has unknown state ${s}`);
    return s;
  }

  /** Transactionally transition state and record an event. Invalid transitions throw. */
  transition(to: RunState, payload: Record<string, unknown> = {}, patch: Partial<Omit<RunRow, "id">> = {}): void {
    const from = this.state;
    assertTransition(from, to);
    const ts = nowIso();
    this.store.transaction(() => {
      this.store.updateRun(this.runId, { ...patch, state: to, updated_at: ts });
      this.store.appendEvent(this.runId, "state.transition", { from, to, ...redactDeep(payload) }, ts);
    });
    this.writeStateFile();
  }

  event(type: string, payload: unknown): void {
    this.store.appendEvent(this.runId, type, redactDeep(payload));
  }

  update(patch: Partial<Omit<RunRow, "id">>): void {
    this.store.updateRun(this.runId, { ...patch, updated_at: nowIso() });
    this.writeStateFile();
  }

  path(name: keyof typeof RUN_FILES | string): string {
    const file = (RUN_FILES as Record<string, string>)[name] ?? name;
    return path.join(this.runDir, file);
  }

  writeJson(name: keyof typeof RUN_FILES | string, value: unknown): void {
    writeJson(this.path(name), redactDeep(value));
  }

  writeText(name: keyof typeof RUN_FILES | string, text: string): void {
    ensureDir(path.dirname(this.path(name)));
    fs.writeFileSync(this.path(name), text);
  }

  readJson<T>(name: keyof typeof RUN_FILES | string): T | null {
    const p = this.path(name);
    return fileExists(p) ? readJson<T>(p) : null;
  }

  appendEventLine(value: unknown): void {
    fs.appendFileSync(this.path("codexEvents"), JSON.stringify(redactDeep(value)) + "\n");
  }

  private writeStateFile(): void {
    const row = this.row;
    writeJson(this.path("state"), {
      run_id: row.id,
      state: row.state,
      base_sha: row.base_sha,
      worktree_path: row.worktree_path,
      contract_hash: row.contract_hash,
      codex_thread_id: row.codex_thread_id,
      mode: row.mode,
      started_at: row.started_at,
      updated_at: row.updated_at,
    });
  }
}
