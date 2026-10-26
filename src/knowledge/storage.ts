import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export type Authority =
  | "approved_policy"
  | "approved_decision"
  | "executable_contract"
  | "current_implementation"
  | "historical_precedent"
  | "model_inference"
  | "untrusted_external";

export type EpistemicStatus = "confirmed" | "supported" | "hypothesized" | "conflicted" | "superseded";

export interface RepositoryRow {
  id: string;
  path: string;
  head_sha: string;
  indexed_at: string;
}

export interface NodeRow {
  id: string;
  repo_id: string;
  revision: string;
  kind: string;
  qualified_name: string | null;
  attributes_json: string;
}

export interface EdgeRow {
  id: string;
  repo_id: string;
  revision: string;
  from_node: string;
  relation: string;
  to_node: string;
  evidence_id: string | null;
  confidence: number | null;
}

export interface EvidenceRow {
  id: string;
  repo_id: string;
  revision: string;
  source_type: string;
  path: string | null;
  line_start: number | null;
  line_end: number | null;
  source_ref: string | null;
  authority: Authority;
  status: EpistemicStatus;
  content_hash: string | null;
  summary: string | null;
}

export interface DecisionRow {
  id: string;
  repo_id: string;
  statement: string;
  scope_json: string;
  status: string;
  evidence_ids_json: string;
  approved_by: string | null;
  effective_revision: string | null;
  supersedes: string | null;
  authority: Authority;
  created_at: string;
  rationale: string | null;
}

export interface RunRow {
  id: string;
  repo_id: string;
  base_sha: string;
  worktree_path: string | null;
  state: string;
  contract_json: string | null;
  contract_hash: string | null;
  codex_thread_id: string | null;
  started_at: string;
  updated_at: string;
  result_json: string | null;
  task_json: string;
  mode: string;
  run_dir: string;
}

export interface RunEventRow {
  id: number;
  run_id: string;
  timestamp: string;
  event_type: string;
  payload_json: string;
}

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  revision TEXT NOT NULL,
  kind TEXT NOT NULL,
  qualified_name TEXT,
  attributes_json TEXT NOT NULL,
  PRIMARY KEY (id, repo_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_nodes_repo_rev_kind ON nodes(repo_id, revision, kind);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified ON nodes(repo_id, revision, qualified_name);
CREATE TABLE IF NOT EXISTS edges (
  id TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  revision TEXT NOT NULL,
  from_node TEXT NOT NULL,
  relation TEXT NOT NULL,
  to_node TEXT NOT NULL,
  evidence_id TEXT,
  confidence REAL,
  PRIMARY KEY (id, repo_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(repo_id, revision, from_node, relation);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(repo_id, revision, to_node, relation);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  revision TEXT NOT NULL,
  source_type TEXT NOT NULL,
  path TEXT,
  line_start INTEGER,
  line_end INTEGER,
  source_ref TEXT,
  authority TEXT NOT NULL,
  status TEXT NOT NULL,
  content_hash TEXT,
  summary TEXT,
  PRIMARY KEY (id, repo_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_evidence_path ON evidence(repo_id, revision, path);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  statement TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  approved_by TEXT,
  effective_revision TEXT,
  supersedes TEXT,
  authority TEXT NOT NULL DEFAULT 'model_inference',
  created_at TEXT NOT NULL,
  rationale TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  base_sha TEXT NOT NULL,
  worktree_path TEXT,
  state TEXT NOT NULL,
  contract_json TEXT,
  contract_hash TEXT,
  codex_thread_id TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  result_json TEXT,
  task_json TEXT NOT NULL,
  mode TEXT NOT NULL,
  run_dir TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);
`,
  },
];

export class KnowledgeStore {
  readonly db: DatabaseSync;
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set(
      (this.db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((r) => r.version),
    );
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.transaction(() => {
        this.db.exec(m.sql);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(m.version, new Date().toISOString());
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- repositories -------------------------------------------------------

  upsertRepository(row: RepositoryRow): void {
    this.db
      .prepare(
        `INSERT INTO repositories(id, path, head_sha, indexed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET path = excluded.path, head_sha = excluded.head_sha, indexed_at = excluded.indexed_at`,
      )
      .run(row.id, row.path, row.head_sha, row.indexed_at);
  }

  getRepository(id: string): RepositoryRow | null {
    return (this.db.prepare("SELECT * FROM repositories WHERE id = ?").get(id) as RepositoryRow | undefined) ?? null;
  }

  listRepositories(): RepositoryRow[] {
    return this.db.prepare("SELECT * FROM repositories ORDER BY indexed_at DESC").all() as unknown as RepositoryRow[];
  }

  /** Revisions with indexed nodes for a repository. */
  indexedRevisions(repoId: string): string[] {
    return (this.db.prepare("SELECT DISTINCT revision FROM nodes WHERE repo_id = ?").all(repoId) as Array<{ revision: string }>).map(
      (r) => r.revision,
    );
  }

  // ---- graph --------------------------------------------------------------

  replaceRevision(repoId: string, revision: string, nodes: NodeRow[], edges: EdgeRow[], evidence: EvidenceRow[]): void {
    this.transaction(() => {
      for (const table of ["nodes", "edges", "evidence"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE repo_id = ? AND revision = ?`).run(repoId, revision);
      }
      const insNode = this.db.prepare(
        "INSERT OR IGNORE INTO nodes(id, repo_id, revision, kind, qualified_name, attributes_json) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const n of nodes) insNode.run(n.id, repoId, revision, n.kind, n.qualified_name, n.attributes_json);
      const insEdge = this.db.prepare(
        "INSERT OR IGNORE INTO edges(id, repo_id, revision, from_node, relation, to_node, evidence_id, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const e of edges) insEdge.run(e.id, repoId, revision, e.from_node, e.relation, e.to_node, e.evidence_id, e.confidence);
      const insEv = this.db.prepare(
        `INSERT OR IGNORE INTO evidence(id, repo_id, revision, source_type, path, line_start, line_end, source_ref, authority, status, content_hash, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const ev of evidence) {
        insEv.run(ev.id, repoId, revision, ev.source_type, ev.path, ev.line_start, ev.line_end, ev.source_ref, ev.authority, ev.status, ev.content_hash, ev.summary);
      }
    });
  }

  nodes(repoId: string, revision: string, kind?: string): NodeRow[] {
    if (kind) {
      return this.db.prepare("SELECT * FROM nodes WHERE repo_id = ? AND revision = ? AND kind = ?").all(repoId, revision, kind) as unknown as NodeRow[];
    }
    return this.db.prepare("SELECT * FROM nodes WHERE repo_id = ? AND revision = ?").all(repoId, revision) as unknown as NodeRow[];
  }

  node(repoId: string, revision: string, id: string): NodeRow | null {
    return (this.db.prepare("SELECT * FROM nodes WHERE repo_id = ? AND revision = ? AND id = ?").get(repoId, revision, id) as NodeRow | undefined) ?? null;
  }

  edges(repoId: string, revision: string): EdgeRow[] {
    return this.db.prepare("SELECT * FROM edges WHERE repo_id = ? AND revision = ?").all(repoId, revision) as unknown as EdgeRow[];
  }

  edgesFrom(repoId: string, revision: string, fromNode: string, relation?: string): EdgeRow[] {
    if (relation) {
      return this.db
        .prepare("SELECT * FROM edges WHERE repo_id = ? AND revision = ? AND from_node = ? AND relation = ?")
        .all(repoId, revision, fromNode, relation) as unknown as EdgeRow[];
    }
    return this.db.prepare("SELECT * FROM edges WHERE repo_id = ? AND revision = ? AND from_node = ?").all(repoId, revision, fromNode) as unknown as EdgeRow[];
  }

  edgesTo(repoId: string, revision: string, toNode: string, relation?: string): EdgeRow[] {
    if (relation) {
      return this.db
        .prepare("SELECT * FROM edges WHERE repo_id = ? AND revision = ? AND to_node = ? AND relation = ?")
        .all(repoId, revision, toNode, relation) as unknown as EdgeRow[];
    }
    return this.db.prepare("SELECT * FROM edges WHERE repo_id = ? AND revision = ? AND to_node = ?").all(repoId, revision, toNode) as unknown as EdgeRow[];
  }

  evidence(repoId: string, revision: string): EvidenceRow[] {
    return this.db.prepare("SELECT * FROM evidence WHERE repo_id = ? AND revision = ?").all(repoId, revision) as unknown as EvidenceRow[];
  }

  evidenceById(repoId: string, revision: string, id: string): EvidenceRow | null {
    return (this.db.prepare("SELECT * FROM evidence WHERE repo_id = ? AND revision = ? AND id = ?").get(repoId, revision, id) as EvidenceRow | undefined) ?? null;
  }

  // ---- decisions ----------------------------------------------------------

  upsertDecision(row: DecisionRow): void {
    this.db
      .prepare(
        `INSERT INTO decisions(id, repo_id, statement, scope_json, status, evidence_ids_json, approved_by, effective_revision, supersedes, authority, created_at, rationale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET statement = excluded.statement, scope_json = excluded.scope_json, status = excluded.status,
           evidence_ids_json = excluded.evidence_ids_json, approved_by = excluded.approved_by, effective_revision = excluded.effective_revision,
           supersedes = excluded.supersedes, authority = excluded.authority, rationale = excluded.rationale`,
      )
      .run(row.id, row.repo_id, row.statement, row.scope_json, row.status, row.evidence_ids_json, row.approved_by, row.effective_revision, row.supersedes, row.authority, row.created_at, row.rationale);
  }

  decisions(repoId: string): DecisionRow[] {
    return this.db.prepare("SELECT * FROM decisions WHERE repo_id = ? ORDER BY created_at").all(repoId) as unknown as DecisionRow[];
  }

  decision(id: string): DecisionRow | null {
    return (this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as DecisionRow | undefined) ?? null;
  }

  // ---- runs ---------------------------------------------------------------

  insertRun(row: RunRow): void {
    this.db
      .prepare(
        `INSERT INTO runs(id, repo_id, base_sha, worktree_path, state, contract_json, contract_hash, codex_thread_id, started_at, updated_at, result_json, task_json, mode, run_dir)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.repo_id, row.base_sha, row.worktree_path, row.state, row.contract_json, row.contract_hash, row.codex_thread_id, row.started_at, row.updated_at, row.result_json, row.task_json, row.mode, row.run_dir);
  }

  updateRun(id: string, patch: Partial<Omit<RunRow, "id">>): void {
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    this.db.prepare(`UPDATE runs SET ${sets} WHERE id = ?`).run(...keys.map((k) => patch[k] as string | null), id);
  }

  getRun(id: string): RunRow | null {
    return (this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined) ?? null;
  }

  listRuns(repoId?: string): RunRow[] {
    if (repoId) return this.db.prepare("SELECT * FROM runs WHERE repo_id = ? ORDER BY started_at DESC").all(repoId) as unknown as RunRow[];
    return this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC").all() as unknown as RunRow[];
  }

  appendEvent(runId: string, eventType: string, payload: unknown, timestamp = new Date().toISOString()): void {
    this.db
      .prepare("INSERT INTO run_events(run_id, timestamp, event_type, payload_json) VALUES (?, ?, ?, ?)")
      .run(runId, timestamp, eventType, JSON.stringify(payload ?? {}));
  }

  events(runId: string): RunEventRow[] {
    return this.db.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY id").all(runId) as unknown as RunEventRow[];
  }
}
