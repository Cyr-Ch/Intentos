/**
 * LLM judge for the comparison: pairwise, blinded, order-swapped, with the rubric, by a model other than the implementer
 * and the test author.
 *
 *   node --disable-warning=ExperimentalWarning benchmarks/judge.ts --compare <dir with compare.json> --model <slug>
 *       [--rubric benchmarks/demandlib/rubric.md] [--only T01,T02] [--calibrate]
 *
 * For every ticket with a diff in both arms, the judge sees the ticket, two diffs labelled A and B in random order, and
 * the rubric, scores each criterion 1–5 with a cited reason, and names the diff a maintainer should merge or "tie". The
 * same pair is judged again with the order swapped; a verdict that flips is a tie. Scores go to judge.json and
 * judge.md next to compare.json. `--calibrate` writes ten random pairs (ticket, diffs, rubric, no labels) to
 * calibration/ for a person to score before any aggregate is reported.
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../src/config.ts";
import { KnowledgeStore } from "../src/knowledge/storage.ts";
import { resolvePaths } from "../src/config.ts";
import { LiveCodexEngine, type CodingEngine } from "../src/codex/adapter.ts";
import { loadTicketFile } from "../src/acceptance.ts";
import { redact } from "../src/util/redact.ts";
import { nowIso } from "../src/util/ids.ts";

const CRITERIA = ["C1", "C2", "C3", "C4", "C5", "C6"] as const;

export const JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["A", "B", "verdict", "deciding_criterion", "reason"],
  properties: {
    A: scoreSchema(),
    B: scoreSchema(),
    verdict: { type: "string", enum: ["A", "B", "tie"] },
    deciding_criterion: { type: "string" },
    reason: { type: "string" },
  },
};

function scoreSchema(): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const c of CRITERIA) props[c] = { type: "object", additionalProperties: false, required: ["score", "reason"], properties: { score: { type: "integer", minimum: 1, maximum: 5 }, reason: { type: "string" } } };
  return { type: "object", additionalProperties: false, required: [...CRITERIA], properties: props };
}

interface Args {
  compare: string;
  model: string | null;
  rubric: string;
  only: Set<string> | null;
  calibrate: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { compare: "", model: process.env.INTENTOS_JUDGE_MODEL ?? null, rubric: path.join(PROJECT_ROOT, "benchmarks", "demandlib", "rubric.md"), only: null, calibrate: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === "--compare") a.compare = argv[++i] ?? "";
    else if (v === "--model") a.model = argv[++i] ?? null;
    else if (v === "--rubric") a.rubric = argv[++i] ?? a.rubric;
    else if (v === "--only") a.only = new Set((argv[++i] ?? "").split(",").filter(Boolean));
    else if (v === "--calibrate") a.calibrate = true;
  }
  if (!a.compare) throw new Error("--compare <dir> is required");
  return a;
}

interface Pair {
  ticket: string;
  title: string;
  text: string;
  diffs: Record<"full" | "baseline", string>;
}

export function buildJudgePrompt(a: { ticket: string; text: string; rubric: string; first: string; second: string; repo: string }): string {
  const L: string[] = [];
  L.push("# Code review judgement");
  L.push("");
  L.push(`You judge two resolutions of the same ticket on the repository at ${a.repo}, which you may read (read-only) for context. You do not know who or what produced either diff, and you must not guess. Score each diff on the rubric's six criteria (1 to 5, one-sentence reason citing a line of the diff), then say which diff a maintainer should merge, or "tie", naming the deciding criterion. When criteria disagree, C1 and C5 outweigh C6; readability alone never decides.`);
  L.push("");
  L.push("## The ticket");
  L.push("");
  L.push(a.text);
  L.push("");
  L.push("## The rubric");
  L.push("");
  L.push(a.rubric);
  L.push("");
  L.push("A resolution may be a diff, or a written answer instead of code (a refusal with its reasons, or questions asked before implementing); the rubric's C1 says how to score those.");
  L.push("");
  L.push("## Resolution A");
  L.push("");
  L.push("```");
  L.push(a.first.trim() || "(empty: no change and no answer)");
  L.push("```");
  L.push("");
  L.push("## Resolution B");
  L.push("");
  L.push("```");
  L.push(a.second.trim() || "(empty: no change and no answer)");
  L.push("```");
  L.push("");
  L.push('Output: a JSON object {"A": {"C1": {"score": n, "reason": "..."}, ... "C6": {...}}, "B": {...}, "verdict": "A" | "B" | "tie", "deciding_criterion": "C1".."C6", "reason": "<one sentence>"} and nothing else.');
  return redact(L.join("\n"));
}

function parse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("the judge's answer is not JSON");
    return JSON.parse(m[0]) as Record<string, unknown>;
  }
}

/**
 * What the judge sees as a resolution: the diff, or, for a run that answered instead of changing code, the answer
 * itself (an abstention's cited rationale, a clarification's questions), so the rubric's "question or refusal" clause
 * can apply. An empty string means the run changed nothing and said nothing.
 */
function diffOf(store: KnowledgeStore, runId: string | null): string | null {
  if (!runId) return null;
  const row = store.getRun(runId);
  if (!row) return null;
  const result = row.result_json ? (JSON.parse(row.result_json) as { final_state?: string; rationale?: string; open_questions?: Array<{ id: string; question: string; blocking: boolean }> }) : null;
  if (result?.final_state === "ABSTAINED") return `(no code change: the agent declined with this rationale)\n\n${result.rationale ?? ""}`;
  if (result?.final_state === "CLARIFICATION_REQUIRED") return `(no code change: the agent asked before implementing)\n\n${(result.open_questions ?? []).map((q) => `- ${q.question}`).join("\n")}\n\n${result.rationale ?? ""}`;
  const file = path.join(row.run_dir, "diff.patch");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(args.compare);
  const compare = JSON.parse(fs.readFileSync(path.join(dir, "compare.json"), "utf8")) as { repo: string; model: string | null; runs: Array<{ ticket: string; arm: "full" | "baseline"; run_id: string | null; final_state: string }> };
  const tickets = loadTicketFile(path.join(PROJECT_ROOT, "benchmarks", "demandlib", "tickets.yaml"));
  const rubric = fs.readFileSync(args.rubric, "utf8");
  const store = new KnowledgeStore(resolvePaths().db);
  const pairs: Pair[] = [];
  for (const t of tickets) {
    if (args.only && !args.only.has(t.id)) continue;
    const full = compare.runs.find((r) => r.ticket === t.id && r.arm === "full");
    const base = compare.runs.find((r) => r.ticket === t.id && r.arm === "baseline");
    const df = diffOf(store, full?.run_id ?? null);
    const db = diffOf(store, base?.run_id ?? null);
    if (df === null && db === null) continue;
    // A clarification or abstention has no diff: judged as an empty diff, which the rubric's C1 covers.
    pairs.push({ ticket: t.id, title: t.title, text: `${t.title}\n\n${t.issue}`.trim(), diffs: { full: df ?? "", baseline: db ?? "" } });
  }
  if (args.calibrate) {
    const out = path.join(dir, "calibration");
    fs.mkdirSync(out, { recursive: true });
    const sample = [...pairs].sort(() => Math.random() - 0.5).slice(0, 10);
    const key: Array<{ ticket: string; A: string; B: string }> = [];
    for (const p of sample) {
      const swap = Math.random() < 0.5;
      const [first, second] = swap ? [p.diffs.baseline, p.diffs.full] : [p.diffs.full, p.diffs.baseline];
      fs.writeFileSync(path.join(out, `${p.ticket}.md`), `# ${p.ticket}: ${p.title}\n\n${p.text}\n\n## Diff A\n\n\`\`\`diff\n${first}\n\`\`\`\n\n## Diff B\n\n\`\`\`diff\n${second}\n\`\`\`\n\n## Your scores (1-5 per criterion for A and B, verdict A/B/tie, deciding criterion)\n\n`);
      key.push({ ticket: p.ticket, A: swap ? "baseline" : "full", B: swap ? "full" : "baseline" });
    }
    fs.writeFileSync(path.join(out, "KEY.json"), JSON.stringify(key, null, 2));
    console.log(`wrote ${sample.length} calibration pair(s) to ${out} (KEY.json says which arm is A; do not open it before scoring)`);
    store.close();
    return;
  }
  if (!args.model) throw new Error("--model <slug> (or INTENTOS_JUDGE_MODEL) is required: a model other than the implementer and the test author");
  if (compare.model && args.model === compare.model) throw new Error(`the judge must not be the implementer model (${compare.model})`);
  const engine: CodingEngine = new LiveCodexEngine({ model: args.model });
  const results: Array<Record<string, unknown>> = [];
  const outFile = path.join(dir, "judge.json");
  const existing = fs.existsSync(outFile) ? (JSON.parse(fs.readFileSync(outFile, "utf8")) as { results: Array<Record<string, unknown>> }).results : [];
  results.push(...existing);
  for (const p of pairs) {
    if (results.some((r) => r.ticket === p.ticket)) continue;
    const passes: Array<{ order: ["full", "baseline"] | ["baseline", "full"]; answer: Record<string, unknown> }> = [];
    for (const order of [["full", "baseline"], ["baseline", "full"]] as const) {
      const prompt = buildJudgePrompt({ ticket: p.ticket, text: p.text, rubric, first: p.diffs[order[0]], second: p.diffs[order[1]], repo: compare.repo });
      console.error(`[judge] ${p.ticket}: ${order.join(" then ")}`);
      const res = await engine.plan({ cwd: compare.repo, prompt, outputSchema: JUDGE_SCHEMA });
      passes.push({ order: [...order] as ["full", "baseline"] | ["baseline", "full"], answer: parse(res.text) });
    }
    // Map A/B back to arms for each pass; the verdict stands only when both passes agree on the arm.
    const byArm = passes.map((pass) => {
      const a = pass.answer as { A: Record<string, { score: number; reason: string }>; B: Record<string, { score: number; reason: string }>; verdict: string; deciding_criterion: string; reason: string };
      const scores = { [pass.order[0]]: a.A, [pass.order[1]]: a.B } as Record<"full" | "baseline", Record<string, { score: number; reason: string }>>;
      const verdict = a.verdict === "tie" ? "tie" : a.verdict === "A" ? pass.order[0] : pass.order[1];
      return { scores, verdict, deciding: a.deciding_criterion, reason: a.reason };
    });
    const verdict = byArm[0]!.verdict === byArm[1]!.verdict ? byArm[0]!.verdict : "tie";
    const mean = (arm: "full" | "baseline", c: string) => (byArm[0]!.scores[arm][c]!.score + byArm[1]!.scores[arm][c]!.score) / 2;
    results.push({ ticket: p.ticket, model: args.model, judged_at: nowIso(), verdict, flipped: byArm[0]!.verdict !== byArm[1]!.verdict, passes: byArm, mean: { full: Object.fromEntries(CRITERIA.map((c) => [c, mean("full", c)])), baseline: Object.fromEntries(CRITERIA.map((c) => [c, mean("baseline", c)])) } });
    fs.writeFileSync(outFile, JSON.stringify({ model: args.model, rubric: path.relative(PROJECT_ROOT, args.rubric), results }, null, 2));
    console.error(`[judge] ${p.ticket}: ${verdict}${byArm[0]!.verdict !== byArm[1]!.verdict ? " (flipped with order; recorded as tie)" : ""}`);
  }
  fs.writeFileSync(path.join(dir, "judge.md"), renderJudge(results as never, args.model));
  console.log(renderJudge(results as never, args.model));
  store.close();
}

function renderJudge(results: Array<{ ticket: string; verdict: string; flipped: boolean; mean: Record<"full" | "baseline", Record<string, number>>; passes: Array<{ reason: string; deciding: string }> }>, model: string): string {
  const L: string[] = [];
  L.push(`# Judge: ${model}, pairwise, blinded, order-swapped`);
  L.push("");
  L.push("| ticket | verdict | flipped with order | full C1..C6 | baseline C1..C6 | deciding | reason (first pass) |");
  L.push("|---|---|---|---|---|---|---|");
  for (const r of results) L.push(`| ${r.ticket} | ${r.verdict} | ${r.flipped ? "yes" : "no"} | ${CRITERIA.map((c) => r.mean.full[c]).join(" ")} | ${CRITERIA.map((c) => r.mean.baseline[c]).join(" ")} | ${r.passes[0]!.deciding} | ${r.passes[0]!.reason.slice(0, 120)} |`);
  const wins = (arm: string) => results.filter((r) => r.verdict === arm).length;
  L.push("");
  L.push(`Full wins ${wins("full")}, baseline wins ${wins("baseline")}, ties ${wins("tie")} (of ${results.length}). Mean per criterion: full ${CRITERIA.map((c) => (results.reduce((a, r) => a + r.mean.full[c]!, 0) / Math.max(1, results.length)).toFixed(2)).join(" ")}; baseline ${CRITERIA.map((c) => (results.reduce((a, r) => a + r.mean.baseline[c]!, 0) / Math.max(1, results.length)).toFixed(2)).join(" ")}.`);
  L.push("");
  L.push("Not reportable until the calibration pairs (judge.ts --calibrate) have been scored by a person and the agreement is published next to these numbers.");
  return L.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
