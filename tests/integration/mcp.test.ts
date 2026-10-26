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
import { createIntentosMcpServer, REVIEW_RESOURCE_URI } from "../../src/mcp.ts";
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

async function connect(capabilities?: Record<string, unknown>) {
  const built = createIntentosMcpServer({ store: env.store, logFile: path.join(env.home, "mcp.log") });
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
      expect(Object.keys(byName).sort()).toEqual(["explain", "policy", "review_close", "review_decide", "review_finish", "review_next", "review_session", "review_start", "review_state"]);
      expect((byName.review_start!._meta as any).ui.resourceUri).toBe(REVIEW_RESOURCE_URI);
      for (const name of ["review_session", "review_state", "review_decide", "review_finish"]) expect((byName[name]!._meta as any).ui.visibility, name).toEqual(["app"]);
      for (const name of ["explain", "policy", "review_start", "review_next", "review_close"]) expect((byName[name]!._meta as any)?.ui?.visibility, name).toBeUndefined();

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
    expect(res.stdout.trim()).toBe(`codex mcp add intentos -- node --disable-warning=ExperimentalWarning ${path.join(PROJECT_ROOT, "bin", "intentos.js")} mcp`);
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
