/**
 * `intentos acceptance`: a side model writes a ticket's acceptance tests before implementation; IntentOS keeps only
 * modules that fail at the base revision for new behaviour (or pass for an already-done ticket), writes them hidden
 * with their author, and binds the task. A stand-in engine plays the model.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setupFixtureEnv, type TestEnv } from "../helpers/fixture.ts";
import { writeAcceptanceTests, expectationFor, loadTicketFile, pythonpathFor } from "../../src/acceptance.ts";
import type { CodingEngine, ImplementResult, PlanRequest, PlanResult } from "../../src/codex/adapter.ts";
import { resolveHiddenTests } from "../../src/orchestrator/tasks.ts";
import { loadIndexedRepo } from "../../src/knowledge/repo.ts";

let env: TestEnv;
let hiddenRoot: string;
let tasksFile: string;
beforeAll(() => {
  env = setupFixtureEnv();
  hiddenRoot = path.join(env.home, "hidden");
  tasksFile = path.join(env.home, "tasks.json");
});
afterAll(() => env.cleanup());

/** Answers with fixed modules per round and records the prompts it saw. */
class ScriptedEngine implements CodingEngine {
  readonly name = "scripted";
  readonly simulated = true;
  prompts: string[] = [];
  private calls = 0;
  constructor(private readonly rounds: Array<Array<{ path: string; content: string; covers?: string[] }>>, private readonly notes = "") {}
  async plan(req: PlanRequest): Promise<PlanResult> {
    this.prompts.push(req.prompt);
    req.onThreadStarted?.("thread-scripted");
    const files = this.rounds[this.calls++] ?? [];
    return { text: JSON.stringify({ files: files.map((f) => ({ covers: [], ...f })), notes: this.notes }), usage: null, threadId: "thread-scripted", simulated: true, engine: this.name, model: "stand-in-model", items: [] };
  }
  async implement(): Promise<ImplementResult> {
    throw new Error("the acceptance engine never implements");
  }
}

const HALF_TEST = 'from decimal import Decimal\n\nfrom app.domain.money import Money\n\n\ndef test_half_of_ten_is_five():\n    assert Money.of("10.00").half() == Money.of("5.00")\n\n\ndef test_half_keeps_currency():\n    assert Money.of("10.00", "EUR").half().currency == "EUR"\n\n\ndef test_existing_addition_unchanged():\n    assert Money.of("1.00") + Money.of("2.00") == Money.of("3.00")\n';
const PASSING_ONLY = 'from app.domain.money import Money\n\n\ndef test_of_parses():\n    assert str(Money.of("1.50")) == "1.50 USD"\n';
const BROKEN = "from app.domain.money import Money\n\ndef test_syntax(:\n    pass\n";

describe("intentos acceptance", () => {
  it("keeps modules that fail at base, rejects ones that already pass, fixes once, writes hidden tests with their author and binds the task", async () => {
    const engine = new ScriptedEngine([
      [{ path: "test_money_half.py", content: HALF_TEST, covers: ["half of 10 is 5", "currency kept"] }, { path: "test_already_true.py", content: PASSING_ONLY }, { path: "test_broken.py", content: BROKEN }, { path: "not_a_test.py", content: PASSING_ONLY }],
      [{ path: "test_already_true.py", content: 'from app.domain.money import Money\n\n\ndef test_half_is_available():\n    assert hasattr(Money, "half")\n' }],
    ], "half() is the name the ticket gives");
    const ticket = "Add a Money.half() method to app/domain/money.py that returns half of the amount in the same currency";
    const r = await writeAcceptanceTests(env.repo, ticket, { taskId: "T-half", engine, expect: "fail", hiddenTestsRoot: hiddenRoot, tasksFile, store: env.store }, () => {});
    expect(r.rounds).toHaveLength(2);
    expect(r.rounds[0]!.accepted).toBe(1);
    expect(r.rounds[0]!.rejected.map((x) => x.path).sort()).toEqual(["not_a_test.py", "test_already_true.py", "test_broken.py"]);
    expect(r.rounds[0]!.rejected.find((x) => x.path === "test_already_true.py")!.reasons[0]).toMatch(/every test passes/);
    expect(r.rounds[0]!.rejected.find((x) => x.path === "test_broken.py")!.reasons[0]).toMatch(/could not be collected/);
    expect(r.rounds[0]!.rejected.find((x) => x.path === "not_a_test.py")!.reasons[0]).toMatch(/file name/);
    expect(r.rounds[1]!.accepted).toBe(1);
    expect(r.files.map((f) => path.basename(f)).sort()).toEqual(["test_already_true.py", "test_money_half.py"]);
    expect(engine.prompts[0]).toContain(ticket);
    expect(engine.prompts[0]).toContain("must FAIL at the current revision");
    expect(engine.prompts[1]).toContain("rejected 3");
    const dir = path.join(hiddenRoot, "startup_billing", "tasks", "T-half");
    const half = fs.readFileSync(path.join(dir, "test_money_half.py"), "utf8");
    expect(half).toContain("written before implementation by stand-in-model");
    expect(half).toMatch(/test_half_of_ten_is_five (failed|error)/);
    expect(half).toContain("test_existing_addition_unchanged passed");
    expect(half).toContain("Covers:\n- half of 10 is 5");
    expect(half).toContain("def test_half_of_ten_is_five");
    const authored = JSON.parse(fs.readFileSync(path.join(dir, "AUTHORED.json"), "utf8"));
    expect(authored).toMatchObject({ task_id: "T-half", model: "stand-in-model", thread_id: "thread-scripted", expect: "fail", notes: "half() is the name the ticket gives" });
    const tasks = JSON.parse(fs.readFileSync(tasksFile, "utf8")).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: "T-half", fixture: "startup_billing", request: ticket, expected_route: "implement" });
    expect(tasks[0].hidden_tests).toMatch(/hidden\/startup_billing\/tasks\/T-half$/);
    expect(r.statuses.filter((s) => s.status === "passed").map((s) => s.test)).toEqual(["test_existing_addition_unchanged"]);
  });

  it("refuses to overwrite without --force and keeps the implementer's view unchanged", async () => {
    const engine = new ScriptedEngine([[{ path: "test_money_half.py", content: HALF_TEST }]]);
    await expect(writeAcceptanceTests(env.repo, "Add a Money.half() method returning half of the amount", { taskId: "T-half", engine, hiddenTestsRoot: hiddenRoot, tasksFile }, () => {})).rejects.toThrow(/--force/);
    const r = await writeAcceptanceTests(env.repo, "Add a Money.half() method returning half of the amount", { taskId: "T-half", engine: new ScriptedEngine([[{ path: "test_money_half.py", content: HALF_TEST }]]), hiddenTestsRoot: hiddenRoot, tasksFile, force: true }, () => {});
    expect(r.files).toHaveLength(1);
    expect(fs.existsSync(path.join(hiddenRoot, "startup_billing", "tasks", "T-half", "test_already_true.py"))).toBe(false);
    expect(loadIndexedRepo(env.store, env.repo).revision).toBe(r.head); // the repository itself is untouched
  });

  it("an already-done ticket expects its tests to pass now and rejects failing ones", async () => {
    const engine = new ScriptedEngine([[{ path: "test_money_str.py", content: PASSING_ONLY }, { path: "test_money_half.py", content: HALF_TEST }]]);
    const r = await writeAcceptanceTests(env.repo, "Money should print its currency after the amount", { taskId: "T-str", engine, expect: "pass", hiddenTestsRoot: hiddenRoot, tasksFile }, () => {});
    expect(r.files.map((f) => path.basename(f))).toEqual(["test_money_str.py"]);
    expect(r.rounds[0]!.rejected[0]).toMatchObject({ path: "test_money_half.py" });
    expect(r.rounds[0]!.rejected[0]!.reasons[0]).toMatch(/fail at the current revision/);
    const tasks = JSON.parse(fs.readFileSync(tasksFile, "utf8")).tasks;
    expect(tasks.find((t: { id: string }) => t.id === "T-str").expected_route).toBe("abstain");
  });

  it("fails loudly when nothing survives", async () => {
    const engine = new ScriptedEngine([[{ path: "test_x.py", content: PASSING_ONLY }], []]);
    await expect(writeAcceptanceTests(env.repo, "Add something the stand-in never tests", { taskId: "T-none", engine, hiddenTestsRoot: hiddenRoot, tasksFile }, () => {})).rejects.toThrow(/no acceptance module survived/);
    expect(fs.existsSync(path.join(hiddenRoot, "startup_billing", "tasks", "T-none"))).toBe(false);
  });

  it("maps ticket routes to expectations and reads the ticket file; pythonpath comes from the policy", () => {
    expect(expectationFor("implement")).toBe("fail");
    expect(expectationFor("abstain")).toBe("pass");
    expect(expectationFor("clarify")).toBeNull();
    const tickets = loadTicketFile(path.join(process.cwd(), "benchmarks", "demandlib", "tickets.yaml"));
    expect(tickets).toHaveLength(15);
    expect(tickets.filter((t) => expectationFor(t.expected_route) === null).map((t) => t.id)).toEqual(["T05"]);
    expect(pythonpathFor(loadIndexedRepo(env.store, env.repo).policy)).toBe(".");
    const bound = resolveHiddenTests("startup_billing", "x", "task-a-enterprise-promo");
    expect(bound.taskDir).not.toBeNull();
  });
});
