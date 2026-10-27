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
import { registerMergeCommands } from "./cli_merge.ts";
import { onboardRepository } from "./onboard.ts";
import { recordReviewFeedback, suggestPolicy, type SuggestResult } from "./suggest.ts";
import { defaultReviewer, loadReviewState, startReviewServer } from "./review.ts";
import { codexRegistrationCommand, defaultMcpLogFile, serveStdio } from "./mcp.ts";
import { ingestProposals, installSkill, SKILL_NAME, skillText } from "./propose.ts";
import { mineWithModel, ReplayEngine } from "./mine.ts";
import { repoIdFor } from "./knowledge/indexer.ts";
import { currentName, precedentsFile, syncPrecedents, writePrecedentsFile, type PrecedentAttributes } from "./knowledge/precedents.ts";

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

const precedents = program.command("precedents").description("Resolved tickets and the pull requests that resolved them: how similar work was done here, linked to the current code at every index (history the planner may follow, never policy)");
precedents
  .command("sync")
  .description("Fetch closed issues and their merged pull requests with the GitHub CLI, read each pull request's diff from the local history (files, definitions, tests added), store them under .intentos/precedents/<repo-id>.json and re-index")
  .argument("<repo>", "path of the repository root (its git history must contain the merge commits)")
  .requiredOption("--issues <owner/name>", "GitHub repository whose closed issues are the tickets")
  .option("--pulls <owner/name>", "GitHub repository of the pull requests when it differs (e.g. tickets on a fork, pull requests upstream)")
  .option("--limit <n>", "newest N closed issues", (v) => Number(v), 500)
  .option("--no-timeline", "do not walk issue timelines for cross-referenced pull requests (fewer API calls; links in the issue text only)")
  .option("--no-index", "write the file but do not re-index")
  .option("--gh <path>", "GitHub CLI binary", "gh")
  .action((repo: string, opts: { issues: string; pulls?: string; limit: number; timeline: boolean; index: boolean; gh: string }) => {
    const store = openStore();
    try {
      const repoPath = path.resolve(repo);
      const repoId = repoIdFor(repoPath);
      const data = syncPrecedents(repoPath, repoId, { issues: opts.issues, pulls: opts.pulls ?? null, limit: opts.limit, timeline: opts.timeline, ghBin: opts.gh }, (line) => console.error(`[precedents] ${line}`));
      const file = precedentsFile(resolvePaths(), repoId);
      writePrecedentsFile(file, data);
      const linked = data.precedents.filter((p) => p.pull?.diff).length;
      const summary = opts.index ? indexRepository(store, repoPath) : null;
      if (program.opts().json) console.log(JSON.stringify({ file, precedents: data.precedents.length, with_pull: data.precedents.filter((p) => p.pull).length, linked_to_diff: linked, index: summary?.precedents ?? null, revision: summary?.head_sha ?? null }, null, 2));
      else {
        console.log(`Synced ${data.precedents.length} precedent(s) from ${opts.issues}${opts.pulls ? ` (pull requests in ${opts.pulls})` : ""} -> ${file}`);
        console.log(`  with a merged pull request: ${data.precedents.filter((p) => p.pull).length}; diff read from local history: ${linked}`);
        if (summary?.precedents) console.log(`  linked at ${summary.head_sha.slice(0, 10)}: ${summary.precedents.current} current, ${summary.precedents.partially_stale} partially stale, ${summary.precedents.stale} stale, ${summary.precedents.unlinked} text-only`);
        console.log(`  next: intentos explain ${repo} "<task>" shows the matching precedents; intentos precedents show ${repo} lists them all`);
      }
    } catch (err) {
      fail((err as Error).message);
    } finally {
      store.close();
    }
  });
precedents
  .command("show")
  .description("List the precedents linked at the indexed revision: ticket, pull request, definitions changed, tests added, staleness")
  .argument("<repo>", "indexed repository root")
  .option("--stale", "only precedents whose code no longer exists (fully or partially)", false)
  .action((repo: string, opts: { stale: boolean }) => {
    const store = openStore();
    try {
      const indexed = loadIndexedRepo(store, repo);
      const rows = store
        .nodes(indexed.repo.id, indexed.revision, "precedent")
        .map((n) => ({ id: n.id, ...(JSON.parse(n.attributes_json) as PrecedentAttributes) }))
        .filter((p) => !opts.stale || p.staleness === "stale" || p.staleness === "partially_stale")
        .sort((a, b) => a.number - b.number);
      if (program.opts().json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (!rows.length) {
        console.log(`No precedents linked for ${indexed.repoPath}. Run: intentos precedents sync ${repo} --issues <owner/name>`);
        return;
      }
      console.log(`${rows.length} precedent(s) at ${indexed.revision.slice(0, 10)}`);
      for (const p of rows) {
        const where = p.symbols.map((x) => `${currentName(x)}${x.current ? "" : " [gone]"}`);
        const files = p.files.filter((f) => !f.is_test).map((f) => `${f.renamed_to ?? f.path}${f.current ? "" : " [gone]"}`);
        console.log(`  #${String(p.number).padEnd(5)} ${p.staleness.padEnd(15)} ${p.title}${p.pull ? `  ← PR #${p.pull.number}` : ""}`);
        if (where.length || files.length) console.log(`         changed: ${(where.length ? where : files).slice(0, 6).join(", ")}${(where.length ? where : files).length > 6 ? ", …" : ""}`);
        if (p.tests_added.length) console.log(`         tests added: ${p.tests_added.map((t) => t.name).slice(0, 4).join(", ")}${p.tests_added.length > 4 ? ", …" : ""}`);
        for (const r of p.staleness_reasons) console.log(`         note: ${r.length > 220 ? `${r.slice(0, 220)}…` : r}`);
      }
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
      // Progress goes to stderr in every mode: with --json a caller (the MCP server's onboard job) streams it while stdout stays the result.
      const result = onboardRepository(store, repo, { policyId: opts.policyId, out: opts.out, python: opts.python, install: opts.install, test: opts.test, index: opts.index, force: opts.force }, (line) => console.error(`[onboard] ${line}`));
      const suggestions = opts.suggest ? await suggestPolicy(repo, { policyId: result.policy_id, writeAdrs: false, withCodex: false }, (line) => console.error(`[suggest] ${line}`)) : null;
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
      const result = await suggestPolicy(repo, { policyId: opts.policyId, outDir: opts.out, writeAdrs: opts.writeAdrs, adrDir: opts.adrDir, withCodex: opts.withCodex, maxCommits: Number(opts.maxCommits), minConfidence: level, minScore, classify: opts.classify, classifyTop: Number(opts.classifyTop), feedbackFile: opts.feedback }, (line) => console.error(`[suggest] ${line}`));
      if (json) console.log(JSON.stringify(result, null, 2));
      else printSuggestions(result);
    } catch (err) {
      fail((err as Error).message);
    }
  });

program
  .command("review")
  .description("Open a local one-page UI to approve or reject the mined policy candidates; approvals land in the policy file, the hidden tests and the repository's policy notes")
  .argument("<repo>", "path to the repository root (a Git checkout)")
  .option("--policy-id <id>", "policy id (default: from the last suggest run)")
  .option("--out <dir>", "directory of the last suggest run (default .intentos/onboard/<repo-id>)")
  .option("--policy-file <file>", "policy file to append to (default policies/<policy-id>.yaml)")
  .option("--by <name>", "reviewer name written into approved_by (default: git user.name)")
  .option("--doc-file <path>", "repository-relative Markdown file that receives sections for candidates without a source", "docs/intentos-policy.md")
  .option("--port <n>", "port for the local server (default: random)")
  .option("--no-open", "print the URL instead of opening the browser")
  .option("--include-filtered", "also show candidates the classifier set aside", false)
  .action(async (repo: string, opts: { policyId?: string; out?: string; policyFile?: string; by?: string; docFile: string; port?: string; open: boolean; includeFiltered: boolean }) => {
    const store = openStore();
    try {
      const state = await loadReviewState(repo, { policyId: opts.policyId, outDir: opts.out, policyFile: opts.policyFile, by: opts.by ?? defaultReviewer(), docFile: opts.docFile, includeFiltered: opts.includeFiltered, store, log: (line) => console.error(`[review] ${line}`) });
      const pending = state.candidates.filter((c) => !state.decisions.some((d) => d.id === c.id)).length;
      console.log(`Review ${state.policy_id}: ${state.candidates.length} candidate(s), ${pending} pending; approvals go to ${state.policy_file}`);
      const server = await startReviewServer(state, { port: opts.port ? Number(opts.port) : 0, open: opts.open, log: (line) => console.log(`  ${line}`) });
      console.log("  press Ctrl-C to stop without finishing (decisions so far are kept)");
      const result = await server.done;
      console.log(`Review finished: approved ${result.accepted}${result.assigned.length ? ` (${result.assigned.join("; ")})` : ""}${result.merged ? `, ${result.merged} related folded in` : ""}, rejected ${result.rejected}, skipped ${result.skipped}, pending ${result.pending}`);
      if (result.hidden_tests_needing_attention.length) console.log(`  hidden tests to finish by hand: ${result.hidden_tests_needing_attention.join(", ")}`);
      if (result.feedback) console.log(`  feedback recorded: ${result.feedback.accept_tokens.length} accept / ${result.feedback.reject_tokens.length} reject terms`);
      if (result.index) console.log(`  re-indexed (${result.index.mode}, policy ${result.index.policy_id})${result.index.unresolved_sources.length ? `; unresolved policy sources: ${result.index.unresolved_sources.map((u) => `${u.owner} ${u.path}${u.heading ? `#${u.heading}` : ""}`).join("; ")}` : ""}`);
      if (result.index_error) console.log(`  index failed: ${result.index_error}`);
      console.log("  commit the policy, the hidden tests and any new section in the repository");
    } catch (err) {
      fail((err as Error).message);
    } finally {
      store.close();
    }
  });

program
  .command("mcp")
  .description("Run IntentOS as an MCP server on stdio (tools: status, onboard, mined, mining_guide, propose, mine, explain, policy, review_start, review_next, review_close; the host onboards, mines and reviews on one sentence from the user)")
  .option("--log <file>", "log file for client info and tool calls (default .intentos/mcp.log)")
  .option("--print-codex-config", "print the command that registers this server with Codex and exit", false)
  .action(async (opts: { log?: string; printCodexConfig: boolean }) => {
    if (opts.printCodexConfig) {
      console.log(codexRegistrationCommand(PROJECT_ROOT));
      return;
    }
    const store = openStore();
    try {
      await serveStdio({ store, logFile: opts.log ?? defaultMcpLogFile(), log: (line) => console.error(`[intentos mcp] ${line}`) });
      await new Promise<void>((resolve) => {
        process.stdin.on("end", resolve);
        process.stdin.on("close", resolve);
      });
    } catch (err) {
      fail((err as Error).message);
    } finally {
      store.close();
    }
  });

program
  .command("propose")
  .description(`Validate host-authored policy candidates (JSON written per the ${SKILL_NAME} skill) against a repository, run their tests in its venv, and write the review files`)
  .argument("<repo>", "path to the repository root (a Git checkout)")
  .requiredOption("--file <json>", "a JSON list of candidates, or {candidates: [...]}")
  .option("--policy-id <id>", "policy id (default: sanitised project name)")
  .option("--policy-file <file>", "policy file (default policies/<policy-id>.yaml)")
  .option("--out <dir>", "directory of the review files (default .intentos/onboard/<repo-id>)")
  .option("--append", "add to the candidates accepted by an earlier propose instead of replacing them", false)
  .action(async (repo: string, opts: { file: string; policyId?: string; policyFile?: string; out?: string; append: boolean }) => {
    const json = program.opts().json as boolean;
    try {
      const loaded = JSON.parse(fs.readFileSync(opts.file, "utf8")) as unknown;
      const list = Array.isArray(loaded) ? loaded : ((loaded as { candidates?: unknown[] }).candidates ?? []);
      const r = await ingestProposals(repo, list, { policyId: opts.policyId, policyFile: opts.policyFile, outDir: opts.out, append: opts.append }, (line) => console.error(`[propose] ${line}`));
      if (json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      console.log(`${r.accepted.length} accepted, ${r.rejected.length} rejected; review list: ${r.candidates.length} candidate(s) in ${r.files.json}`);
      for (const a of r.accepted) console.log(`  ${a.id}  ${a.title}  [${a.kind}; test: ${a.verified}${a.notes.length ? `; ${a.notes.join("; ")}` : ""}]`);
      for (const x of r.rejected) console.log(`  rejected  ${x.title}\n    ${x.reasons.join("\n    ")}`);
    } catch (err) {
      fail((err as Error).message);
    }
  });

program
  .command("mine")
  .description(`Mine a repository's business rules with an independent model: run the ${SKILL_NAME} skill in a separate read-only Codex thread with --model, check and test the answer like propose, send rejections back once, and write the review files`)
  .argument("<repo>", "path to the repository root (onboarded)")
  .option("--model <slug>", "Codex model for the side thread (default INTENTOS_MINING_MODEL); one other than the model that drives your sessions")
  .option("--reasoning <level>", "reasoning effort for the side thread (default INTENTOS_CODEX_REASONING, else the model's own)")
  .option("--rounds <n>", "rounds at most, the first included", "2")
  .option("--append", "add to the current review list instead of replacing it", false)
  .option("--policy-id <id>", "policy id (default: sanitised project name)")
  .option("--policy-file <file>", "policy file (default policies/<policy-id>.yaml)")
  .option("--out <dir>", "directory of the review files (default .intentos/onboard/<repo-id>)")
  .option("--replay <dir>", "re-check the saved answers of an earlier run (round-N.json in that directory) instead of calling Codex")
  .action(async (repo: string, opts: { model?: string; reasoning?: string; rounds: string; append: boolean; policyId?: string; policyFile?: string; out?: string; replay?: string }) => {
    const json = program.opts().json as boolean;
    try {
      const r = await mineWithModel(repo, { model: opts.model, reasoningEffort: opts.reasoning, rounds: Number(opts.rounds), append: opts.append, policyId: opts.policyId, policyFile: opts.policyFile, outDir: opts.out, engine: opts.replay ? new ReplayEngine(path.resolve(opts.replay), opts.model ?? null) : undefined }, (line) => console.error(`[mine] ${line}`));
      if (json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      console.log(`mined by ${r.model ?? r.engine} (${r.engine}), ${r.rounds.length} round(s): ${r.accepted.length} accepted, ${r.rejected.length} still rejected; review list: ${r.candidates.length} candidate(s) in ${r.files.json}`);
      for (const a of r.accepted) console.log(`  ${a.id}  ${a.title}  [${a.kind}; test: ${a.verified}${a.notes.length ? `; ${a.notes.join("; ")}` : ""}]`);
      for (const x of r.rejected) console.log(`  rejected  ${x.title}\n    ${x.reasons.join("\n    ")}`);
      console.log(`  prompts and answers: ${r.files.dir}`);
    } catch (err) {
      fail((err as Error).message);
    }
  });

const skill = program.command("skill").description(`The ${SKILL_NAME} skill: how Codex mines a repository's business rules into IntentOS candidates`);
skill
  .command("install")
  .description("symlink the skill into a Codex skills directory (default ~/.agents/skills, scanned by Codex for every project)")
  .option("--dir <dir>", "skills directory")
  .option("--force", "replace a non-symlink entry of the same name", false)
  .action((opts: { dir?: string; force: boolean }) => {
    try {
      const r = installSkill({ dir: opts.dir, force: opts.force });
      console.log(`${r.created ? "installed" : "already installed"}: ${r.link} -> ${r.target}`);
      console.log(`Codex picks it up on its next start; $${SKILL_NAME} invokes it explicitly.`);
    } catch (err) {
      fail((err as Error).message);
    }
  });
skill.command("show").description("print the skill text").action(() => console.log(skillText()));

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
registerMergeCommands(program, { openStore, fail });

program.parseAsync(process.argv).catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
