import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PATCHES, setupFixtureEnv, TASK_A, type TestEnv } from "../helpers/fixture.ts";
import { createRun, executeRun, type RunOptions } from "../../src/orchestrator/runner.ts";
import type { VerificationResult } from "../../src/verification/results.ts";
import { containerName, dockerPreflight, dockerSettings, planCommand } from "../../src/verification/sandbox.ts";

// Evaluated at collection time with the default (host) environment: decides whether the end-to-end cases run.
const preflight = dockerPreflight(dockerSettings());
const dockerAvailable = preflight.ok;
if (!dockerAvailable) console.log(`[container_verifier] skipping end-to-end container tests: ${preflight.reason}`);

let env: TestEnv;
beforeAll(() => {
  env = setupFixtureEnv();
  process.env.INTENTOS_VERIFIER = "docker";
});
afterAll(() => {
  delete process.env.INTENTOS_VERIFIER;
  delete process.env.INTENTOS_DOCKER_BIN;
  env.cleanup();
});

const offline = (patchFile: string | null): RunOptions => ({ mode: "offline", offline: { route: "implement", patchFile, claimSuccess: false, fabricateEvidence: false, repairPatchFile: null }, taskId: "task-a-enterprise-promo" });

async function run(opts: RunOptions) {
  const rs = createRun(env.store, env.indexed, TASK_A, opts);
  const outcome = await executeRun(env.store, rs, opts);
  return { rs, outcome, verification: rs.readJson<VerificationResult>("verification")! };
}

describe("container verifier — fail closed (runs everywhere)", () => {
  it("fails the run with VERIFIER-UNAVAILABLE when docker cannot be used and never runs pytest on the host", async () => {
    process.env.INTENTOS_DOCKER_BIN = "/nonexistent/docker";
    try {
      const { rs, outcome, verification } = await run(offline(PATCHES.good));
      expect(outcome.state).toBe("FAILED");
      expect(verification.status).toBe("failed");
      expect(verification.verifier.mode).toBe("docker");
      const unavailable = verification.findings.filter((f) => f.rule_id === "VERIFIER-UNAVAILABLE" && f.severity === "blocking" && f.authority === "deterministic");
      expect(unavailable.map((f) => f.message).join("\n")).toMatch(/pytest_project/);
      expect(unavailable.map((f) => f.message).join("\n")).toMatch(/pytest_hidden_task/);
      expect(unavailable.map((f) => f.message).join("\n")).toMatch(/pytest_invariants/);
      for (const id of ["pytest_project", "pytest_hidden_task", "pytest_invariants"]) expect(verification.commands.find((c) => c.command_id === id)!.status, id).toBe("error");
      // static builtins still run on the host
      expect(verification.commands.find((c) => c.command_id === "architecture_rules")!.status).toBe("passed");
      expect(verification.commands.find((c) => c.command_id === "scope_check")!.status).toBe("passed");
      expect(verification.limitations.join(" ")).toMatch(/unavailable/);
      // nothing executed candidate code on the host: no pytest logs at all
      const attemptDir = path.join(rs.runDir, "verification", "attempt-1");
      expect(fs.existsSync(path.join(attemptDir, "pytest_project.log"))).toBe(false);
      for (const f of fs.readdirSync(attemptDir).filter((n) => n.endsWith(".log"))) expect(fs.readFileSync(path.join(attemptDir, f), "utf8"), f).not.toMatch(/passed/);
      const environment = JSON.parse(fs.readFileSync(path.join(rs.runDir, "environment.json"), "utf8")) as { verifier: { mode: string; available: boolean } };
      expect(environment.verifier).toMatchObject({ mode: "docker", available: false });
    } finally {
      delete process.env.INTENTOS_DOCKER_BIN;
    }
  });
});

describe.skipIf(!dockerAvailable)("container verifier — end to end (needs a docker daemon and the verifier image)", () => {
  it("good patch reaches REVIEW_READY with the hidden tests executed inside the container", async () => {
    const { rs, outcome, verification } = await run(offline(PATCHES.good));
    expect(outcome.state).toBe("REVIEW_READY");
    expect(verification.status).toBe("passed");
    const hidden = verification.commands.find((c) => c.command_id === "pytest_hidden_task")!;
    expect(hidden.status).toBe("passed");
    expect(hidden.tests_passed).toBeGreaterThan(0);
    expect(verification.verifier).toEqual({ mode: "docker", image: dockerSettings().image, image_digest: preflight.imageDigest });
    expect(verification.limitations.join(" ")).toMatch(/ran in a container/);
    const log = fs.readFileSync(path.join(rs.runDir, "verification", "attempt-1", "pytest_hidden_task.log"), "utf8");
    expect(log).toContain(" run --rm ");
    expect(log).toContain("--network none");
    expect(log).toContain(":/work/snapshot:ro");
    const environment = JSON.parse(fs.readFileSync(path.join(rs.runDir, "environment.json"), "utf8")) as { verifier: { mode: string; available: boolean }; isolation: string };
    expect(environment.verifier).toMatchObject({ mode: "docker", available: true });
    expect(environment.isolation).toMatch(/container/);
  });

  it("bad patch fails inside the container with the same rule ids as on the host", async () => {
    const { outcome, verification } = await run(offline(PATCHES.bad));
    expect(outcome.state).toBe("FAILED");
    expect(verification.commands.find((c) => c.command_id === "pytest_project")!.status).toBe("passed");
    const rules = verification.findings.map((f) => f.rule_id);
    expect(rules).toContain("ARCH-001");
    expect(rules).toContain("INV-001");
    expect(verification.findings.some((f) => f.rule_id === "VERIFIER-UNAVAILABLE")).toBe(false);
  });

  it("has no network inside the container: only loopback is up and outbound connections fail", () => {
    const tmp = fs.mkdtempSync(path.join(env.home, "net-probe-"));
    const snapshot = path.join(tmp, "snapshot");
    fs.mkdirSync(snapshot);
    // Docker Desktop's VM kernel lists unused tunnel devices (gre0, sit0, …) in /sys/class/net even with --network none,
    // so the probe checks link state and an actual connection attempt rather than the directory listing.
    const probe = [
      "import os, socket",
      "up = sorted(n for n in os.listdir('/sys/class/net') if os.path.isdir(f'/sys/class/net/{n}') and open(f'/sys/class/net/{n}/operstate').read().strip() not in ('down', 'notpresent'))",
      "s = socket.socket(); s.settimeout(3)",
      "try:\n    s.connect(('1.1.1.1', 53)); conn = 'connected'\nexcept OSError as e:\n    conn = 'blocked:' + type(e).__name__",
      "print(up, conn)",
    ].join("\n");
    const plan = planCommand(["python", "-c", probe], { snapshot, resultsDir: tmp, hiddenDir: path.join(snapshot, ".intentos_hidden"), name: containerName(`probe-${process.pid}`, "net", 1), settings: dockerSettings(), python: "python" });
    const res = spawnSync(plan[0]!, plan.slice(1), { encoding: "utf8", timeout: 120_000 });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toMatch(/^\['lo'\] blocked:OSError$/);
  });
});
