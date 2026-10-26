import { describe, expect, it } from "vitest";
import { containerName, dockerSettings, hasHostPath, planCommand, verifierMode, type DockerSettings } from "../../src/verification/sandbox.ts";

const settings: DockerSettings = { binary: "docker", image: "intentos-verifier:test", cpus: "2", memory: "512m", pidsLimit: 256, user: null };
const ctx = {
  snapshot: "/tmp/intentos/run-1/verification/attempt-1/snapshot",
  resultsDir: "/tmp/intentos/run-1/verification/attempt-1",
  hiddenDir: "/tmp/intentos/run-1/verification/attempt-1/snapshot/.intentos_hidden",
  name: "intentos-run-1-pytest_hidden_task-1",
  settings,
  python: "/opt/venv/bin/python",
};

describe("sandbox: planCommand", () => {
  it("translates the interpreter, snapshot, hidden-tests and JUnit paths and isolates the container", () => {
    const argv = ["/opt/venv/bin/python", "-m", "pytest", "/tmp/intentos/run-1/verification/attempt-1/snapshot/.intentos_hidden/task", "-q", "-p", "no:cacheprovider", "-o", "pythonpath=.", "--junit-xml=/tmp/intentos/run-1/verification/attempt-1/pytest_hidden_task.junit.xml"];
    const plan = planCommand(argv, ctx);
    expect(plan.slice(0, 2)).toEqual(["docker", "run"]);
    const flags = plan.join(" ");
    for (const f of ["--rm", "--name intentos-run-1-pytest_hidden_task-1", "--network none", "--read-only", "--tmpfs /tmp:rw,size=256m", "--cpus 2", "--memory 512m", "--pids-limit 256", "--security-opt no-new-privileges", "--cap-drop ALL", "-e PYTHONDONTWRITEBYTECODE=1", "-e PYTHONHASHSEED=0", "-v /tmp/intentos/run-1/verification/attempt-1/snapshot:/work/snapshot:ro", "-v /tmp/intentos/run-1/verification/attempt-1:/work/results:rw", "-w /work/snapshot"]) {
      expect(flags, f).toContain(f);
    }
    const image = plan.indexOf(settings.image);
    expect(image).toBeGreaterThan(0);
    expect(plan.slice(image + 1)).toEqual(["python", "-m", "pytest", "/work/snapshot/.intentos_hidden/task", "-q", "-p", "no:cacheprovider", "-o", "pythonpath=.", "--junit-xml=/work/results/pytest_hidden_task.junit.xml"]);
    for (const a of plan.slice(image + 1)) expect(hasHostPath(a), a).toBe(false);
  });

  it("maps the project suite, the counterexample probes and a bare snapshot argument", () => {
    const plan = planCommand(["/opt/venv/bin/python", "-m", "pytest", "tests", "--junit-xml=/tmp/intentos/run-1/verification/attempt-1/pytest_project.junit.xml"], ctx);
    expect(plan.slice(plan.indexOf(settings.image) + 1)).toEqual(["python", "-m", "pytest", "tests", "--junit-xml=/work/results/pytest_project.junit.xml"]);
    const probes = planCommand(["/opt/venv/bin/python", "-m", "pytest", `${ctx.hiddenDir}/counterexamples`, ctx.snapshot], ctx);
    expect(probes.slice(probes.indexOf(settings.image) + 1)).toEqual(["python", "-m", "pytest", "/work/snapshot/.intentos_hidden/counterexamples", "/work/snapshot"]);
  });

  it("adds --user on linux settings and omits it otherwise", () => {
    const withUser = planCommand(["/opt/venv/bin/python", "-m", "pytest"], { ...ctx, settings: { ...settings, user: "1000:1000" } });
    expect(withUser.join(" ")).toContain("--user 1000:1000");
    expect(planCommand(["/opt/venv/bin/python", "-m", "pytest"], ctx).join(" ")).not.toContain("--user");
  });

  it("refuses a command that would leak a host path into the container", () => {
    expect(() => planCommand(["/opt/venv/bin/python", "/etc/passwd"], ctx)).toThrow(/host paths/);
    expect(() => planCommand(["/opt/venv/bin/python", "-m", "pytest", "--junit-xml=/tmp/elsewhere/out.xml"], ctx)).toThrow(/host paths/);
    expect(hasHostPath("--junit-xml=/work/results/x.xml")).toBe(false);
    expect(hasHostPath("pythonpath=.")).toBe(false);
    expect(hasHostPath("/Users/someone/repo")).toBe(true);
  });
});

describe("sandbox: names, modes and settings", () => {
  it("sanitises container names to what docker accepts", () => {
    expect(containerName("run 2026/10:26@x", "pytest project", 2)).toBe("intentos-run-2026-10-26-x-pytest-project-2");
    expect(containerName("a".repeat(200), "b", 1).length).toBeLessThanOrEqual(128);
  });

  it("verifierMode defaults to host, accepts docker and rejects anything else", () => {
    expect(verifierMode({})).toBe("host");
    expect(verifierMode({ INTENTOS_VERIFIER: "host" })).toBe("host");
    expect(verifierMode({ INTENTOS_VERIFIER: "Docker" })).toBe("docker");
    expect(() => verifierMode({ INTENTOS_VERIFIER: "podman" })).toThrow(/INTENTOS_VERIFIER/);
  });

  it("dockerSettings reads the documented environment variables with defaults", () => {
    const d = dockerSettings({});
    expect(d).toMatchObject({ binary: "docker", image: "intentos-verifier:0.1", cpus: "1", memory: "1g", pidsLimit: 256 });
    expect(dockerSettings({ INTENTOS_DOCKER_BIN: "/usr/local/bin/docker", INTENTOS_VERIFIER_IMAGE: "x:1", INTENTOS_VERIFIER_CPUS: "4", INTENTOS_VERIFIER_MEMORY: "2g" })).toMatchObject({ binary: "/usr/local/bin/docker", image: "x:1", cpus: "4", memory: "2g" });
  });
});
