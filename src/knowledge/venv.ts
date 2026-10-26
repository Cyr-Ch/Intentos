import fs from "node:fs";
import path from "node:path";
import { resolvePaths, resolvePython, type IntentosPaths } from "../config.ts";
import { repoIdFor } from "./indexer.ts";

/** Per-repository virtual environment created by `intentos onboard` (dependencies + pytest, never the package itself). */
export function repoVenvDir(repoPath: string, paths: IntentosPaths = resolvePaths()): string {
  return path.join(paths.venvs, repoIdFor(repoPath));
}

/**
 * Interpreter for commands that execute a repository's tests: `INTENTOS_PYTHON` wins, then the repository's own
 * onboarded venv when it exists, then the project default (`.intentos/venv`, else `python3`).
 */
export function repoInterpreter(repoPath: string | null | undefined, paths: IntentosPaths = resolvePaths()): string {
  if (process.env.INTENTOS_PYTHON) return process.env.INTENTOS_PYTHON;
  if (repoPath && fs.existsSync(repoPath)) {
    const py = path.join(repoVenvDir(repoPath, paths), "bin", "python");
    if (fs.existsSync(py)) return py;
  }
  return resolvePython(paths);
}
