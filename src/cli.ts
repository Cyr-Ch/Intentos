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
import { onboardRepository } from "./onboard.ts";
import { recordReviewFeedback, suggestPolicy, type SuggestResult } from "./suggest.ts";
import { repoIdFor } from "./knowledge/indexer.ts";

function printSuggestions(result: SuggestResult): void {
  console.log(`Suggestions for ${result.repo_path} (policy ${result.policy_id}, ${result.head.slice(0, 7)})`);
  console.log(`  candidates:   ${result.candidates.length} (${Object.entries(result.counts).map(([k, v]) => `${k} ${v}`).join(", ")}), ordered by business-relevance score`);
  for (const c of result.candidates) {
    const verdict = c.classification ? ` ${c.classification.keep ? "KEEP" : "drop"} ${c.classification.category}` : "";
    console.log(`    ${c.id}  ${c.score.toFixed(2)} ${c.relevance.padEnd(6)} ${c.kind.padEnd(17)} ${c.title.slice(0, 60).padEnd(60)}${c.cluster_size > 1 ? ` [${c.cluster}]` : ""}${verdict}`);
  }
  if (result.classification.used) console.log(`  classified:   ${result.classification.classified} by ${result.classification.model ?? "codex"}: kept ${result.classification.kept}, set aside ${result.classification.filtered}${result.classification.rewrites_rejected ? `, ${result.classification.rewrites_rejected} rewrite(s) rejected` : ""}${result.classification.note ? ` (${result.classification.note})` : ""}`);
  console.log(`  review:       ${result.files.markdown}`);
  console.log(`  paste-ready:  ${result.files.yaml}`);
  if (result.adr_dir) console.log(`  ADR drafts:   ${result.adrs.length} in ${result.adr_dir} (Status: Proposed)`);
  if (result.codex.used) console.log(`  codex:        ${result.codex.model ?? "codex"}; ${result.adrs.filter((a) => a.synthesized_by === "codex").length} ADR(s) synthesised${result.codex.dropped ? `, ${result.codex.dropped} dropped for citing unknown evidence` : ""}`);
  for (const w of result.warnings) console.log(`  warning:      ${w}`);
  console.log("  next:");
  for (const n of result.next_steps) console.log(`    - ${n}`);
}

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
  .option("--full", "re-extract every file instead of the diff-based incremental path", false)
  .action((repo: string, opts: { full: boolean }) => {
    const store = openStore();
    try {
      const summary = indexRepository(store, repo, { full: opts.full });
      if (program.opts().json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        const mode =
          summary.mode === "incremental"
            ? `incremental (${summary.changed_files.length} changed, ${summary.deleted_files.length} deleted, ${summary.carried_files.length} carried from ${summary.previous_revision?.slice(0, 7)})`
            : `full (${summary.changed_files.length} files extracted)`;
        console.log(`Indexed ${summary.repo_path}`);
        console.log(`  repo_id:   ${summary.repo_id}`);
        console.log(`  revision:  ${summary.head_sha}${summary.branch ? ` (${summary.branch})` : ""}${summary.dirty ? "  [working tree dirty: index reflects HEAD]" : ""}`);
        console.log(`  mode:      ${mode}`);
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

program
  .command("onboard")
  .description("Bring a repository under IntentOS: probe it, create a per-repo venv with its dependencies, write a DRAFT policy, run its suite once, index it")
  .argument("<repo>", "path to the repository root (a Git checkout)")
  .option("--policy-id <id>", "policy id (default: sanitised project name, else folder name)")
  .option("--out <file>", "where to write the draft policy (default policies/<policy-id>.yaml)")
  .option("--python <interpreter>", "interpreter used to create the venv, or used directly with --no-install")
  .option("--no-install", "do not create a venv or install dependencies")
  .option("--no-test", "do not run the project suite at the base revision")
  .option("--no-index", "do not index the repository")
  .option("--force", "overwrite an existing policy file", false)
  .option("--suggest", "also mine the repository for policy candidates (see `intentos suggest`)", false)
  .action(async (repo: string, opts: { policyId?: string; out?: string; python?: string; install: boolean; test: boolean; index: boolean; force: boolean; suggest: boolean }) => {
    const store = openStore();
    const json = program.opts().json as boolean;
    try {
      const result = onboardRepository(store, repo, { policyId: opts.policyId, out: opts.out, python: opts.python, install: opts.install, test: opts.test, index: opts.index, force: opts.force }, (line) => {
        if (!json) console.error(`[onboard] ${line}`);
      });
      const suggestions = opts.suggest ? await suggestPolicy(repo, { policyId: result.policy_id, writeAdrs: false, withCodex: false }, (line) => { if (!json) console.error(`[suggest] ${line}`); }) : null;
      if (json) {
        console.log(JSON.stringify({ ...result, suggestions }, null, 2));
        return;
      }
      console.log(`Onboarded ${result.repo_path}`);
      console.log(`  repo_id:      ${result.repo_id}`);
      console.log(`  layout:       ${result.probe.layout} (packages: ${result.probe.packages.join(", ") || "none"}; tests: ${result.probe.test_paths.join(", ") || "none found"})`);
      console.log(`  interpreter:  ${result.interpreter}${result.venv ? `  (venv ${result.venv}; ${result.installed?.length ?? 0} package(s) installed)` : ""}`);
      console.log(`  policy:       ${result.policy_file} (DRAFT, id ${result.policy_id})`);
      console.log(`  suite:        ${result.smoke.status}${result.smoke.tests_passed !== null ? ` (${result.smoke.tests_passed} passed, ${result.smoke.tests_failed} failed)` : ""} — ${result.smoke.summary}`);
      if (result.index) console.log(`  index:        ${result.index.mode}, policy ${result.index.policy_id}, ${Object.entries(result.index.counts).filter(([k]) => k.startsWith("nodes.")).map(([k, v]) => `${k.slice(6)}=${v}`).join(", ")}`);
      for (const w of result.warnings) console.log(`  warning:      ${w}`);
      console.log("  next:");
      for (const n of result.next_steps) console.log(`    - ${n}`);
      if (suggestions) {
        console.log("");
        printSuggestions(suggestions);
      }
    } catch (err) {
      fail((err as Error).message);
    } finally {
      store.close();
    }
  });

program
  .command("suggest")
  .description("Mine a repository for policy candidates (commits, rule-like tests, must/never sentences, ADRs, layer imports, frozen dirs, changelog) and write review files; nothing is approved")
  .argument("<repo>", "path to the repository root (a Git checkout)")
  .option("--policy-id <id>", "policy id used in the drafts (default: sanitised project name, else folder name)")
  .option("--out <dir>", "directory for suggestions.json / policy-suggestions.md / policy-suggestions.yaml (default .intentos/onboard/<repo-id>)")
  .option("--write-adrs", "write ADR drafts (Status: Proposed) into the repository", false)
  .option("--adr-dir <dir>", "where ADR drafts go (default <repo>/docs/decisions)")
  .option("--with-codex", "let Codex turn the mined evidence into ADR prose in a read-only thread (spends tokens; model text is validated against the evidence)", false)
  .option("--max-commits <n>", "how many commits to scan", "500")
  .option("--min-confidence <level>", "drop candidates below high|medium|low (evidence confidence)", "low")
  .option("--min-score <0..1>", "drop candidates whose business-relevance score is below this", "0")
  .option("--classify", "let Codex sort the top candidates (keep/drop, category, rule rewrite, cluster) in a read-only thread; verdicts are validated against the evidence", false)
  .option("--classify-top <n>", "how many top-ranked candidates to classify", "40")
  .option("--feedback <file>", "accept/reject token weights from earlier reviews (default <out>/feedback.json)")
  .option("--record", "do not mine: compare the last suggestions with the policy file and write feedback.json for the next run", false)
  .action(async (repo: string, opts: { policyId?: string; out?: string; writeAdrs: boolean; adrDir?: string; withCodex: boolean; maxCommits: string; minConfidence: string; minScore: string; classify: boolean; classifyTop: string; feedback?: string; record: boolean }) => {
    const json = program.opts().json as boolean;
    try {
      if (opts.record) {
        const paths = ensureHome(resolvePaths());
        const outDir = path.resolve(opts.out ?? path.join(paths.home, "onboard", repoIdFor(path.resolve(repo))));
        const suggestionsFile = path.join(outDir, "suggestions.json");
        const previous = fs.existsSync(suggestionsFile) ? (JSON.parse(fs.readFileSync(suggestionsFile, "utf8")) as { policy_id: string }) : null;
        const policyId = opts.policyId ?? previous?.policy_id;
        if (!policyId) fail(`no previous suggestions in ${outDir}; run intentos suggest first or pass --policy-id`);
        const fb = recordReviewFeedback(suggestionsFile, path.join(paths.policies, `${policyId}.yaml`), opts.feedback ?? path.join(outDir, "feedback.json"));
        if (json) console.log(JSON.stringify(fb, null, 2));
        else {
          console.log(`Recorded review feedback for ${policyId}: accepted ${fb.accepted_ids.length} (${fb.accepted_ids.join(", ") || "none"}), rejected ${fb.rejected_ids.length}`);
          console.log(`  accept terms: ${fb.accept_tokens.slice(0, 12).join(", ")}${fb.accept_tokens.length > 12 ? ", …" : ""}`);
          console.log(`  reject terms: ${fb.reject_tokens.slice(0, 12).join(", ")}${fb.reject_tokens.length > 12 ? ", …" : ""}`);
          console.log(`  -> ${opts.feedback ?? path.join(outDir, "feedback.json")} (used automatically by the next intentos suggest)`);
        }
        return;
      }
      const level = opts.minConfidence as "high" | "medium" | "low";
      if (!["high", "medium", "low"].includes(level)) fail(`--min-confidence must be high, medium or low (got ${opts.minConfidence})`);
      const minScore = Number(opts.minScore);
      if (!(minScore >= 0 && minScore <= 1)) fail(`--min-score must be between 0 and 1 (got ${opts.minScore})`);
      const result = await suggestPolicy(repo, { policyId: opts.policyId, outDir: opts.out, writeAdrs: opts.writeAdrs, adrDir: opts.adrDir, withCodex: opts.withCodex, maxCommits: Number(opts.maxCommits), minConfidence: level, minScore, classify: opts.classify, classifyTop: Number(opts.classifyTop), feedbackFile: opts.feedback }, (line) => {
        if (!json) console.error(`[suggest] ${line}`);
      });
      if (json) console.log(JSON.stringify(result, null, 2));
      else printSuggestions(result);
    } catch (err) {
      fail((err as Error).message);
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
