import type { Command } from "commander";
import type { CliContext } from "./cli_run.ts";
import { loadIndexedRepo } from "./knowledge/repo.ts";
import { proposeDecision, approveDecision, supersedeDecision, listDecisions, proposeFromFeedback } from "./knowledge/decisions.ts";

export function registerDecisionCommands(program: Command, ctx: CliContext): void {
  const json = () => program.opts().json as boolean;
  const decision = program.command("decision").description("Approved engineering memory: propose, approve, supersede and list decisions");

  decision
    .command("propose")
    .description("Record a proposed decision (model_inference authority; never blocking until approved)")
    .argument("<repo>")
    .argument("<statement>")
    .option("--scope <tags>", "comma-separated scope tags", "")
    .option("--evidence <ids>", "comma-separated evidence ids from the current index", "")
    .option("--rationale <text>")
    .action((repo: string, statement: string, o: { scope: string; evidence: string; rationale?: string }) => {
      const store = ctx.openStore();
      try {
        const indexed = loadIndexedRepo(store, repo);
        const row = proposeDecision(store, indexed, { statement, scope: split(o.scope), evidenceIds: split(o.evidence), rationale: o.rationale ?? null, source: "cli" });
        console.log(json() ? JSON.stringify(row, null, 2) : `proposed ${row.id} (status ${row.status}, authority ${row.authority})`);
      } catch (err) {
        ctx.fail((err as Error).message);
      } finally {
        store.close();
      }
    });

  decision
    .command("approve")
    .description("Approve a proposed decision (becomes approved_decision authority)")
    .argument("<decision-id>")
    .requiredOption("--by <name>")
    .action((id: string, o: { by: string }) => {
      const store = ctx.openStore();
      try {
        const row = approveDecision(store, id, o.by);
        console.log(json() ? JSON.stringify(row, null, 2) : `approved ${row.id} by ${o.by} (effective ${row.effective_revision?.slice(0, 10)})`);
      } catch (err) {
        ctx.fail((err as Error).message);
      } finally {
        store.close();
      }
    });

  decision
    .command("supersede")
    .description("Mark an approved decision superseded by another")
    .argument("<old-id>")
    .argument("<new-id>")
    .requiredOption("--by <name>")
    .action((oldId: string, newId: string, o: { by: string }) => {
      const store = ctx.openStore();
      try {
        supersedeDecision(store, oldId, newId, o.by);
        console.log(`${oldId} superseded by ${newId}`);
      } catch (err) {
        ctx.fail((err as Error).message);
      } finally {
        store.close();
      }
    });

  decision
    .command("list")
    .argument("<repo>")
    .action((repo: string) => {
      const store = ctx.openStore();
      try {
        const indexed = loadIndexedRepo(store, repo);
        const rows = listDecisions(store, indexed.repo.id);
        if (json()) console.log(JSON.stringify(rows, null, 2));
        else for (const r of rows) console.log(`${r.id.padEnd(14)} ${r.status.padEnd(11)} ${r.authority.padEnd(18)} ${r.approved_by ?? "-"}  ${r.statement}${r.supersedes ? `  (supersedes ${r.supersedes})` : ""}`);
      } catch (err) {
        ctx.fail((err as Error).message);
      } finally {
        store.close();
      }
    });

  program
    .command("feedback")
    .description("Record reviewer feedback on a run as a PROPOSED decision (requires approval before it can influence policy)")
    .argument("<run-id>")
    .argument("<text>")
    .option("--scope <tags>", "comma-separated scope tags", "")
    .action((runId: string, text: string, o: { scope: string }) => {
      const store = ctx.openStore();
      try {
        const row = proposeFromFeedback(store, runId, text, split(o.scope));
        console.log(json() ? JSON.stringify(row, null, 2) : `recorded feedback as proposed decision ${row.id}; approve with: intentos decision approve ${row.id} --by <name>`);
      } catch (err) {
        ctx.fail((err as Error).message);
      } finally {
        store.close();
      }
    });
}

function split(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
