import { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { PROJECT_ROOT, ensureHome, resolvePaths, resolvePython } from "./config.ts";
import { KnowledgeStore } from "./knowledge/storage.ts";
import { indexRepository } from "./knowledge/indexer.ts";
import { loadIndexedRepo } from "./knowledge/repo.ts";
import { buildEvidencePack } from "./knowledge/retrieval.ts";
import { renderEvidencePack } from "./reports/explain.ts";
import { registerRunCommands } from "./cli_run.ts";

const program = new Command();
program
  .name("intentos")
  .description("IntentOS — engineering-intent intelligence and verification layer for Codex coding agents")
  .version("0.1.0")
  .option("--json", "machine-readable JSON output", false);

function openStore(): KnowledgeStore {
  const paths = ensureHome(resolvePaths());
  return new KnowledgeStore(paths.db);
}

function fail(message: string, code = 1): never {
  console.error(`error: ${message}`);
  process.exit(code);
}

export function requireTask(task: string): string {
  const t = task.trim();
  if (t.length < 8) throw new Error("task description is empty or too short; describe the requested change in a sentence");
  return t;
}

program
  .command("index")
  .description("Index a Git repository at HEAD: symbols, imports, tests, docs, trusted policy bindings -> .intentos/intentos.db")
  .argument("<repo>", "path to the repository root")
  .action((repo: string) => {
    const store = openStore();
    try {
      const summary = indexRepository(store, repo);
      if (program.opts().json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(`Indexed ${summary.repo_path}`);
        console.log(`  repo_id:   ${summary.repo_id}`);
        console.log(`  revision:  ${summary.head_sha}${summary.branch ? ` (${summary.branch})` : ""}${summary.dirty ? "  [working tree dirty: index reflects HEAD]" : ""}`);
        console.log(`  policy:    ${summary.policy_id}`);
        console.log(`  counts:    ${Object.entries(summary.counts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
        if (summary.skipped.length) console.log(`  skipped:   ${summary.skipped.map((s) => `${s.path} (${s.reason})`).join("; ")}`);
        if (summary.unresolved_sources.length) {
          console.log("  unresolved policy sources (flagged conflicted):");
          for (const u of summary.unresolved_sources) console.log(`    - ${u.owner}: ${u.path}${u.heading ? `#${u.heading}` : ""} — ${u.reason}`);
        }
        for (const l of summary.limitations) console.log(`  note: ${l}`);
      }
    } catch (err) {
      fail((err as Error).message);
    } finally {
      store.close();
    }
  });

program
  .command("explain")
  .description("Retrieve task-relevant symbols, tests, docs, invariants, decisions and probable impact with source locations")
  .argument("<repo>", "indexed repository root")
  .argument("<task>", "task description")
  .option("--out <file>", "also write the evidence pack JSON to a file")
  .action((repo: string, task: string, opts: { out?: string }) => {
    const store = openStore();
    try {
      const indexed = loadIndexedRepo(store, repo);
      const pack = buildEvidencePack(store, indexed, requireTask(task));
      if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(pack, null, 2));
      if (program.opts().json) console.log(JSON.stringify(pack, null, 2));
      else console.log(renderEvidencePack(pack));
    } catch (err) {
      fail((err as Error).message);
    } finally {
      store.close();
    }
  });

const fixture = program.command("fixture").description("Manage the demonstration fixture repository");
fixture
  .command("build")
  .description("Materialize fixtures/startup_billing as a Git repo with history under .intentos/fixtures/startup_billing")
  .option("--dest <dir>", "destination directory")
  .option("--force", "replace an existing destination", false)
  .action((opts: { dest?: string; force: boolean }) => {
    const paths = ensureHome(resolvePaths());
    const dest = path.resolve(opts.dest ?? path.join(paths.fixtures, "startup_billing"));
    const src = path.join(PROJECT_ROOT, "fixtures", "startup_billing");
    const args = [path.join(paths.python, "build_fixture.py"), src, dest];
    if (opts.force || !fs.existsSync(dest)) args.push("--force");
    const res = spawnSync(resolvePython(paths), args, { stdio: "inherit" });
    if (res.status !== 0) fail(`fixture build failed (exit ${res.status})`);
    console.log(`fixture ready at ${dest}`);
  });

const setup = program.command("setup").description("Environment setup helpers");
setup
  .command("python")
  .description("Create .intentos/venv with pytest for the indexer and verifier")
  .action(() => {
    const paths = ensureHome(resolvePaths());
    const py = path.join(paths.venv, "bin", "python");
    if (!fs.existsSync(py)) {
      const r = spawnSync("python3", ["-m", "venv", paths.venv], { stdio: "inherit" });
      if (r.status !== 0) fail("python3 -m venv failed");
    }
    const r2 = spawnSync(py, ["-m", "pip", "install", "-q", "pytest"], { stdio: "inherit" });
    if (r2.status !== 0) fail("pip install pytest failed");
    console.log(`python ready: ${py}`);
  });

registerRunCommands(program, { openStore, fail });

program.parseAsync(process.argv).catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
