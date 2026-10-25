import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, InvalidTransitionError, TERMINAL_STATES } from "../../src/orchestrator/workflow.ts";
import { KnowledgeStore } from "../../src/knowledge/storage.ts";
import { RunStore } from "../../src/orchestrator/store.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("workflow transitions", () => {
  it("allows the happy path", () => {
    const path_ = ["CREATED", "INDEXED", "CONTEXT_RETRIEVED", "CONTRACT_PROPOSED", "CONTRACT_VALIDATED", "APPROVED", "IMPLEMENTING", "VERIFYING", "REPAIRING", "VERIFYING", "REVIEW_READY"] as const;
    for (let i = 0; i < path_.length - 1; i++) expect(canTransition(path_[i]!, path_[i + 1]!)).toBe(true);
  });
  it("rejects skipping verification or leaving terminal states", () => {
    expect(canTransition("IMPLEMENTING", "REVIEW_READY")).toBe(false);
    expect(canTransition("APPROVED", "REVIEW_READY")).toBe(false);
    expect(canTransition("CONTRACT_PROPOSED", "APPROVED")).toBe(false);
    for (const s of TERMINAL_STATES) expect(canTransition(s, "VERIFYING")).toBe(false);
    expect(() => assertTransition("REVIEW_READY", "FAILED")).toThrow(InvalidTransitionError);
  });
  it("persists transitions transactionally and refuses invalid ones", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intentos-wf-"));
    const store = new KnowledgeStore(path.join(dir, "db.sqlite"));
    store.upsertRepository({ id: "repo-x", path: "/x", head_sha: "abc", indexed_at: "now" });
    const now = new Date().toISOString();
    store.insertRun({ id: "run-1", repo_id: "repo-x", base_sha: "abc", worktree_path: null, state: "CREATED", contract_json: null, contract_hash: null, codex_thread_id: null, started_at: now, updated_at: now, result_json: null, task_json: JSON.stringify({ task: "t" }), mode: "offline", run_dir: path.join(dir, "run-1") });
    const rs = new RunStore(store, "run-1", path.join(dir, "run-1"));
    rs.transition("INDEXED", { revision: "abc" });
    rs.transition("CONTEXT_RETRIEVED");
    expect(() => rs.transition("APPROVED")).toThrow(InvalidTransitionError);
    expect(rs.state).toBe("CONTEXT_RETRIEVED");
    const events = store.events("run-1").filter((e) => e.event_type === "state.transition");
    expect(events.map((e) => (JSON.parse(e.payload_json) as { to: string }).to)).toEqual(["INDEXED", "CONTEXT_RETRIEVED"]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "run-1", "state.json"), "utf8")).state).toBe("CONTEXT_RETRIEVED");
    store.close();
  });
});
