import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { setupFixtureEnv, type TestEnv } from "../helpers/fixture.ts";
import { suggestPolicy } from "../../src/suggest.ts";
import { createIntentosMcpServer, REVIEW_RESOURCE_URI, type McpOptions } from "../../src/mcp.ts";
import { fakeMiner, ROUND_ONE, ROUND_TITLES, ROUND_TWO } from "../helpers/fake_miner.ts";
import { loadPolicyFile } from "../../src/knowledge/policy.ts";
import { PROJECT_ROOT } from "../../src/config.ts";

let env: TestEnv;
let policyFile: string;
const UI_CAPS = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } } };

const MINIMAL_POLICY = `schema_version: "1.0"
policy_id: startup_billing
applies_to: { project_name: startup_billing }
default_allowed_paths: ["app/**", "tests/**"]
protected_paths: ["docs/**"]
commands:
  pytest_project: { description: suite, track: functional, argv: ["{python}", "-m", "pytest", "-q", "--junit-xml={junit}"] }
  scope_check: { description: scope, track: scope, builtin: scope_check }
invariants: []
architecture_rules: []
decisions: []
`;

async function connect(capabilities?: Record<string, unknown>, extra: Partial<McpOptions> = {}) {
  const built = createIntentosMcpServer({ store: env.store, logFile: path.join(env.home, "mcp.log"), ...extra });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverTransport);
  const client = new Client({ name: "test-host", version: "1.0.0" }, capabilities ? { capabilities: capabilities as never } : {});
  await client.connect(clientTransport);
  return { client, built };
}

const structured = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, any>;
const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");

beforeAll(async () => {
  env = setupFixtureEnv();
  await suggestPolicy(env.repo, { writeAdrs: false, withCodex: false, outDir: path.join(env.home, "suggest-out") });
  policyFile = path.join(env.home, "policies", "startup_billing.yaml");
  fs.mkdirSync(path.dirname(policyFile), { recursive: true });
  fs.writeFileSync(policyFile, MINIMAL_POLICY);
});
afterAll(() => env.cleanup());

describe("intentos mcp", () => {
  it("exposes explain, policy and review_start to the model and keeps the review tools app-only", async () => {
    const { client, built } = await connect(UI_CAPS);
    try {
      const tools = (await client.listTools()).tools;
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(Object.keys(byName).sort()).toEqual(["explain", "mine", "mined", "mining_guide", "onboard", "policy", "precedents", "propose", "review_close", "review_decide", "review_finish", "review_next", "review_session", "review_start", "review_state", "status"]);
      expect((byName.review_start!._meta as any).ui.resourceUri).toBe(REVIEW_RESOURCE_URI);
      for (const name of ["review_session", "review_state", "review_decide", "review_finish"]) expect((byName[name]!._meta as any).ui.visibility, name).toEqual(["app"]);
      for (const name of ["explain", "policy", "precedents", "review_start", "review_next", "review_close"]) expect((byName[name]!._meta as any)?.ui?.visibility, name).toBeUndefined();

      const res = await client.readResource({ uri: REVIEW_RESOURCE_URI });
      const page = res.contents[0]!;
      expect(page.mimeType).toBe(RESOURCE_MIME_TYPE);
      const html = String((page as { text?: string }).text);
      expect(html).toContain("IntentOS policy review");
      expect(html).toContain("globalThis.__mcpApps=");
      expect(html).toContain('const MODE = "widget"');
      for (const script of html.split("<script>").slice(1).map((s) => s.split("</script>")[0]!)) expect(() => vm.compileFunction(script)).not.toThrow(); // bundle and page compile as classic scripts

      const explained = await client.callTool({ name: "explain", arguments: { repo: env.repo, task: "Add a 15% promotional discount for eligible enterprise subscriptions" } });
      expect(explained.isError).toBeFalsy();
      expect(textOf(explained as never)).toMatch(/Evidence pack/);
      expect(structured(explained).reusable_symbols.length).toBeGreaterThan(0);

      const pol = await client.callTool({ name: "policy", arguments: { repo: env.repo } });
      expect(structured(pol).policy_id).toBe("startup_billing");
      expect(structured(pol).invariants.map((i: { id: string }) => i.id)).toEqual(["INV-001", "INV-002", "INV-003"]);
    } finally {
      await client.close();
      await built.close();
    }
  });

  it("renders the review inline for a UI-capable host and refuses approvals that do not come from the widget", async () => {
    fs.rmSync(path.join(env.home, "suggest-out", "review-decisions.json"), { force: true });
    const { client, built } = await connect(UI_CAPS);
    try {
      const start = await client.callTool({ name: "review_start", arguments: { repo: env.repo, out_dir: path.join(env.home, "suggest-out"), policy_file: policyFile, hidden_tests_root: path.join(env.home, "hidden"), by: "tester" } });
      expect(start.isError, textOf(start as never)).toBeFalsy();
      const s = structured(start);
      expect(s.ui).toBe("widget");
      expect(s.url).toBeUndefined();
      expect(s.candidates.length).toBeGreaterThan(10);
      expect(JSON.stringify(start)).not.toContain(built.current()!.token); // the model-visible result never carries the widget token
      expect(textOf(start as never)).toMatch(/Do not try to approve on their behalf/);
      // The Codex app renders the widget and supports elicitation: review_next must defer to the widget, not show a form too.
      const deferred = await client.callTool({ name: "review_next", arguments: {} });
      expect(deferred.isError, textOf(deferred as never)).toBeFalsy();
      expect(structured(deferred).deferred).toBe(true);
      expect(textOf(deferred as never)).toMatch(/rendered inline as a widget/);
      const cancelled = s.candidates.find((c: { title: string }) => /cancelled contract gets no discount/i.test(c.title));

      // model-style calls without the token are refused, with and without a guessed token
      const noToken = await client.callTool({ name: "review_decide", arguments: { token: "", id: cancelled.id, action: "accept" } });
      expect(noToken.isError).toBe(true);
      expect(textOf(noToken as never)).toMatch(/widget only/);
      const wrong = await client.callTool({ name: "review_decide", arguments: { token: "0".repeat(32), id: cancelled.id, action: "accept" } });
      expect(wrong.isError).toBe(true);
      expect(loadPolicyFile(policyFile).invariants).toEqual([]);

      // the widget obtains the token through the app-only session tool and approves
      const session = structured(await client.callTool({ name: "review_session", arguments: {} }));
      expect(session.token).toBe(built.current()!.token);
      expect(session.candidates.length).toBe(s.candidates.length);
      const decided = await client.callTool({ name: "review_decide", arguments: { token: session.token, id: cancelled.id, action: "accept", statement: "A cancelled contract never receives any discount line." } });
      expect(decided.isError, textOf(decided as never)).toBeFalsy();
      expect(structured(decided).decision.result.assigned_id).toBe("INV-001");
      const policy = loadPolicyFile(policyFile);
      expect(policy.invariants[0]).toMatchObject({ id: "INV-001", approved_by: "tester", statement: "A cancelled contract never receives any discount line." });
      expect(fs.existsSync(path.join(PROJECT_ROOT, policy.invariants[0]!.verified_by[0]!))).toBe(true);
      const state = structured(await client.callTool({ name: "review_state", arguments: { token: session.token } }));
      expect(state.decisions).toHaveLength(1);
      const finished = structured(await client.callTool({ name: "review_finish", arguments: { token: session.token } }));
      expect(finished.finished).toMatchObject({ accepted: 1 });
      expect(fs.readFileSync(path.join(env.home, "mcp.log"), "utf8")).toMatch(/review_start .* ui=widget; client ui=yes/);
    } finally {
      await client.close();
      await built.close();
    }
  });

  it("falls back to the token-protected local page for a host without the UI extension", async () => {
    fs.writeFileSync(policyFile, MINIMAL_POLICY);
    const { client, built } = await connect();
    try {
      const start = await client.callTool({ name: "review_start", arguments: { repo: env.repo, out_dir: path.join(env.home, "suggest-out"), policy_file: policyFile, hidden_tests_root: path.join(env.home, "hidden2"), by: "tester" } });
      const s = structured(start);
      expect(s.ui).toBe("link");
      expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{32}$/);
      expect(textOf(start as never)).toContain(s.url);
      const page = await fetch(s.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('const MODE = "http"');
      expect((await fetch(s.url.split("?")[0])).status).toBe(403);
      expect(fs.readFileSync(path.join(env.home, "mcp.log"), "utf8")).toMatch(/ui=link; client ui=no/);
    } finally {
      await client.close();
      await built.close();
    }
  });

  it("is wired into the CLI and prints the Codex registration command", () => {
    const res = spawnSync("node", ["--disable-warning=ExperimentalWarning", path.join(PROJECT_ROOT, "bin", "intentos.js"), "mcp", "--print-codex-config"], { encoding: "utf8", env: { ...process.env, INTENTOS_HOME: env.home } });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim()).toBe(`codex mcp add intentos -- ${process.execPath} --disable-warning=ExperimentalWarning ${path.join(PROJECT_ROOT, "bin", "intentos.js")} mcp`);
  });
});

describe("intentos mcp — elicitation (the host asks the reviewer, not the model)", () => {
  it("review_next presents one candidate through the host prompt and applies the reviewer's answer; review_close confirms", async () => {
    fs.writeFileSync(policyFile, MINIMAL_POLICY);
    fs.rmSync(path.join(env.home, "suggest-out", "review-decisions.json"), { force: true });
    const built = createIntentosMcpServer({ store: env.store, logFile: path.join(env.home, "mcp-elicit.log") });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await built.server.connect(serverTransport);
    const client = new Client({ name: "elicit-host", version: "1.0.0" }, { capabilities: { elicitation: { form: {} } } as never });
    const prompts: Array<{ message: string; schema: Record<string, any> }> = [];
    let answer: (schema: Record<string, any>) => { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> } = () => ({ action: "decline" });
    client.setRequestHandler("elicitation/create", async (request) => {
      const params = request.params as { message: string; requestedSchema: Record<string, any> };
      prompts.push({ message: params.message, schema: params.requestedSchema });
      return answer(params.requestedSchema) as never;
    });
    await client.connect(clientTransport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual(expect.arrayContaining(["review_next", "review_close"]));
      const noSession = await client.callTool({ name: "review_next", arguments: {} });
      expect(noSession.isError).toBe(true);

      await client.callTool({ name: "review_start", arguments: { repo: env.repo, out_dir: path.join(env.home, "suggest-out"), policy_file: policyFile, hidden_tests_root: path.join(env.home, "hidden-elicit"), by: "tester" } });
      const first = structured(await client.callTool({ name: "review_state", arguments: { token: built.current()!.token } })).candidates[0];

      // 1. the reviewer approves with an edited statement: the form carried the candidate's evidence and a decision enum
      answer = (schema) => ({ action: "accept", content: { decision: "approve", statement: "Edited by the reviewer in the host prompt.", fold_related: !!schema.properties.fold_related } });
      const approved = await client.callTool({ name: "review_next", arguments: {} });
      expect(approved.isError, textOf(approved as never)).toBeFalsy();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.message).toContain(first.title);
      expect(prompts[0]!.message).toMatch(/Evidence:/);
      expect(prompts[0]!.schema.properties.decision.oneOf.map((o: { const: string }) => o.const)).toEqual(["approve", "reject", "skip"]);
      expect(prompts[0]!.schema.properties.decision.default).toBe("skip");
      expect(prompts[0]!.schema.properties.statement.default).toBe(first.classification?.rule ?? first.statement);
      expect(textOf(approved as never)).toMatch(new RegExp(`${first.id} approved as INV-001`));
      const policy = loadPolicyFile(policyFile);
      expect(policy.invariants.length).toBe(1);
      expect(policy.invariants[0]).toMatchObject({ id: "INV-001", statement: "Edited by the reviewer in the host prompt.", approved_by: "tester" });
      const folded = structured(approved).decision.merged_ids as string[];
      expect(policy.invariants[0]!.verified_by.length).toBe(1 + folded.length);

      // 2. the reviewer declines the prompt: nothing is recorded, the candidate stays pending
      answer = () => ({ action: "decline" });
      const declined = await client.callTool({ name: "review_next", arguments: {} });
      expect(textOf(declined as never)).toMatch(/left undecided \(reviewer decline\)/);
      const state = structured(await client.callTool({ name: "review_state", arguments: { token: built.current()!.token } }));
      expect(state.decisions.filter((d: { action: string }) => d.action === "reject")).toHaveLength(0);

      // 3. the reviewer rejects a specific candidate with a reason
      const currency = state.candidates.find((c: { title: string }) => /currency mismatch raises/i.test(c.title));
      answer = () => ({ action: "accept", content: { decision: "reject", reason: "value-object validation" } });
      const rejected = await client.callTool({ name: "review_next", arguments: { id: currency.id } });
      expect(textOf(rejected as never)).toMatch(new RegExp(`${currency.id} rejected \\(value-object validation\\)`));

      // 4. closing asks for confirmation; declining leaves the review open, confirming finishes it
      answer = () => ({ action: "accept", content: { finish: false } });
      expect(textOf((await client.callTool({ name: "review_close", arguments: {} })) as never)).toMatch(/left open/);
      answer = () => ({ action: "accept", content: { finish: true } });
      const closed = await client.callTool({ name: "review_close", arguments: {} });
      expect(textOf(closed as never)).toMatch(/Review finished: approved 1/);
      expect(structured(closed).finished.rejected).toBe(1);
      expect(fs.existsSync(path.join(env.home, "suggest-out", "feedback.json"))).toBe(true);
      const log = fs.readFileSync(path.join(env.home, "mcp-elicit.log"), "utf8");
      expect(log).toMatch(/initialized: .*protocol=\d{4}-\d{2}-\d{2}/);
      expect(log).toMatch(/review_next CAND-\d+ accept -> INV-001 \(elicitation, (modern|legacy)\)/);
    } finally {
      await client.close();
      await built.close();
    }
  });

  it("without elicitation support review_next points at the review page instead", async () => {
    fs.writeFileSync(policyFile, MINIMAL_POLICY);
    fs.rmSync(path.join(env.home, "suggest-out", "review-decisions.json"), { force: true });
    const { client, built } = await connect();
    try {
      await client.callTool({ name: "review_start", arguments: { repo: env.repo, out_dir: path.join(env.home, "suggest-out"), policy_file: policyFile, hidden_tests_root: path.join(env.home, "hidden-noelicit"), by: "tester" } });
      const res = await client.callTool({ name: "review_next", arguments: {} });
      expect(res.isError).toBe(true);
      expect(textOf(res as never)).toMatch(/does not support form elicitation.*http:\/\/127\.0\.0\.1/);
    } finally {
      await client.close();
      await built.close();
    }
  });
});

describe("intentos mcp — onboarding from the host (status → onboard → status… → review_start)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("carries the working order in the server instructions; status says what to call next; review_start and onboard refuse politely", async () => {
    const { client, built } = await connect();
    try {
      expect(client.getInstructions()).toMatch(/status.*onboard.*review_start.*review_next.*review_close/s);
      fs.writeFileSync(policyFile, MINIMAL_POLICY);
      const s = structured((await client.callTool({ name: "status", arguments: { repo: env.repo, policy_file: policyFile } })) as never);
      expect(s.policy.exists).toBe(true);
      expect(s.suggestions).toBeNull(); // the earlier runs in this file wrote to suggest-out, not the default directory
      expect(s.next).toMatch(/onboard/);
      const missing = await client.callTool({ name: "review_start", arguments: { repo: env.repo, policy_file: path.join(env.home, "policies", "nope.yaml") } });
      expect(missing.isError).toBe(true);
      expect(textOf(missing as never)).toMatch(/not onboarded.*Call onboard/);
      const refused = await client.callTool({ name: "onboard", arguments: { repo: env.repo, policy_file: policyFile } });
      expect(refused.isError).toBe(true);
      expect(textOf(refused as never)).toMatch(/already exists.*force=true/);
      const notRepo = await client.callTool({ name: "status", arguments: { repo: env.home } });
      expect(notRepo.isError).toBe(true);
    } finally {
      await client.close();
      await built.close();
    }
  });

  it("onboard runs the CLI in the background, status reports progress, and the review starts from its output", async () => {
    const { client, built } = await connect();
    try {
      const started = await client.callTool({ name: "onboard", arguments: { repo: env.repo, policy_file: policyFile, install: false, classify: false, force: true } });
      expect(started.isError, textOf(started as never)).toBeFalsy();
      expect(textOf(started as never)).toMatch(/Onboarding started.*Call status/s);
      const again = await client.callTool({ name: "onboard", arguments: { repo: env.repo, policy_file: policyFile, install: false, classify: false, force: true } });
      expect(textOf(again as never)).toMatch(/already running/);
      const early = await client.callTool({ name: "review_start", arguments: { repo: env.repo, policy_file: policyFile } });
      expect(early.isError).toBe(true);
      expect(textOf(early as never)).toMatch(/still running/);
      let s: Record<string, any> = {};
      for (let i = 0; i < 200; i++) {
        s = structured((await client.callTool({ name: "status", arguments: { repo: env.repo, policy_file: policyFile } })) as never);
        if (s.job?.phase === "done" || s.job?.phase === "failed") break;
        await sleep(1000);
      }
      expect(s.job?.phase, JSON.stringify(s.job, null, 2)).toBe("done");
      expect(s.job.result.suite).toMatch(/^passed/);
      expect(s.job.log_tail.length).toBeGreaterThan(0);
      expect(fs.readFileSync(policyFile, "utf8")).toMatch(/DRAFT generated by `intentos onboard`/);
      expect(s.indexed).toBe(true);
      expect(s.suggestions.total).toBeGreaterThan(0);
      expect(s.suggestions.classified).toBe(0);
      expect(s.pending).toBe(s.suggestions.total);
      expect(s.next).toMatch(/review_start/);
      const review = await client.callTool({ name: "review_start", arguments: { repo: env.repo, policy_file: policyFile, hidden_tests_root: path.join(env.home, "hidden-onboard"), by: "tester" } });
      expect(review.isError, textOf(review as never)).toBeFalsy();
      expect(structured(review as never).candidates.length).toBe(Math.min(40, s.suggestions.total));
      expect(textOf(review as never)).toMatch(/not classified/);
    } finally {
      fs.writeFileSync(policyFile, MINIMAL_POLICY);
      await client.close();
      await built.close();
    }
  }, 240_000);
});

describe("intentos mcp — mining by the host (the intentos-policy-mining skill)", () => {
  it("serves the guide and the raw list, turns a proposal into the review list, and status reports it as host-authored", async () => {
    const outDir = path.join(env.home, "propose-out");
    fs.writeFileSync(policyFile, MINIMAL_POLICY);
    const { client, built } = await connect();
    try {
      expect(client.getInstructions()).toMatch(/intentos-policy-mining.*propose.*review_start/s);
      const guide = await client.callTool({ name: "mining_guide", arguments: {} });
      expect(textOf(guide as never)).toMatch(/^---\nname: intentos-policy-mining/);
      const mined = structured((await client.callTool({ name: "mined", arguments: { repo: env.repo, out_dir: outDir } })) as never);
      expect(mined.count).toBeGreaterThan(10);
      const withTest = mined.candidates.find((c: { test: string | null }) => c.test) as { id: string; test: string };
      const proposed = await client.callTool({
        name: "propose",
        arguments: {
          repo: env.repo,
          policy_file: policyFile,
          out_dir: outDir,
          candidates: [
            { title: "Rule from the mined list", statement: "The behaviour proven by the cited test must be preserved as it is.", from_mined: withTest.id, rationale: "picked from the raw list" },
            { title: "Made up", statement: "A rule citing a document that is not in the repository.", evidence: [{ type: "doc", ref: "docs/missing.md:1", excerpt: "x" }], test: { existing: withTest.test } },
          ],
        },
      });
      expect(proposed.isError, textOf(proposed as never)).toBeFalsy();
      const p = structured(proposed as never);
      expect(p.accepted.map((a: { verified: string }) => a.verified)).toEqual(["lifted"]);
      expect(p.rejected[0].reasons.join(" ")).toMatch(/docs\/missing\.md is not a tracked file/);
      expect(textOf(proposed as never)).toMatch(/append=true/);
      const s = structured((await client.callTool({ name: "status", arguments: { repo: env.repo, policy_file: policyFile, out_dir: outDir } })) as never);
      expect(s.suggestions.authored_by).toBe("codex");
      expect(s.pending).toBe(1);
      expect(s.next).toMatch(/review_start/);
      const review = await client.callTool({ name: "review_start", arguments: { repo: env.repo, policy_file: policyFile, out_dir: outDir, hidden_tests_root: path.join(env.home, "hidden-propose"), by: "tester" } });
      expect(review.isError, textOf(review as never)).toBeFalsy();
      expect(structured(review as never).candidates.map((c: { title: string }) => c.title)).toEqual(["Rule from the mined list"]);
      expect(textOf(review as never)).not.toMatch(/not classified/);
    } finally {
      await client.close();
      await built.close();
    }
  }, 120_000);
});

describe("intentos mcp — the independent miner (mine runs the skill with a model other than the host's)", () => {
  it("refuses without a model or a policy, runs the named model in the background, and status, review_start and the widget name the author", async () => {
    const outDir = path.join(env.home, "mine-out");
    fs.writeFileSync(policyFile, MINIMAL_POLICY);
    delete process.env.INTENTOS_MINING_MODEL;
    const engines: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client, built } = await connect(UI_CAPS, {
      mineEngine: (model) => {
        engines.push(model);
        return fakeMiner([() => ROUND_ONE, () => ROUND_TWO], model, { before: () => gate });
      },
    });
    try {
      expect(client.getInstructions()).toMatch(/call mine with a model other than yourself.*poll status until phase is "done"/s);
      const refused = await client.callTool({ name: "mine", arguments: { repo: env.repo, policy_file: policyFile, out_dir: outDir } });
      expect(refused.isError).toBe(true);
      expect(textOf(refused as never)).toMatch(/pass model=<slug>.*INTENTOS_MINING_MODEL/);
      const notOnboarded = await client.callTool({ name: "mine", arguments: { repo: env.repo, model: "other-model", policy_file: path.join(env.home, "policies", "nope.yaml") } });
      expect(notOnboarded.isError).toBe(true);
      expect(textOf(notOnboarded as never)).toMatch(/not onboarded.*Call onboard first/);

      const started = await client.callTool({ name: "mine", arguments: { repo: env.repo, model: "other-model", policy_file: policyFile, out_dir: outDir } });
      expect(started.isError, textOf(started as never)).toBeFalsy();
      expect(structured(started as never).model).toBe("other-model");
      expect(textOf(started as never)).toMatch(/started .* with other-model \(job [0-9a-f]{8}\).*until phase is "done", then call review_start/s);
      const again = await client.callTool({ name: "mine", arguments: { repo: env.repo, model: "other-model", policy_file: policyFile, out_dir: outDir } });
      expect(textOf(again as never)).toMatch(/mining of .* is already running/);
      const early = await client.callTool({ name: "review_start", arguments: { repo: env.repo, policy_file: policyFile, out_dir: outDir } });
      expect(early.isError).toBe(true);
      expect(textOf(early as never)).toMatch(/mining of .* is still running/);
      const busy = structured((await client.callTool({ name: "status", arguments: { repo: env.repo, policy_file: policyFile, out_dir: outDir } })) as never);
      expect(busy.job).toMatchObject({ kind: "mine", phase: "mining" });
      expect(busy.next).toMatch(/mining in progress \(mining\)/);
      release();

      let statusResult = await client.callTool({ name: "status", arguments: { repo: env.repo, policy_file: policyFile, out_dir: outDir } });
      let s = structured(statusResult as never);
      for (let i = 0; i < 240 && s.job && s.job.phase !== "done" && s.job.phase !== "failed"; i++) {
        await new Promise((r) => setTimeout(r, 500));
        statusResult = await client.callTool({ name: "status", arguments: { repo: env.repo, policy_file: policyFile, out_dir: outDir } });
        s = structured(statusResult as never);
      }
      expect(s.job.phase, JSON.stringify(s.job)).toBe("done");
      expect(s.job.kind).toBe("mine");
      expect(s.job.result).toMatchObject({ model: "other-model", accepted: 3, rejected: 1, rounds: 2, candidates: 3 });
      expect(s.job.result.note).toMatch(/still rejected.*Quotes carry a currency/);
      expect(engines).toEqual(["other-model"]);
      expect(s.suggestions.authored_by).toBe("codex");
      expect(s.suggestions.author).toEqual({ via: "side_thread", model: "other-model", engine: "fake-miner", thread_id: "thread-fake-1" });
      expect(s.pending).toBe(3);
      expect(s.next).toMatch(/review_start/);
      expect(textOf(statusResult as never)).toMatch(/authored by other-model in an independent side thread/);

      const review = await client.callTool({ name: "review_start", arguments: { repo: env.repo, policy_file: policyFile, out_dir: outDir, hidden_tests_root: path.join(env.home, "hidden-mine"), by: "tester" } });
      expect(review.isError, textOf(review as never)).toBeFalsy();
      expect(textOf(review as never)).toMatch(/Candidates authored by other-model in an independent side thread, checked and tested by IntentOS/);
      expect(structured(review as never).candidates.map((c: { title: string }) => c.title)).toEqual(ROUND_TITLES);
      const session = structured((await client.callTool({ name: "review_session", arguments: {} })) as never);
      expect(session.author.model).toBe("other-model");
    } finally {
      await client.close();
      await built.close();
    }
  }, 180_000);

  it("status points at mine when INTENTOS_MINING_MODEL names the model", async () => {
    process.env.INTENTOS_MINING_MODEL = "env-model";
    const { client, built } = await connect();
    try {
      const s = structured((await client.callTool({ name: "status", arguments: { repo: env.repo, policy_file: policyFile, out_dir: path.join(env.home, "mine-env-out") } })) as never);
      expect(s.mining_model).toBe("env-model");
      expect(s.next).toMatch(/call mine \(INTENTOS_MINING_MODEL=env-model is set: a model other than you does the mining\)/);
    } finally {
      delete process.env.INTENTOS_MINING_MODEL;
      await client.close();
      await built.close();
    }
  });
});
