import fs from "node:fs";
import path from "node:path";
import type { Policy } from "../knowledge/policy.ts";
import type { ChangeContract } from "../contracts/schemas.ts";

export interface GeneratedProbe {
  file: string;
  counterexample_id: string;
  invariant_id: string;
  authority: "exploratory" | "authoritative";
  cases: number;
}

/**
 * Bounded counterexample generation: expands policy-declared probe templates over a
 * parameter grid into pytest files. Probes are exploratory unless the policy marks them
 * authoritative; they never originate from model output.
 */
export function generateCounterexamples(policy: Policy, contract: ChangeContract, outDir: string): GeneratedProbe[] {
  const bound = new Set(contract.business_invariants.map((b) => b.id));
  const probes: GeneratedProbe[] = [];
  fs.mkdirSync(outDir, { recursive: true });
  for (const cx of policy.counterexamples) {
    if (!bound.has(cx.invariant)) continue;
    const combos = cartesian(cx.grid).slice(0, cx.max_cases);
    const body = combos
      .map((combo, i) => {
        const caseId = `${cx.id.toLowerCase().replace(/-/g, "_")}_${i + 1}`;
        let text = cx.template.replace(/\{case_id\}/g, caseId);
        for (const [k, v] of Object.entries(combo)) text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        // Keep imports once: split header (imports) from the test function.
        return text;
      })
      .join("\n\n");
    const header = `"""Counterexample probes for ${cx.invariant} (${cx.id}, ${cx.authority}): ${cx.description}"""\n`;
    const file = path.join(outDir, `test_${cx.id.toLowerCase().replace(/-/g, "_")}.py`);
    fs.writeFileSync(file, header + dedupeImports(body));
    probes.push({ file, counterexample_id: cx.id, invariant_id: cx.invariant, authority: cx.authority, cases: combos.length });
  }
  return probes;
}

function cartesian(grid: Record<string, Array<string | number>>): Array<Record<string, string | number>> {
  const keys = Object.keys(grid);
  let combos: Array<Record<string, string | number>> = [{}];
  for (const k of keys) {
    const next: Array<Record<string, string | number>> = [];
    for (const c of combos) for (const v of grid[k]!) next.push({ ...c, [k]: v });
    combos = next;
  }
  return combos;
}

/** Hoists duplicate import lines (from repeated templates) to the top, once each. */
function dedupeImports(body: string): string {
  const imports = new Set<string>();
  const rest: string[] = [];
  for (const line of body.split("\n")) {
    if (/^(from\s+\S+\s+import\s+|import\s+)/.test(line)) imports.add(line);
    else rest.push(line);
  }
  return [...imports].join("\n") + "\n\n" + rest.join("\n").replace(/\n{3,}/g, "\n\n");
}
