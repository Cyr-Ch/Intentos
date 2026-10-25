import fs from "node:fs";
import type { KnowledgeStore } from "../knowledge/storage.ts";
import { RunStore } from "./store.ts";
import { headSha, git } from "../util/git.ts";
import { contractHash } from "../contracts/compiler.ts";
import type { ChangeContract } from "../contracts/schemas.ts";
import { TERMINAL_STATES, isRunState, type RunState } from "./workflow.ts";

export interface IntegrityReport {
  ok: boolean;
  state: RunState;
  checks: Array<{ check: string; ok: boolean; detail: string }>;
}

/** Validate persisted run state before resuming; never continue from an inconsistent state. */
export function checkRunIntegrity(store: KnowledgeStore, runId: string): { rs: RunStore; report: IntegrityReport } {
  const row = store.getRun(runId);
  if (!row) throw new Error(`run ${runId} not found`);
  if (!isRunState(row.state)) throw new Error(`run ${runId} has unknown state ${row.state}`);
  const rs = new RunStore(store, runId, row.run_dir);
  const checks: IntegrityReport["checks"] = [];
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });

  add("run_dir", fs.existsSync(row.run_dir), row.run_dir);
  const repo = store.getRepository(row.repo_id);
  add("repository_known", !!repo, repo?.path ?? "missing repository row");
  if (repo) {
    let head = "unavailable";
    try {
      head = headSha(repo.path);
    } catch {
      /* repo gone */
    }
    add("base_revision_reachable", head !== "unavailable", `repo HEAD ${head.slice(0, 10)} (run base ${row.base_sha.slice(0, 10)})`);
  }
  if (row.contract_json) {
    const c = JSON.parse(row.contract_json) as ChangeContract;
    const h = contractHash(c);
    add("contract_hash", h === row.contract_hash, h === row.contract_hash ? "stored contract matches its hash" : `contract tampered: ${h.slice(0, 12)} != ${row.contract_hash?.slice(0, 12)}`);
    const onDisk = rs.readJson<ChangeContract>("contract");
    if (onDisk) add("contract_file", contractHash(onDisk) === row.contract_hash, "run-dir contract.json matches the stored hash");
  }
  if (row.worktree_path) {
    const exists = fs.existsSync(row.worktree_path);
    add("worktree_exists", exists, row.worktree_path);
    if (exists) {
      const res = git(row.worktree_path, ["rev-parse", "HEAD"], { allowFail: true });
      const wtHead = res.stdout.trim();
      add("worktree_at_base", res.status === 0 && wtHead === row.base_sha, `worktree HEAD ${wtHead.slice(0, 10)}`);
    }
  } else if (["IMPLEMENTING", "VERIFYING", "REPAIRING"].includes(row.state)) {
    add("worktree_exists", false, "state requires a worktree but none is recorded");
  }
  const ok = checks.every((c) => c.ok);
  return { rs, report: { ok, state: row.state as RunState, checks } };
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}
