import fs from "node:fs";
import path from "node:path";
import type { Policy } from "./policy.ts";

/**
 * TypeScript/JavaScript repositories: which test runner they use, how to invoke it for one file or one test, and how
 * to make the repository's `node_modules` visible to a snapshot or worktree that was copied without it.
 *
 * vitest is first-class (JUnit reporter built in). jest works when `jest-junit` is installed in the repository.
 */

export type JsRunnerKind = "vitest" | "jest";

export interface JsRunner {
  kind: JsRunnerKind;
  /** The runner's entry script inside the repository's node_modules. */
  script: string;
  nodeModules: string;
}

/** The runner installed in `<repo>/node_modules`, or null when neither vitest nor jest is there. */
export function jsRunner(repoPath: string, prefer?: JsRunnerKind | null): JsRunner | null {
  const nodeModules = path.join(repoPath, "node_modules");
  const vitest = path.join(nodeModules, "vitest", "vitest.mjs");
  const jest = path.join(nodeModules, "jest", "bin", "jest.js");
  const order: JsRunnerKind[] = prefer === "jest" ? ["jest", "vitest"] : ["vitest", "jest"];
  for (const kind of order) {
    const script = kind === "vitest" ? vitest : jest;
    if (fs.existsSync(script)) return { kind, script, nodeModules };
  }
  return null;
}

/** Escape a test title for the runner's `-t` regex filter. */
export const titleRegex = (title: string): string => `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;

export interface JsTestInvocation {
  argv: string[];
  env: Record<string, string>;
}

/**
 * Run one test file or directory (optionally one test title) under the repository root with a JUnit report. For
 * vitest the file is collected through a wrapper config (`vitest.config.mjs`, written to `configDir`, by default
 * `<root>/.intentos_hidden/`, which must be under the root so that `vitest/config` resolves from the project's
 * node_modules; callers remove it afterwards and Git helpers ignore the directory) which extends the project's config
 * with an `include` glob that matches any `*.test.*`/`*.spec.*` file, so a test placed outside the project's own
 * `include` globs (hidden tests, proposed tests) still runs with the project's plugins and aliases.
 */
export function jsTestInvocation(runner: JsRunner, a: { root: string; file: string; title?: string; junit: string; configDir?: string }): JsTestInvocation {
  const node = process.execPath;
  if (runner.kind === "vitest") {
    const config = writeVitestWrapperConfig(a.root, a.configDir ?? path.join(a.root, ".intentos_hidden"));
    const argv = [node, runner.script, "run", "--root", a.root, "--dir", path.dirname(a.file), "--reporter=junit", `--outputFile=${a.junit}`, "--passWithNoTests", "--config", config, a.file];
    if (a.title) argv.push("-t", titleRegex(a.title));
    return { argv, env: {} };
  }
  const argv = [node, runner.script, "--rootDir", a.root, "--ci", "--reporters=default", "--reporters=jest-junit", "--testPathPattern", a.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")];
  if (a.title) argv.push("-t", titleRegex(a.title));
  return { argv, env: { JEST_JUNIT_OUTPUT_FILE: a.junit } };
}

/**
 * Write `<dir>/vitest.config.mjs`: the project's vitest/vite config (when it has one) merged with an `include` that
 * collects every test file, so hidden and proposed tests outside the project's globs are run with the project's setup.
 */
export function writeVitestWrapperConfig(root: string, dir: string): string {
  const project = vitestConfigFor(root);
  const file = path.join(dir, "vitest.config.mjs");
  const L = ['import { defineConfig, mergeConfig } from "vitest/config";'];
  if (project) {
    L.push(`import base from ${JSON.stringify(project)};`);
    L.push('const resolved = typeof base === "function" ? await base({ mode: "test", command: "serve" }) : base;');
  } else L.push("const resolved = {};");
  L.push('export default mergeConfig(resolved ?? {}, defineConfig({ test: { include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"], exclude: ["**/node_modules/**"], allowOnly: true } }));');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, L.join("\n") + "\n");
  return file;
}

/** The project's vitest config file when it has one (vitest otherwise looks for it under --root). */
export function vitestConfigFor(root: string): string | null {
  for (const name of ["vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs", "vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"]) {
    const f = path.join(root, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** Symlink `<repo>/node_modules` into a copy of the repository that was made without it (snapshots, worktrees). */
export function linkNodeModules(repoPath: string, target: string): boolean {
  const source = path.join(repoPath, "node_modules");
  const link = path.join(target, "node_modules");
  if (!fs.existsSync(source) || fs.existsSync(link)) return false;
  try {
    fs.symlinkSync(source, link, "dir");
    return true;
  } catch {
    return false;
  }
}

/** True when the policy is for a TypeScript/JavaScript repository. */
export const isTsPolicy = (policy: Pick<Policy, "language">): boolean => policy.language === "typescript";

/** Test files a vitest/jest repository collects: `*.test.*` / `*.spec.*` and files under __tests__. */
export const isJsTestFile = (p: string): boolean => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)__tests__\//.test(p);

/** Source files the TypeScript indexer and rules read. */
export const isJsSourceFile = (p: string): boolean => /\.[cm]?[jt]sx?$/.test(p) && !p.endsWith(".d.ts");
