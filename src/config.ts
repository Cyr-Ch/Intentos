import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { fileExists } from "./util/paths.ts";

/** Root of the IntentOS project checkout (contains package.json). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface IntentosPaths {
  home: string;
  db: string;
  runs: string;
  worktrees: string;
  fixtures: string;
  venv: string;
  policies: string;
  hiddenTests: string;
  python: string;
  benchmarks: string;
  /** Raw extraction cache per repository and revision (enables diff-based incremental re-indexing). */
  indexCache: string;
}

export function resolvePaths(home = process.env.INTENTOS_HOME ?? path.join(PROJECT_ROOT, ".intentos")): IntentosPaths {
  return {
    home,
    db: path.join(home, "intentos.db"),
    runs: path.join(home, "runs"),
    worktrees: path.join(home, "worktrees"),
    fixtures: path.join(home, "fixtures"),
    venv: path.join(home, "venv"),
    policies: path.join(PROJECT_ROOT, "policies"),
    hiddenTests: path.join(PROJECT_ROOT, "benchmarks", "hidden_tests"),
    python: path.join(PROJECT_ROOT, "python"),
    benchmarks: path.join(home, "benchmarks"),
    indexCache: path.join(home, "index-cache"),
  };
}

/** Python interpreter used for the indexer and verifier commands. */
export function resolvePython(paths: IntentosPaths = resolvePaths()): string {
  if (process.env.INTENTOS_PYTHON) return process.env.INTENTOS_PYTHON;
  // The venv is an environment concern, not run state: fall back to the project-default venv
  // even when INTENTOS_HOME points elsewhere (e.g. isolated test homes).
  for (const candidate of [path.join(paths.venv, "bin", "python"), path.join(PROJECT_ROOT, ".intentos", "venv", "bin", "python")]) {
    if (fileExists(candidate)) return candidate;
  }
  return "python3";
}

export interface CodexSettings {
  model: string | null;
  reasoningEffort: string | null;
  codexPathOverride: string | null;
  /** Per-Codex-turn timeout in milliseconds. */
  turnTimeoutMs: number;
}

export function codexSettings(): CodexSettings {
  return {
    model: process.env.INTENTOS_CODEX_MODEL ?? null,
    reasoningEffort: process.env.INTENTOS_CODEX_REASONING ?? null,
    codexPathOverride: process.env.INTENTOS_CODEX_PATH ?? null,
    turnTimeoutMs: Number(process.env.INTENTOS_CODEX_TIMEOUT_MS ?? 20 * 60 * 1000),
  };
}

export function ensureHome(paths: IntentosPaths = resolvePaths()): IntentosPaths {
  for (const dir of [paths.home, paths.runs, paths.worktrees, paths.fixtures, paths.indexCache]) fs.mkdirSync(dir, { recursive: true });
  return paths;
}
