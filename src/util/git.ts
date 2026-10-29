import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export class GitError extends Error {
  readonly args: string[];
  readonly stderr: string;
  constructor(message: string, args: string[], stderr: string) {
    super(message);
    this.args = args;
    this.stderr = stderr;
  }
}

export function git(cwd: string, args: string[], opts: { allowFail?: boolean; input?: string } = {}): { stdout: string; stderr: string; status: number } {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", input: opts.input, maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new GitError(`git ${args.join(" ")} failed to start: ${res.error.message}`, args, "");
  if (res.status !== 0 && !opts.allowFail) {
    throw new GitError(`git ${args.join(" ")} exited ${res.status}: ${res.stderr.trim()}`, args, res.stderr);
  }
  return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? -1 };
}

export function isGitRepo(dir: string): boolean {
  const res = git(dir, ["rev-parse", "--is-inside-work-tree"], { allowFail: true });
  return res.status === 0 && res.stdout.trim() === "true";
}

export function repoToplevel(dir: string): string {
  return git(dir, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function headSha(dir: string): string {
  return git(dir, ["rev-parse", "HEAD"]).stdout.trim();
}

export function currentBranch(dir: string): string | null {
  const res = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true });
  return res.status === 0 ? res.stdout.trim() : null;
}

/**
 * Paths IntentOS never treats as part of the working tree: `node_modules`, which it links into worktrees and
 * snapshots of TypeScript repositories (a symlink that `node_modules/` in .gitignore does not cover), and the
 * hidden-test staging directory.
 */
export const isToolingPath = (rel: string): boolean => rel === "node_modules" || rel.startsWith("node_modules/") || rel === ".intentos_hidden" || rel.startsWith(".intentos_hidden/");

export function isDirty(dir: string): boolean {
  return git(dir, ["status", "--porcelain", "-z"]).stdout.split("\0").filter(Boolean).some((line) => !isToolingPath(line.slice(3)));
}

export function trackedFiles(dir: string): string[] {
  return git(dir, ["ls-files", "-z"]).stdout.split("\0").filter(Boolean);
}

/** Tracked + untracked (non-ignored) files, i.e. what a snapshot of the working tree should include. */
export function workingTreeFiles(dir: string): string[] {
  const out = git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).stdout.split("\0").filter(Boolean);
  // ls-files may list deleted-but-tracked files; keep only existing ones.
  return [...new Set(out)].filter((f) => !isToolingPath(f) && fs.existsSync(path.join(dir, f)));
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
}

/** Changes in the working tree relative to `baseSha` (staged, unstaged and untracked). */
export function changedFiles(dir: string, baseSha: string): ChangedFile[] {
  const result = new Map<string, ChangedFile>();
  const diff = git(dir, ["diff", "--name-status", "-z", baseSha, "--"]).stdout.split("\0").filter(Boolean);
  for (let i = 0; i < diff.length; i++) {
    const code = diff[i]!;
    if (code.startsWith("R") || code.startsWith("C")) {
      const from = diff[i + 1]!;
      const to = diff[i + 2]!;
      i += 2;
      result.set(from, { path: from, status: "deleted" });
      result.set(to, { path: to, status: "renamed" });
      continue;
    }
    const p = diff[i + 1]!;
    i += 1;
    const status: ChangedFile["status"] = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
    result.set(p, { path: p, status });
  }
  const untracked = git(dir, ["ls-files", "-z", "--others", "--exclude-standard"]).stdout.split("\0").filter(Boolean);
  for (const p of untracked) if (!result.has(p)) result.set(p, { path: p, status: "untracked" });
  return [...result.values()].filter((c) => !isToolingPath(c.path)).sort((a, b) => a.path.localeCompare(b.path));
}

/** Unified diff of the working tree vs base, including untracked files. */
export function diffAgainstBase(dir: string, baseSha: string): string {
  // Stage untracked files in the index temporarily (intent-to-add) so they appear in the diff.
  const untracked = git(dir, ["ls-files", "-z", "--others", "--exclude-standard"]).stdout.split("\0").filter(Boolean).filter((p) => !isToolingPath(p));
  if (untracked.length) git(dir, ["add", "-N", "--", ...untracked]);
  const diff = git(dir, ["diff", "--no-color", baseSha, "--"]).stdout;
  if (untracked.length) git(dir, ["reset", "-q", "--", ...untracked], { allowFail: true });
  return diff;
}

export function addWorktree(repo: string, worktreePath: string, baseSha: string): void {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(repo, ["worktree", "add", "--detach", worktreePath, baseSha]);
}

export function removeWorktree(repo: string, worktreePath: string): void {
  git(repo, ["worktree", "remove", "--force", worktreePath], { allowFail: true });
  git(repo, ["worktree", "prune"], { allowFail: true });
}

export function applyPatch(dir: string, patchFile: string): { ok: boolean; stderr: string } {
  const res = git(dir, ["apply", "--whitespace=nowarn", patchFile], { allowFail: true });
  return { ok: res.status === 0, stderr: res.stderr };
}

/** Tracked `.py` files at a revision (paths relative to the repository root). */
export function trackedPythonFiles(dir: string, rev: string): string[] {
  return git(dir, ["ls-tree", "-r", "-z", "--name-only", rev]).stdout.split("\0").filter((p) => p.endsWith(".py"));
}

/**
 * Contents of `paths` at `rev` through a single `git cat-file --batch` process. Missing paths are omitted.
 * Sizes in the batch protocol are bytes, so the stream is parsed as a Buffer and decoded per object.
 */
export function readFilesAtRevision(dir: string, rev: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!paths.length) return out;
  const unique = [...new Set(paths)];
  const res = spawnSync("git", ["cat-file", "--batch"], { cwd: dir, input: unique.map((p) => `${rev}:${p}\n`).join(""), maxBuffer: 256 * 1024 * 1024 });
  if (res.error) throw new GitError(`git cat-file --batch failed to start: ${res.error.message}`, ["cat-file", "--batch"], "");
  if (res.status !== 0) throw new GitError(`git cat-file --batch exited ${res.status}: ${res.stderr.toString("utf8").trim()}`, ["cat-file", "--batch"], res.stderr.toString("utf8"));
  const buf: Buffer = res.stdout;
  let pos = 0;
  for (const p of unique) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString("utf8");
    pos = nl + 1;
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) continue;
    const parts = header.split(" ");
    const size = Number(parts[2]);
    if (!Number.isFinite(size)) throw new GitError(`unexpected cat-file header: ${header}`, ["cat-file", "--batch"], "");
    out.set(p, buf.subarray(pos, pos + size).toString("utf8"));
    pos += size + 1; // trailing newline after each object
  }
  return out;
}

export interface CommitInfo {
  sha: string;
  date: string;
  subject: string;
}

export function logForPaths(dir: string, paths: string[], limit = 10): CommitInfo[] {
  const args = ["log", `--max-count=${limit}`, "--date=iso-strict", "--format=%H%x1f%ad%x1f%s", "--"];
  const res = git(dir, [...args, ...paths], { allowFail: true });
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, date, subject] = line.split("\x1f");
      return { sha: sha ?? "", date: date ?? "", subject: subject ?? "" };
    });
}
