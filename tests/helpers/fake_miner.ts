import type { CodingEngine, ImplementResult, PlanRequest, PlanResult } from "../../src/codex/adapter.ts";

/** A stand-in for the Codex side thread: one canned answer per round, every prompt recorded. */
export type Round = (prompt: string, threadId: string | null | undefined) => unknown;
export interface FakeMiner extends CodingEngine {
  calls: Array<{ prompt: string; threadId: string | null | undefined }>;
}

export function fakeMiner(rounds: Round[], model = "fake-model", opts: { before?: () => Promise<void> } = {}): FakeMiner {
  const calls: FakeMiner["calls"] = [];
  return {
    name: "fake-miner",
    simulated: false,
    calls,
    async plan(req: PlanRequest): Promise<PlanResult> {
      calls.push({ prompt: req.prompt, threadId: req.threadId });
      if (calls.length === 1 && opts.before) await opts.before();
      req.onThreadStarted?.("thread-fake-1");
      const fn = rounds[calls.length - 1];
      if (!fn) throw new Error(`fake miner: no answer for round ${calls.length}`);
      return { text: JSON.stringify(fn(req.prompt, req.threadId)), usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 }, threadId: "thread-fake-1", simulated: false, engine: "fake-miner", model, items: [] };
    },
    async implement(): Promise<ImplementResult> {
      throw new Error("not used");
    },
  };
}

/** Every field present, as the structured output schema requires. */
const full = (c: Record<string, unknown>) => ({ kind: "invariant", category: "business_rule", rationale: "a user would notice", confidence: "high", relevance: "high", evidence: [], applies_to_paths: [], test: { existing: null, source: null }, rule: { kind: null, paths: [], forbidden_modules: [] }, sources: [], from_mined: null, ...c });

/** Round one on the startup_billing fixture: a lifted test, an invented reference, an architecture rule, an untested invariant. */
export const ROUND_ONE = {
  candidates: [
    full({ title: "Volume discount applies at the seat threshold", statement: "A contract at or above the seat threshold must receive the volume discount at checkout.", evidence: [{ type: "test", ref: "tests/test_checkout.py::test_checkout_applies_volume_discount", excerpt: "assert" }], applies_to_paths: ["app/api/checkout.py"], test: { existing: "tests/test_checkout.py::test_checkout_applies_volume_discount", source: null } }),
    full({ title: "Exports carry the invoice id", statement: "Every invoice export must carry the invoice id on each line.", evidence: [{ type: "doc", ref: "docs/missing.md:3", excerpt: "x" }], applies_to_paths: ["app/services/exports.py"], test: { existing: "tests/test_exports.py::test_csv_export", source: null } }),
    full({ kind: "architecture_rule", title: "api never imports legacy", statement: "The api package must never import the legacy adapter.", evidence: [{ type: "import", ref: "app/api/checkout.py:1", excerpt: "import" }], rule: { kind: "forbidden_import", paths: ["app/api/**"], forbidden_modules: ["app.legacy"] } }),
    full({ title: "Quotes carry a currency", statement: "Quotes must always carry a currency code of three letters.", evidence: [{ type: "doc", ref: "README.md:1", excerpt: "# startup_billing" }] }),
  ],
};

/** Round two: the invented reference fixed; the untested invariant given up. */
export const ROUND_TWO = {
  candidates: [full({ title: "Exports carry the invoice id", statement: "Every invoice export must carry the invoice id on each line.", evidence: [{ type: "doc", ref: "README.md:1", excerpt: "# startup_billing" }, { type: "test", ref: "tests/test_exports.py::test_csv_export", excerpt: "inv-42" }], applies_to_paths: ["app/services/exports.py"], test: { existing: "tests/test_exports.py::test_csv_export", source: null } })],
};

export const ROUND_TITLES = ["Volume discount applies at the seat threshold", "api never imports legacy", "Exports carry the invoice id"];
