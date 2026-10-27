import type { Command } from "commander";
import path from "node:path";
import type { CliContext } from "./cli_run.ts";
import { guardRepo, listRepoPrs, mergeNumberedPr, mergeRun, type MergeOutcome } from "./coordination/merge.ts";
import { coordinationStatus } from "./coordination/mergeguard.ts";

function printMerge(out: MergeOutcome): void {
  const pr = out.pr;
  console.log(`PR #${pr.number} ${out.branch} -> ${out.main_branch}: ${out.merged ? `merged as ${out.merge_commit?.slice(0, 10)}` : "NOT merged"}`);
  console.log(`  review tier ${pr.decision.tier} (${pr.decision.required_approvals} approval(s) needed; has ${pr.approvals.length}): ${pr.decision.reasons.join("; ")}`);
  for (const [file, proof] of Object.entries(pr.decision.proofs)) console.log(`    ${file}: ${proof}`);
  if (pr.ci) console.log(`  branch CI: ${pr.ci.outcome}${pr.ci.failed?.length ? ` (${pr.ci.failed.slice(0, 3).join(", ")})` : ""}`);
  if (out.merged_verification) console.log(`  merged result: ${out.merged_verification.status} (${out.merged_verification.blocking.length} blocking, ${out.merged_verification.review.length} review) -> ${out.merged_verification.dir}`);
  if (pr.merge_check) console.log(`  merged tests (mergeguard): ${pr.merge_check.outcome} — ${pr.merge_check.summary}`);
  for (const reason of out.blocked_by) console.log(`  blocked: ${reason}`);
  if (out.merged) console.log(`  index: ${out.reindexed ? "refreshed" : "NOT refreshed; run intentos index"}`);
}

export function registerMergeCommands(program: Command, ctx: CliContext): void {
  const json = () => program.opts().json as boolean;
  const log = (s: string) => {
    if (!json()) console.error(`[intentos] ${s}`);
  };

  program
    .command("merge")
    .description("Merge a verified run (REVIEW_READY or HUMAN_REVIEW) into the repository's main through mergeguard: branch, PR, review tier, approvals, merged-result verification with the hidden tests, fast-forward. With --pr, merge a numbered mergeguard PR (an undo PR) instead.")
    .argument("<run-id-or-pr>", "run id, or a PR number with --repo")
    .option("--approve <name...>", "record a human approval on the PR's current head (repeatable; the author and bots never count)")
    .option("--by <name>", "who asked for the merge (recorded as the PR's prompter, never a reviewer)")
    .option("--repo <path>", "repository, when merging a PR number")
    .option("--skip-merged-verification", "do not verify the branch merged onto main with the hidden tests (recorded)", false)
    .action((target: string, o: { approve?: string[]; by?: string; repo?: string; skipMergedVerification: boolean }) => {
      const store = ctx.openStore();
      try {
        let out: MergeOutcome;
        if (/^\d+$/.test(target)) {
          if (!o.repo) ctx.fail("merging a PR number needs --repo <path>");
          out = mergeNumberedPr(store, path.resolve(o.repo!), Number(target), { approve: o.approve ?? [], by: o.by ?? null, log });
        } else {
          out = mergeRun(store, target, { approve: o.approve ?? [], by: o.by ?? null, skipMergedVerification: o.skipMergedVerification, log });
        }
        if (json()) console.log(JSON.stringify(out, null, 2));
        else printMerge(out);
        if (!out.merged) process.exitCode = 1;
      } catch (err) {
        ctx.fail((err as Error).message);
      } finally {
        store.close();
      }
    });

  program
    .command("guard")
    .description("When main is red: rerun to rule out flaky tests, bisect first-parent over the merges, check the culprit alone, find its partner, open a validated undo PR; then show the breaker's review floors")
    .argument("<repo>", "repository root")
    .option("--good <sha>", "a known-good commit on main (default: the parent of the first merge in the ledger)")
    .option("--no-undo", "investigate only; do not open an undo PR")
    .action((repo: string, o: { good?: string; undo: boolean }) => {
      const store = ctx.openStore();
      try {
        const out = guardRepo(store, path.resolve(repo), { good: o.good ?? null, undo: o.undo, log });
        if (json()) console.log(JSON.stringify(out, null, 2));
        else {
          console.log(`${out.main_branch} ${out.main.slice(0, 10)} (known good ${out.good.slice(0, 10)}): ${out.guardian.status}`);
          if (out.guardian.message) console.log(`  ${out.guardian.message}`);
          if (out.undo_pr !== null) console.log(`  undo PR #${out.undo_pr} is open: intentos merge ${out.undo_pr} --repo ${repo} --approve <name>`);
          const floors = Object.entries(out.breaker.folders ?? {});
          console.log(floors.length ? "  review floors:" : "  review floors: none");
          for (const [folder, f] of floors) console.log(`    ${folder}: tier ${f.floor} — ${f.reason}`);
        }
        if (out.guardian.status !== "green" && out.guardian.status !== "undo_opened" && out.guardian.status !== "identified") process.exitCode = 2;
      } catch (err) {
        ctx.fail((err as Error).message);
      } finally {
        store.close();
      }
    });

  program
    .command("prs")
    .description("List mergeguard PRs for a repository (runs that were merged or are waiting, undo PRs)")
    .argument("<repo>", "repository root")
    .action((repo: string) => {
      try {
        const prs = listRepoPrs(path.resolve(repo));
        if (json()) console.log(JSON.stringify(prs, null, 2));
        else for (const pr of prs) console.log(`#${String(pr.number).padStart(3)} ${pr.state.padEnd(7)} tier ${pr.decision?.tier ?? "?"}  ${pr.branch.padEnd(40)} ${pr.title.slice(0, 60)}`);
      } catch (err) {
        ctx.fail((err as Error).message);
      }
    });

  program
    .command("coordination")
    .description("Whether mergeguard coordination is available to runs in this environment")
    .action(() => {
      const s = coordinationStatus();
      if (json()) console.log(JSON.stringify(s));
      else console.log(`${s.ok ? "on" : "off"}: ${s.reason}`);
    });
}
