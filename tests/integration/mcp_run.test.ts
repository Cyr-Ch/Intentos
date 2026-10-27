/** The host implements, merges and guards through IntentOS: run → status → merge → status → guard, on the fixture, offline. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { PATCHES, setupFixtureEnv, TASK_A, gitHead, type TestEnv } from "../helpers/fixture.ts";
import { createIntentosMcpServer } from "../../src/mcp.ts";
import { resetCoordinationProbe } from "../../src/coordination/mergeguard.ts";

let env: TestEnv;
beforeAll(() => {
  delete process.env.INTENTOS_COORDINATION;
  resetCoordinationProbe();
  env = setupFixtureEnv();
});
afterAll(() => env.cleanup());

const structured = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, any>;
const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");

async function connect() {
  const built = createIntentosMcpServer({ store: env.store, logFile: path.join(env.home, "mcp.log") });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverTransport);
  const client = new Client({ name: "test-host", version: "1.0.0" }, {});
  await client.connect(clientTransport);
  return { client, built };
}

async function waitDone(client: Client, repo: string) {
  let s = structured((await client.callTool({ name: "status", arguments: { repo } })) as never);
  for (let i = 0; i < 600 && s.job && s.job.phase !== "done" && s.job.phase !== "failed"; i++) {
    await new Promise((r) => setTimeout(r, 250));
    s = structured((await client.callTool({ name: "status", arguments: { repo } })) as never);
  }
  return s;
}

describe("intentos mcp — run, merge and guard from the host", () => {
  it("runs a ticket in the background, reports the verification, merges on request with the user's approvers, and the guardian finds main healthy", async () => {
    const { client, built } = await connect();
    try {
      expect(client.getInstructions()).toMatch(/\(6\) Implementing a ticket under IntentOS: call run/);
      expect(client.getInstructions()).toMatch(/never invent approvers/);
      const before = gitHead(env.repo);

      const started = await client.callTool({ name: "run", arguments: { repo: env.repo, task: TASK_A, task_id: "task-a-enterprise-promo", offline_patch: PATCHES.good } });
      expect(started.isError, textOf(started as never)).toBeFalsy();
      expect(textOf(started as never)).toMatch(/Run started .* with coordination hooks/);
      // An offline run can finish before a second call lands, so the busy refusal is only asserted while it is still running.
      const busy = await client.callTool({ name: "status", arguments: { repo: env.repo } });
      expect(["running", "done"]).toContain(structured(busy as never).job.phase);

      let s = await waitDone(client, env.repo);
      expect(s.job.phase, JSON.stringify(s.job)).toBe("done");
      expect(s.job.kind).toBe("run");
      expect(s.job.result.run.state).toBe("REVIEW_READY");
      expect(s.job.result.run.verification).toMatchObject({ status: "passed", blocking: 0, acceptance: "pass", invariants: "passed", coordination: "up to date" });
      expect(s.next).toMatch(/ended REVIEW_READY.*call merge with run_id and the approver names the user gives/);
      const runId = s.job.result.run.run_id as string;

      const runs = structured((await client.callTool({ name: "runs", arguments: { repo: env.repo } })) as never);
      expect(runs.runs[0]).toMatchObject({ run_id: runId, state: "REVIEW_READY" });

      const noTarget = await client.callTool({ name: "merge", arguments: { repo: env.repo } });
      expect(noTarget.isError).toBe(true);
      const merging = await client.callTool({ name: "merge", arguments: { repo: env.repo, run_id: runId, approve: ["sam"], by: "priya" } });
      expect(merging.isError, textOf(merging as never)).toBeFalsy();
      s = await waitDone(client, env.repo);
      expect(s.job.phase, JSON.stringify(s.job)).toBe("done");
      expect(s.job.result.merge).toMatchObject({ merged: true, tier: 1, approvals: ["sam"], ci: "pass", sync_clean: true, reindexed: true });
      expect(s.job.result.merge.merged_verification.status).toBe("passed");
      expect(s.next).toMatch(/merged; the repository's main moved/);
      expect(gitHead(env.repo)).toBe(s.job.result.merge.merge_commit);
      expect(gitHead(env.repo)).not.toBe(before);

      const guarding = await client.callTool({ name: "guard", arguments: { repo: env.repo } });
      expect(guarding.isError, textOf(guarding as never)).toBeFalsy();
      s = await waitDone(client, env.repo);
      expect(s.job.phase, JSON.stringify(s.job)).toBe("done");
      expect(s.job.result.guard.status).toBe("healthy");
      expect(s.next).toMatch(/guardian finished: healthy/);
    } finally {
      await client.close();
      await built.close();
    }
  }, 300_000);
});
