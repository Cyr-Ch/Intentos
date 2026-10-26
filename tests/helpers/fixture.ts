import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { KnowledgeStore } from "../../src/knowledge/storage.ts";
import { indexRepository } from "../../src/knowledge/indexer.ts";
import { loadIndexedRepo, type IndexedRepo } from "../../src/knowledge/repo.ts";
import { PROJECT_ROOT, resolvePython } from "../../src/config.ts";

export interface TestEnv {
  home: string;
  repo: string;
  store: KnowledgeStore;
  indexed: IndexedRepo;
  cleanup: () => void;
}

/**
 * Builds the startup_billing fixture into an isolated temp INTENTOS_HOME and indexes it.
 * Each test file gets its own SQLite DB, runs dir and worktrees so tests never share state.
 */
export function setupFixtureEnv(): TestEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "intentos-test-"));
  process.env.INTENTOS_HOME = home;
  const repo = path.join(home, "fixtures", "startup_billing");
  const res = spawnSync(resolvePython(), [path.join(PROJECT_ROOT, "python", "build_fixture.py"), path.join(PROJECT_ROOT, "fixtures", "startup_billing"), repo, "--force"], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`fixture build failed: ${res.stderr}\n${res.stdout}`);
  const store = new KnowledgeStore(path.join(home, "intentos.db"));
  indexRepository(store, repo);
  const indexed = loadIndexedRepo(store, repo);
  return {
    home,
    repo,
    store,
    indexed,
    cleanup: () => {
      store.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

export function gitHead(repo: string): string {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
}

export function gitStatus(repo: string): string {
  return spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout.trim();
}

export const PATCHES = {
  good: path.join(PROJECT_ROOT, "benchmarks", "offline_patches", "task-a.good.patch"),
  bad: path.join(PROJECT_ROOT, "benchmarks", "offline_patches", "task-a.bad.patch"),
  protectedDoc: path.join(PROJECT_ROOT, "benchmarks", "offline_patches", "fixtures", "protected-doc.patch"),
  legacyAdapter: path.join(PROJECT_ROOT, "benchmarks", "offline_patches", "fixtures", "legacy-adapter.patch"),
  weakenTests: path.join(PROJECT_ROOT, "benchmarks", "offline_patches", "fixtures", "weaken-tests.patch"),
  forgeJunit: path.join(PROJECT_ROOT, "benchmarks", "offline_patches", "fixtures", "forge-junit.patch"),
};

export const TASK_A = "Add a 15% promotional discount for eligible enterprise subscriptions";
