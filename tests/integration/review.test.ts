import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setupFixtureEnv, type TestEnv } from "../helpers/fixture.ts";
import { suggestPolicy, type Candidate } from "../../src/suggest.ts";
import { loadReviewState, startReviewServer, type FinishResult, type ReviewServer, type ReviewState } from "../../src/review.ts";
import { loadPolicyFile } from "../../src/knowledge/policy.ts";
import { PROJECT_ROOT } from "../../src/config.ts";

let env: TestEnv;
let state: ReviewState;
let server: ReviewServer;
let policyFile: string;
let hiddenRoot: string;
const outDir = () => path.join(env.home, "review-out");

const MINIMAL_POLICY = `schema_version: "1.0"
policy_id: startup_billing   # draft written by onboard; reviewers append below
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

beforeAll(async () => {
  env = setupFixtureEnv();
  await suggestPolicy(env.repo, { writeAdrs: false, withCodex: false, outDir: outDir() });
  policyFile = path.join(env.home, "policies", "startup_billing.yaml");
  fs.mkdirSync(path.dirname(policyFile), { recursive: true });
  fs.writeFileSync(policyFile, MINIMAL_POLICY);
  hiddenRoot = path.join(env.home, "hidden_tests");
  state = await loadReviewState(env.repo, { outDir: outDir(), policyFile, hiddenTestsRoot: hiddenRoot, by: "tester", store: env.store });
  server = await startReviewServer(state, { port: 0, open: false });
});
afterAll(async () => {
  await server.close().catch(() => {});
  env.cleanup();
});

const api = async (p: string, init: RequestInit = {}) => {
  const res = await fetch(`http://127.0.0.1:${server.port}${p}`, { ...init, headers: { "x-review-token": server.token, "content-type": "application/json", ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const find = (re: RegExp): Candidate => state.candidates.find((c) => re.test(c.title))!;

describe("intentos review", () => {
  it("serves the page only with the token and exposes the candidates", async () => {
    const noToken = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(noToken.status).toBe(403);
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("IntentOS policy review");
    const script = html.split("<script>")[1]!.split("</script>")[0]!;
    const vm = await import("node:vm");
    expect(() => vm.compileFunction(script)).not.toThrow(); // the page script must be valid JavaScript as served
    const bad = await fetch(`http://127.0.0.1:${server.port}/api/state`);
    expect(bad.status).toBe(403);
    const { status, body } = await api("/api/state");
    expect(status).toBe(200);
    expect(body.policy_id).toBe("startup_billing");
    expect(body.candidates.length).toBeGreaterThan(10);
    expect(body.decisions).toEqual([]);
    expect(body.candidates[0]).toHaveProperty("hidden_test");
  });

  it("approving an invariant writes the policy block, the hidden test and a document section", async () => {
    const c = find(/cancelled contract gets no discount/i);
    const { status, body } = await api("/api/decide", { method: "POST", body: JSON.stringify({ id: c.id, action: "accept", statement: "A cancelled contract never receives any discount line." }) });
    expect(status, JSON.stringify(body)).toBe(200);
    const r = body.decision.result;
    expect(r.assigned_id).toBe("INV-001");
    expect(fs.existsSync(r.hidden_test)).toBe(true);
    expect(r.hidden_test.startsWith(path.join(hiddenRoot, "startup_billing", "invariants"))).toBe(true);
    expect(fs.readFileSync(r.hidden_test, "utf8")).toContain("def test_cancelled_contract_gets_no_discount");
    expect(r.hidden_test_complete).toBe(true);
    expect(r.doc_section).toEqual({ path: "docs/intentos-policy.md", heading: c.title });
    const notes = fs.readFileSync(path.join(env.repo, "docs/intentos-policy.md"), "utf8");
    expect(notes).toContain(`## ${c.title}`);
    expect(notes).toContain("A cancelled contract never receives any discount line.");
    const policy = loadPolicyFile(policyFile);
    const inv = policy.invariants.find((i) => i.id === "INV-001")!;
    expect(inv.statement).toBe("A cancelled contract never receives any discount line.");
    expect(inv.approved_by).toBe("tester");
    expect(inv.sources).toEqual([{ path: "docs/intentos-policy.md", heading: c.title }]);
    expect(inv.verified_by[0]).toBe(path.relative(PROJECT_ROOT, r.hidden_test).split(path.sep).join("/"));
    expect(fs.readFileSync(policyFile, "utf8")).toContain("# draft written by onboard; reviewers append below"); // comments survive
    // a second approval of the same candidate is refused
    const again = await api("/api/decide", { method: "POST", body: JSON.stringify({ id: c.id, action: "accept" }) });
    expect(again.status).toBe(409);
  });

  it("a candidate with a document source cites it instead of adding a section; rules and decisions get their own ids", async () => {
    const locked = find(/^locked contracts$/i);
    const r1 = (await api("/api/decide", { method: "POST", body: JSON.stringify({ id: locked.id, action: "accept" }) })).body.decision.result;
    expect(r1.assigned_id).toBe("INV-002");
    expect(r1.doc_section).toBeNull();
    const rule = find(/app\/domain must not import app\/services/i);
    const r2 = (await api("/api/decide", { method: "POST", body: JSON.stringify({ id: rule.id, action: "accept" }) })).body.decision.result;
    expect(r2.assigned_id).toBe("ARCH-001");
    const adr = find(/ADR-003/i);
    const r3 = (await api("/api/decide", { method: "POST", body: JSON.stringify({ id: adr.id, action: "accept" }) })).body.decision.result;
    expect(r3.assigned_id).toBe("DEC-001");
    expect(r3.warnings.join(" ")).toMatch(/supersedes/);
    const policy = loadPolicyFile(policyFile);
    expect(policy.invariants.find((i) => i.id === "INV-002")!.sources).toEqual([{ path: "docs/business-policy.md", heading: "Locked contracts" }]);
    const arch = policy.architecture_rules.find((a) => a.id === "ARCH-001")!;
    expect(arch).toMatchObject({ kind: "forbidden_import", paths: ["app/domain/**"], forbidden_modules: ["app.services"], approved_by: "tester" });
    expect(policy.decisions.find((d) => d.id === "DEC-001")).toMatchObject({ status: "approved" });
    expect(policy.decisions.find((d) => d.id === "DEC-001")!.supersedes).toBeUndefined();
  });

  it("folds related candidates into one invariant with several hidden tests", async () => {
    const declined = find(/declined payment leaves entitlements unchanged/i);
    const grants = find(/apply upgrade grants entitlements after payment/i);
    expect(declined.cluster_members).toContain(grants.id); // the ranker put them in one cluster
    const { status, body } = await api("/api/decide", { method: "POST", body: JSON.stringify({ id: declined.id, action: "accept", statement: "Entitlements change only after a payment is confirmed; a declined payment leaves them unchanged.", merge_ids: [grants.id] }) });
    expect(status, JSON.stringify(body)).toBe(200);
    const d = body.decision;
    expect(d.merged_ids).toEqual([grants.id]);
    expect(d.result.assigned_id).toBe("INV-003");
    expect(d.result.warnings.join(" ")).toMatch(/folded/);
    const policy = loadPolicyFile(policyFile);
    const inv = policy.invariants.find((i) => i.id === "INV-003")!;
    expect(inv.verified_by).toHaveLength(2);
    for (const t of inv.verified_by) expect(fs.existsSync(path.join(PROJECT_ROOT, t))).toBe(true);
    expect(inv.verified_by.join(" ")).toMatch(/declined_payment/);
    expect(inv.verified_by.join(" ")).toMatch(/apply_upgrade/);
    expect(inv.applies_to_paths).toEqual(expect.arrayContaining([...(declined.applies_to_paths ?? []), ...(grants.applies_to_paths ?? [])]));
    expect(policy.invariants.length).toBe(3); // one entry, not two
    const st = (await api("/api/state")).body;
    expect(st.decisions.find((x: { id: string }) => x.id === grants.id)).toMatchObject({ action: "merge", merged_into: "INV-003" });
    expect((await api("/api/decide", { method: "POST", body: JSON.stringify({ id: grants.id, action: "accept" }) })).status).toBe(409); // folded candidates cannot be approved again
    expect((await api("/api/decide", { method: "POST", body: JSON.stringify({ id: find(/locked until expires/i).id, action: "accept", merge_ids: [find(/app\/legacy is frozen/i).id] }) })).status).toBe(409); // only invariants fold
  });

  it("rejections and skips are recorded; unknown actions and ids are refused", async () => {
    const currency = find(/currency mismatch raises/i);
    const rej = await api("/api/decide", { method: "POST", body: JSON.stringify({ id: currency.id, action: "reject", reason: "value-object validation" }) });
    expect(rej.status).toBe(200);
    expect(rej.body.decision).toMatchObject({ action: "reject", reason: "value-object validation" });
    const skip = await api("/api/decide", { method: "POST", body: JSON.stringify({ id: find(/unsupported format raises/i).id, action: "skip" }) });
    expect(skip.body.decision.action).toBe("skip");
    expect((await api("/api/decide", { method: "POST", body: JSON.stringify({ id: "CAND-999", action: "accept" }) })).status).toBe(409);
    expect((await api("/api/decide", { method: "POST", body: JSON.stringify({ id: currency.id, action: "explode" }) })).status).toBe(400);
    const decisions = JSON.parse(fs.readFileSync(state.decisions_file, "utf8")) as Array<{ id: string; action: string }>;
    expect(decisions.filter((d) => d.action === "accept").length).toBe(5);
    expect(decisions.filter((d) => d.action === "merge").length).toBe(1);
    expect(decisions.some((d) => d.id === currency.id && d.action === "reject")).toBe(true);
  });

  it("finishing records feedback, re-indexes and stops the server", async () => {
    const { status, body } = await api("/api/finish", { method: "POST", body: "{}" });
    expect(status).toBe(200);
    const f = body.finished as FinishResult;
    expect(f).toMatchObject({ accepted: 5, merged: 1, rejected: 1, skipped: 1 });
    expect(f.assigned).toEqual(expect.arrayContaining([expect.stringMatching(/^INV-001 /), expect.stringMatching(/^ARCH-001 /), expect.stringMatching(/^DEC-001 /)]));
    expect(f.feedback!.accepted_ids.length).toBeGreaterThanOrEqual(6); // folded candidates count as accepted: their hidden tests are in the policy
    expect(f.feedback!.accept_tokens).toEqual(expect.arrayContaining(["cancelled", "discount"]));
    expect(fs.existsSync(state.feedback_file)).toBe(true);
    expect(f.index).not.toBeNull();
    expect(f.index!.unresolved_sources).toEqual([]); // the new docs/intentos-policy.md section and the existing heading both bind
    const result = await server.done;
    expect(result.accepted).toBe(5);
    await expect(fetch(`http://127.0.0.1:${server.port}/api/state`, { headers: { "x-review-token": server.token } })).rejects.toThrow();
  });

  it("is wired into the CLI", () => {
    const res = spawnSync("node", ["--disable-warning=ExperimentalWarning", path.join(PROJECT_ROOT, "bin", "intentos.js"), "review", "--help"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    for (const flag of ["--by <name>", "--no-open", "--include-filtered", "--policy-file <file>"]) expect(res.stdout).toContain(flag);
  });
});
