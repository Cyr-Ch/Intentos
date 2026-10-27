export type FindingSeverity = "blocking" | "review" | "info";
export type FindingCategory = "functional" | "business_invariant" | "architecture" | "scope" | "counterexample" | "process" | "coordination";

/** What mergeguard said about this tree against the repository's main (present when coordination is on). */
export interface CoordinationSummary {
  main_branch: string;
  /** main's revision the check ran against. */
  main: string;
  /** Merge base of the run's base revision and main; equals `main` when the tree is up to date. */
  base: string;
  stale: boolean;
  issues: Array<{ id: string; symbol: string; change: string; new: string | null; commit: string; used_in: string[]; message: string }>;
  /** Review tier mergeguard's router assigns to the diff (0 none, 1 one human, 2 two), with its reasons and proofs. */
  tier: number | null;
  reasons: string[];
  proofs: Record<string, string>;
  error: string | null;
}

export interface Finding {
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  rule_id: string | null;
  source_evidence_ids: string[];
  test: string | null;
  expected: string | null;
  observed: string | null;
  message: string;
  location: string | null;
  log_path: string | null;
  /** Findings from exploratory (model- or template-derived) probes are labelled so they are never mistaken for authority. */
  authority: "trusted_policy" | "hidden_test" | "project_test" | "exploratory" | "deterministic";
}

export interface CommandRecord {
  command_id: string;
  track: string;
  enforcement: "blocking" | "advisory";
  argv: string[] | null;
  builtin: string | null;
  exit_code: number | null;
  duration_ms: number;
  status: "passed" | "failed" | "error" | "skipped" | "timeout";
  stdout_path: string | null;
  stderr_path: string | null;
  summary: string;
  tests_passed: number | null;
  tests_failed: number | null;
}

export interface VerificationResult {
  status: "passed" | "failed" | "needs_review";
  run_id: string;
  attempt: number;
  snapshot_path: string;
  base_sha: string;
  contract_hash: string;
  started_at: string;
  finished_at: string;
  commands: CommandRecord[];
  findings: Finding[];
  tracks: Record<string, { status: "passed" | "failed" | "not_run" | "advisory"; blocking_findings: number; review_findings: number }>;
  changed_files: Array<{ path: string; status: string; in_scope: boolean; protected: boolean }>;
  unverified_areas: string[];
  limitations: string[];
  simulated: boolean;
  /** Where executing commands ran: on the host, or in the isolated container (image + digest recorded). */
  verifier: { mode: "host" | "docker"; image: string | null; image_digest: string | null };
  coordination?: CoordinationSummary | null;
}

export function summarizeStatus(findings: Finding[]): VerificationResult["status"] {
  if (findings.some((f) => f.severity === "blocking")) return "failed";
  if (findings.some((f) => f.severity === "review")) return "needs_review";
  return "passed";
}
