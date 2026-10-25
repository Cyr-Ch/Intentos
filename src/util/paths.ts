import path from "node:path";
import fs from "node:fs";

/** Globally protected paths inside any target repository or worktree. */
export const GLOBAL_PROTECTED_PATTERNS = [".intentos/**", "benchmarks/**", "policies/**", ".git/**", ".intentos_hidden/**"];

/**
 * Convert a glob (supporting `**`, `*`, `?`) into a RegExp. Matching is done on
 * forward-slash relative paths.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories; trailing `**` matches anything.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(relPath: string, patterns: string[]): boolean {
  const normalized = normalizeRel(relPath);
  return patterns.some((p) => globToRegExp(normalizeRel(p)).test(normalized));
}

export function normalizeRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Rejects absolute paths, traversal segments, and empty paths. */
export function isSafeRelativePattern(p: string): boolean {
  if (!p || p.trim() !== p) return false;
  const n = normalizeRel(p);
  if (path.isAbsolute(n) || n.startsWith("/") || /^[a-zA-Z]:/.test(n)) return false;
  if (n.split("/").some((seg) => seg === ".." || seg === "")) return false;
  if (n.includes("\0")) return false;
  return true;
}

/** True when `candidate` (after symlink resolution) lives inside `root`. */
export function isInsideRealpath(root: string, candidate: string): boolean {
  const realRoot = fs.realpathSync(root);
  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync(candidate);
  } catch {
    // Non-existent path: resolve its parent chain lexically against the real root.
    realCandidate = path.resolve(realRoot, candidate);
  }
  const rel = path.relative(realRoot, realCandidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function fileExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
