/**
 * `intentos triage`: a side model checks a ticket for gaps and contradictions; IntentOS verifies every reference the
 * model cites, sends unverifiable findings back once, turns what stays unbacked into questions, recomputes the verdict
 * from the surviving findings and plans the label move. A scripted engine plays the model; a fake `gh` plays GitHub.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { setupFixtureEnv, type TestEnv } from "../helpers/fixture.ts";
import { createIntentosMcpServer } from "../../src/mcp.ts";
import type { CodingEngine, ImplementResult, PlanRequest, PlanResult } from "../../src/codex/adapter.ts";
import { checkEvidence, githubTicketId, labelPlan, parseIssueRef, postTriage, readGithubIssue, reconcileVerdict, stageOf, ticketReferences, triageTicket, type GhRunner, type TicketInput, type TriageFinding } from "../../src/triage.ts";

let env: TestEnv;
beforeAll(() => {
  env = setupFixtureEnv();
});
afterAll(() => env.cleanup());

type RawFinding = Partial<Omit<TriageFinding, "checks">> & { id: string };
interface Answer {
  verdict?: string;
  summary?: string;
  findings?: RawFinding[];
  completed_ticket?: string;
}

/** Answers with one scripted object per round and records the prompts it saw. */
class ScriptedEngine implements CodingEngine {
  readonly name = "scripted";
  readonly simulated = true;
  prompts: string[] = [];
  private calls = 0;
  constructor(private readonly rounds: Answer[]) {}
  async plan(req: PlanRequest): Promise<PlanResult> {
    this.prompts.push(req.prompt);
    req.onThreadStarted?.("thread-triage");
    const a = this.rounds[this.calls++] ?? { findings: [] };
    return { text: JSON.stringify({ verdict: "needs_input", summary: "", completed_ticket: "", ...a }), usage: null, threadId: "thread-triage", simulated: true, engine: this.name, model: "stand-in-model", items: [] };
  }
  async implement(): Promise<ImplementResult> {
    throw new Error("the triage engine never implements");
  }
}

const ticket = (over: Partial<TicketInput> = {}): TicketInput => ({
  id: "T-promo",
  title: "Add a 15% promotional discount for eligible enterprise subscriptions",
  body: "Enterprise customers on the `Enterprise` plan should get 15% off at checkout. Use `Money.half` for rounding. The discount must apply in `app/services/pricing.py`.",
  labels: ["unfinished"],
  comments: [],
  url: null,
  source: { kind: "text" },
  ...over,
});

describe("intentos triage", () => {
  it("verifies references, sends unbacked findings back once, turns what stays unbacked into questions and recomputes the verdict", async () => {
    const engine = new ScriptedEngine([
      {
        verdict: "ready",
        summary: "Mostly clear; one policy clash.",
        completed_ticket: "# Promo\n\n- [ ] 15% off [TEAM: F5]",
        findings: [
          { id: "F1", kind: "contradiction", title: "Discount stacking", detail: "The ticket wants the promo on top of volume discounts", resolution: "ask", filled: null, evidence: [{ type: "policy", ref: "INV-001", excerpt: "the invariant" }], question: "Should the promotion stack with the volume discount, or does INV-001 win?", options: ["stack", "do not stack"], suggested_default: "do not stack", blocking: true },
          { id: "F2", kind: "interface", title: "Money arithmetic", detail: "How to round the 15%", resolution: "filled", filled: "Use Money.of and the existing rounding in app/domain/money.py", evidence: [{ type: "code", ref: "app/domain/money.py", excerpt: "class Money" }, { type: "code", ref: "app/domain/nowhere.py", excerpt: "made up" }], question: null, options: [], suggested_default: null, blocking: false },
          { id: "F3", kind: "behaviour", title: "Where discounts live", detail: "Which module computes discounts", resolution: "filled", filled: "Discounts are computed in app/services/discounts.py", evidence: [{ type: "code", ref: "app/services/imaginary.py", excerpt: "nope" }], question: null, options: [], suggested_default: null, blocking: false },
          { id: "F4", kind: "scope", title: "Eligibility", detail: "What makes an enterprise subscription eligible", resolution: "ask", filled: null, evidence: [], question: null, options: [], suggested_default: null, blocking: true },
          { id: "F5", kind: "acceptance_criteria", title: "Promotion period", detail: "The ticket gives no start or end date", resolution: "ask", filled: null, evidence: [{ type: "ticket", ref: "ticket", excerpt: "15% off at checkout" }], question: "Is the promotion time-limited? If so, which dates, and in which timezone?", options: ["permanent", "a date range"], suggested_default: "permanent until told otherwise", blocking: true },
        ],
      },
      {
        findings: [{ id: "F3", kind: "behaviour", title: "Where discounts live", detail: "Which module computes discounts", resolution: "filled", filled: "Discounts are computed in app/services/discounts.py, exercised by tests/test_checkout.py", evidence: [{ type: "test", ref: "tests/test_checkout.py::test_checkout_applies_volume_discount", excerpt: "volume discount applies" }, { type: "code", ref: "app/services/discounts.py", excerpt: "def ..." }], question: null, options: [], suggested_default: null, blocking: false }],
      },
    ]);
    const r = await triageTicket(env.repo, ticket(), { engine, store: env.store }, () => {});
    expect(r.rounds).toHaveLength(2);
    expect(r.rounds[0]).toMatchObject({ proposed: 5, accepted: 3 });
    expect(r.rounds[0]!.rejected.map((x) => x.id).sort()).toEqual(["F3", "F4"]);
    expect(r.rounds[0]!.rejected.find((x) => x.id === "F3")!.reasons.join(" ")).toMatch(/no such file or symbol/);
    expect(r.rounds[0]!.rejected.find((x) => x.id === "F4")!.reasons.join(" ")).toMatch(/question.*empty/);
    expect(r.rounds[1]).toMatchObject({ proposed: 1, accepted: 1, rejected: [] });
    const byId = Object.fromEntries(r.findings.map((f) => [f.id, f]));
    expect(Object.keys(byId)).toEqual(["F1", "F2", "F3", "F4", "F5"]);
    // F2 keeps the reference that exists and drops the invented one, with a check note
    expect(byId.F2!.evidence.map((e) => e.ref)).toEqual(["app/domain/money.py"]);
    expect(byId.F2!.checks.join(" ")).toMatch(/dropped reference.*nowhere\.py/);
    expect(byId.F2!.checks.join(" ")).toMatch(/verified 1 reference/);
    // F3 fixed in round 2
    expect(byId.F3!.resolution).toBe("filled");
    expect(byId.F3!.evidence).toHaveLength(2);
    // F4 never fixed: a question for the team, not a fact
    expect(byId.F4!.resolution).toBe("ask");
    expect(byId.F4!.question).toMatch(/Please answer: What makes an enterprise subscription eligible/);
    expect(byId.F4!.checks.join(" ")).toMatch(/turned into a question/);
    // the model said ready; two blocking questions and a contradiction remain
    expect(r.model_verdict).toBe("ready");
    expect(r.verdict).toBe("needs_input");
    expect(r.notes.join(" ")).toMatch(/the model said ready, but 3 blocking question\(s\) remain: F1, F4, F5/);
    expect(r.labels).toEqual({ current: ["unfinished"], add: [], remove: [] });
    // prompts: the ticket, the facts IntentOS computed, the evidence pack; the fix prompt names what was rejected
    expect(engine.prompts[0]).toContain("Add a 15% promotional discount");
    expect(engine.prompts[0]).toMatch(/Names the ticket uses that the index does not know.*Money\.half/);
    expect(engine.prompts[0]).toMatch(/Names the ticket uses that exist in the repository.*app\/services\/pricing\.py \(file\)/);
    expect(engine.prompts[0]).toContain("## Evidence pack from the index");
    expect(engine.prompts[0]).toContain("Workflow stage from the labels: unfinished");
    expect(engine.prompts[1]).toContain("could not accept 2");
    expect(engine.prompts[1]).toContain("F3 Where discounts live");
    // files and the report
    expect(fs.existsSync(path.join(r.dir, "round-2.json"))).toBe(true);
    expect(fs.existsSync(path.join(r.dir, "evidence.json"))).toBe(true);
    const report = fs.readFileSync(r.report_file, "utf8");
    expect(report).toContain("## Ticket QA: needs input from the team");
    expect(report).toContain("### Contradictions with what the repository knows (1)");
    expect(report).toContain("policy `INV-001`");
    expect(report).toContain("### Questions for the team (2 blocking)");
    expect(report).toContain("**Question:** Is the promotion time-limited?");
    expect(report).toContain("### Filled in from the repository (2, references verified at");
    expect(report).toContain("### Proposed ticket text");
    expect(report).toContain("[TEAM: F5]");
    expect(report).toContain(`<!-- intentos-triage repo=${r.repo_id} head=${r.head} verdict=needs_input ticket=T-promo -->`);
    const saved = JSON.parse(fs.readFileSync(path.join(r.dir, "result.json"), "utf8"));
    expect(saved).toMatchObject({ verdict: "needs_input", model: "stand-in-model", thread_id: "thread-triage", ticket: { id: "T-promo" } });
    expect(saved.signals.references.find((x: { name: string }) => x.name === "Money.half")).toMatchObject({ found: "none" });
    expect(saved.signals.references.find((x: { name: string }) => x.name === "Enterprise")).toMatchObject({ found: "none" }); // backticked by the author, unknown to the index
    expect(saved.signals.references.find((x: { name: string }) => x.name === "customers")).toBeUndefined(); // a plain word is not a reference
  });

  it("a complete ticket is ready for planning and moves from unfinished to ready; non-blocking questions travel with it", async () => {
    const engine = new ScriptedEngine([
      {
        verdict: "needs_input",
        summary: "Clear.",
        completed_ticket: "# Done right",
        findings: [
          { id: "F1", kind: "interface", title: "Entry point", detail: "Which function", resolution: "filled", filled: "quote in app.api.checkout.checkout", evidence: [{ type: "code", ref: "app.api.checkout.checkout", excerpt: "def checkout" }], blocking: false },
          { id: "F2", kind: "edge_case", title: "Zero amount", detail: "What happens at zero", resolution: "ask", question: "Should a zero-amount contract be discounted (no-op) or rejected?", options: ["no-op", "reject"], suggested_default: "no-op", blocking: false },
        ],
      },
    ]);
    const r = await triageTicket(env.repo, ticket({ id: "T-ready" }), { engine, store: env.store }, () => {});
    expect(r.verdict).toBe("ready");
    expect(r.model_verdict).toBe("needs_input");
    expect(r.notes).toEqual(["the model said needs input, but no blocking question survived the checks"]);
    expect(r.labels).toEqual({ current: ["unfinished"], add: ["ready for planning"], remove: ["unfinished"] });
    const report = fs.readFileSync(r.report_file, "utf8");
    expect(report).toContain("## Ticket QA: ready for planning");
    expect(report).toContain("### Open points the planner can carry (1, not blocking)");
    expect(report).toContain("code `app.api.checkout.checkout`");
    expect(report).toContain("Labels: unfinished → +ready for planning −unfinished");
  });

  it("already done needs the proving test or code; without it the team must confirm", async () => {
    const proven = new ScriptedEngine([{ verdict: "already_done", findings: [{ id: "F1", kind: "already_done", title: "Volume discount exists", detail: "Checkout already applies the volume discount", resolution: "filled", filled: "tests/test_checkout.py::test_checkout_applies_volume_discount asserts it", evidence: [{ type: "test", ref: "tests/test_checkout.py::test_checkout_applies_volume_discount", excerpt: "assert" }], blocking: false }] }]);
    const a = await triageTicket(env.repo, ticket({ id: "T-done", body: "Checkout should apply a volume discount above the threshold.", labels: [] }), { engine: proven, store: env.store }, () => {});
    expect(a.verdict).toBe("already_done");
    expect(a.labels).toEqual({ current: [], add: ["unfinished"], remove: [] });
    expect(fs.readFileSync(a.report_file, "utf8")).toContain("## Ticket QA: already done");

    const unproven = new ScriptedEngine([{ verdict: "already_done", findings: [{ id: "F1", kind: "already_done", title: "Exists", detail: "It is already there", resolution: "filled", filled: "trust me", evidence: [{ type: "ticket", ref: "ticket", excerpt: "should apply" }], blocking: false }] }, { findings: [] }]);
    const b = await triageTicket(env.repo, ticket({ id: "T-unproven", labels: [] }), { engine: unproven, store: env.store }, () => {});
    expect(b.rounds).toHaveLength(2);
    expect(b.verdict).toBe("needs_input");
    expect(b.findings[0]).toMatchObject({ resolution: "ask", blocking: true });
    expect(b.findings[0]!.question).toMatch(/Does the repository already do this/);
    expect(b.notes.join(" ")).toMatch(/already done without a verified test or code reference/);
  });

  it("refuses a planned ticket unless forced, and rejects an empty ticket", async () => {
    const engine = new ScriptedEngine([{ verdict: "ready", findings: [] }]);
    await expect(triageTicket(env.repo, ticket({ id: "T-planned", labels: ["Planned"] }), { engine, store: env.store }, () => {})).rejects.toThrow(/labelled "planned"/);
    const r = await triageTicket(env.repo, ticket({ id: "T-planned", labels: ["Planned"] }), { engine, store: env.store, force: true }, () => {});
    expect(r.stage).toBe("planned");
    expect(r.verdict).toBe("ready");
    expect(r.labels.add).toEqual(["ready for planning"]);
    expect(r.labels.remove).toEqual([]); // planned is never touched
    expect(r.notes.join(" ")).toMatch(/plan should be redone/);
    expect(fs.readFileSync(r.report_file, "utf8")).toContain("No gaps found");
    await expect(triageTicket(env.repo, ticket({ id: "T-empty", title: null, body: "fix" }), { engine, store: env.store }, () => {})).rejects.toThrow(/too short/);
  });

  it("checks every kind of reference against the revision, the policy and the precedents", () => {
    const lookup = { files: new Set(["app/domain/money.py", "docs/adr/0001.md"]), symbols: new Set(["app.domain.money.Money", "app.domain.money.Money.half"]), bareNames: new Set(["Money", "half"]), tests: new Set(["tests/test_money.py::test_half"]), precedents: new Set([12]) };
    const ctx = { repoPath: env.repo, policy: env.indexed.policy, lookup };
    const ok = (type: string, ref: string) => checkEvidence({ type: type as never, ref, excerpt: "" }, ctx);
    expect(ok("code", "app/domain/money.py:12")).toBeNull();
    expect(ok("code", "Money.half")).toBeNull();
    expect(ok("code", "app/domain/other.py")).toMatch(/no such file or symbol/);
    expect(ok("test", "tests/test_money.py::test_half")).toBeNull();
    expect(ok("test", "test_money.py::test_half")).toBeNull();
    expect(ok("test", "tests/test_money.py::test_missing")).toMatch(/not in the index/);
    expect(ok("doc", "docs/adr/0001.md#Decision")).toBeNull();
    expect(ok("doc", "docs/missing.md")).toMatch(/no such file/);
    expect(ok("policy", "INV-001")).toBeNull();
    expect(ok("policy", "INV-999")).toMatch(/not in policy/);
    expect(ok("policy", "DEC-001")).toMatch(/not an INV- or ARCH- id/);
    expect(ok("decision", "DEC-001")).toBeNull();
    expect(ok("precedent", "#12")).toBeNull();
    expect(ok("precedent", "https://github.com/o/n/issues/12")).toBeNull();
    expect(ok("precedent", "#13")).toMatch(/not among the synced precedents/);
    expect(ok("commit", env.indexed.revision.slice(0, 10))).toBeNull();
    expect(ok("commit", "0000000")).toMatch(/not in the local history/);
    expect(ok("commit", "not-a-sha")).toMatch(/not a sha/);
    expect(ok("ticket", "ticket")).toBeNull();
    const refs = ticketReferences("Use `Money.half` and `app/domain/money.py`; see test_half and docs.python.org, e.g. `break_start`.", lookup);
    expect(refs).toEqual(expect.arrayContaining([{ name: "Money.half", found: "symbol" }, { name: "app/domain/money.py", found: "file" }, { name: "test_half", found: "test" }, { name: "break_start", found: "none" }]));
    expect(refs.find((r) => r.name === "docs.python.org")).toBeUndefined();
  });

  it("stage, label plan and verdict reconciliation are deterministic", () => {
    expect(stageOf(["bug", "Ready for Planning"])).toBe("ready");
    expect(stageOf(["planned", "unfinished"])).toBe("planned");
    expect(stageOf([])).toBe("none");
    expect(labelPlan("ready", ["ready for planning"])).toEqual({ current: ["ready for planning"], add: [], remove: [] });
    expect(labelPlan("needs_input", ["ready for planning", "planned"])).toEqual({ current: ["ready for planning", "planned"], add: ["unfinished"], remove: ["ready for planning"] });
    const ask = (blocking: boolean): TriageFinding => ({ id: "F1", kind: "scope", title: "", detail: "", resolution: "ask", filled: null, evidence: [], question: "?", options: [], suggested_default: null, blocking, checks: [] });
    expect(reconcileVerdict("ready", [ask(true)])).toMatchObject({ verdict: "needs_input" });
    expect(reconcileVerdict("needs_input", [ask(false)])).toMatchObject({ verdict: "ready" });
    expect(reconcileVerdict("ready", [])).toEqual({ verdict: "ready", notes: [] });
  });

  it("reads a GitHub issue with its labels and comments and posts the report with the label move", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const gh: GhRunner = (args, input) => {
      calls.push({ args, input });
      const p = args.find((a) => a.startsWith("repos/")) ?? "";
      const method = args.includes("DELETE") ? "DELETE" : args.includes("POST") ? "POST" : "GET";
      if (method === "GET" && p === "repos/acme/billing/issues/42") return { status: 0, stdout: JSON.stringify({ number: 42, html_url: "https://github.com/acme/billing/issues/42", title: "Promo for enterprise", body: "15% off for `Enterprise` plans at checkout.", labels: [{ name: "unfinished" }, "enhancement"], state: "open" }), stderr: "" };
      if (method === "GET" && p.startsWith("repos/acme/billing/issues/42/comments?")) return { status: 0, stdout: JSON.stringify([{ user: { login: "pm" }, created_at: "2026-10-01T10:00:00Z", body: "Only annual plans." }, { user: { login: "intentos" }, created_at: "2026-10-02T10:00:00Z", body: "## Ticket QA\n<!-- intentos-triage repo=x head=y verdict=needs_input ticket=billing-42 -->" }]), stderr: "" };
      if (method === "POST" && p === "repos/acme/billing/issues/42/comments") return { status: 0, stdout: JSON.stringify({ html_url: "https://github.com/acme/billing/issues/42#issuecomment-7" }), stderr: "" };
      if (method === "DELETE" && p.startsWith("repos/acme/billing/issues/42/labels/")) return { status: 0, stdout: "", stderr: "" };
      if (method === "POST" && p === "repos/acme/billing/issues/42/labels") return { status: 0, stdout: "[]", stderr: "" };
      return { status: 1, stdout: "", stderr: `unexpected ${method} ${p}` };
    };
    expect(parseIssueRef("acme/billing#42")).toEqual({ repo: "acme/billing", number: 42 });
    expect(parseIssueRef("https://github.com/acme/billing/issues/42")).toEqual({ repo: "acme/billing", number: 42 });
    expect(parseIssueRef("42", "acme/billing")).toEqual({ repo: "acme/billing", number: 42 });
    expect(() => parseIssueRef("42")).toThrow(/owner\/name#N/);
    expect(githubTicketId("acme/billing", 42)).toBe("billing-42");
    const t = readGithubIssue({ repo: "acme/billing", number: 42 }, gh);
    expect(t).toMatchObject({ id: "billing-42", title: "Promo for enterprise", labels: ["unfinished", "enhancement"], url: "https://github.com/acme/billing/issues/42", source: { kind: "github", repo: "acme/billing", number: 42 } });
    expect(t.comments).toEqual([{ author: "pm", created_at: "2026-10-01T10:00:00Z", body: "Only annual plans." }]); // our own earlier report is not context
    const engine = new ScriptedEngine([{ verdict: "ready", summary: "Fine.", completed_ticket: "# Promo", findings: [] }]);
    const r = await triageTicket(env.repo, t, { engine, store: env.store }, () => {});
    expect(engine.prompts[0]).toContain("— pm on 2026-10-01");
    expect(r.labels).toEqual({ current: ["unfinished", "enhancement"], add: ["ready for planning"], remove: ["unfinished"] });
    const posted = postTriage(r, gh, () => {});
    expect(posted).toEqual({ comment_url: "https://github.com/acme/billing/issues/42#issuecomment-7", labels_added: ["ready for planning"], labels_removed: ["unfinished"] });
    const comment = calls.find((c) => c.args.includes("POST") && c.args.some((a) => a.endsWith("issues/42/comments")))!;
    expect(JSON.parse(comment.input!).body).toContain("## Ticket QA: ready for planning");
    expect(JSON.parse(comment.input!).body).toContain("<!-- intentos-triage ");
    expect(calls.some((c) => c.args.includes("DELETE") && c.args.some((a) => a.endsWith("issues/42/labels/unfinished")))).toBe(true);
    const add = calls.find((c) => c.args.includes("POST") && c.args.some((a) => a.endsWith("issues/42/labels")))!;
    expect(JSON.parse(add.input!)).toEqual({ labels: ["ready for planning"] });
    expect(() => postTriage({ ...r, ticket: { ...r.ticket, source: { kind: "text" } } }, gh, () => {})).toThrow(/only a GitHub issue/);
  });

  it("runs as an MCP background job: the host starts it, polls status and reads job.result.triage", async () => {
    const engine = new ScriptedEngine([{ verdict: "needs_input", summary: "One decision is open.", completed_ticket: "# Promo\n[TEAM: F1]", findings: [{ id: "F1", kind: "scope", title: "Eligibility", detail: "Which subscriptions count as enterprise", resolution: "ask", question: "Is eligibility the plan name, the seat count, or a flag on the account?", options: ["plan name", "seat count", "account flag"], suggested_default: "plan name", blocking: true }] }]);
    const built = createIntentosMcpServer({ store: env.store, logFile: path.join(env.home, "mcp.log"), triageEngine: () => engine });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await built.server.connect(serverTransport);
    const client = new Client({ name: "test-host", version: "1.0.0" }, {});
    await client.connect(clientTransport);
    const structured = (r: unknown) => (r as { structuredContent: Record<string, any> }).structuredContent;
    try {
      expect(client.getInstructions()).toMatch(/Ticket QA before planning: .*call triage/);
      const missing = await client.callTool({ name: "triage", arguments: { repo: env.repo, ticket: "Add a 15% promotional discount for enterprise subscriptions" } });
      expect(missing.isError).toBe(true);
      const started = await client.callTool({ name: "triage", arguments: { repo: env.repo, ticket: "Add a 15% promotional discount for enterprise subscriptions", ticket_id: "T-mcp" } });
      expect(started.isError, JSON.stringify(started.content)).toBeFalsy();
      expect(structured(started)).toMatchObject({ repo: env.repo });
      let s = structured(await client.callTool({ name: "status", arguments: { repo: env.repo } }));
      for (let i = 0; i < 200 && s.job && s.job.phase !== "done" && s.job.phase !== "failed"; i++) {
        await new Promise((r) => setTimeout(r, 100));
        s = structured(await client.callTool({ name: "status", arguments: { repo: env.repo } }));
      }
      expect(s.job.phase, JSON.stringify(s.job)).toBe("done");
      expect(s.job.kind).toBe("triage");
      expect(s.job.result.triage).toMatchObject({ ticket_id: "T-mcp", verdict: "needs_input", verdict_label: "needs input from the team", summary: "One decision is open." });
      expect(s.job.result.triage.questions).toHaveLength(1);
      expect(s.job.result.triage.questions[0]).toMatchObject({ id: "F1", blocking: true, options: ["plan name", "seat count", "account flag"], suggested_default: "plan name" });
      expect(s.job.result.triage.labels).toEqual({ current: [], add: ["unfinished"], remove: [] });
      expect(s.next).toMatch(/ticket QA finished: needs input from the team; report job.result.triage/);
    } finally {
      await client.close();
      await built.close();
    }
  });
});
