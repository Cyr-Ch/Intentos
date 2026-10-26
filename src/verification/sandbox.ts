import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { resolvePython } from "../config.ts";

/**
 * Container-isolated execution of trusted verification commands.
 *
 * In `docker` mode every command that executes candidate code (pytest over the snapshot, hidden tests,
 * counterexample probes) runs inside a container with the snapshot mounted read-only, a writable results
 * directory for JUnit output, no network and CPU/memory/pid limits. Static builtins keep running on the host.
 * When Docker or the image is unavailable the verifier fails closed; it never silently falls back to the host.
 */

export type VerifierMode = "host" | "docker";

export function verifierMode(env: NodeJS.ProcessEnv = process.env): VerifierMode {
  const raw = (env.INTENTOS_VERIFIER ?? "host").trim().toLowerCase();
  if (raw === "host" || raw === "docker") return raw;
  throw new Error(`INTENTOS_VERIFIER must be "host" or "docker" (got ${JSON.stringify(env.INTENTOS_VERIFIER)})`);
}

export interface DockerSettings {
  binary: string;
  image: string;
  cpus: string;
  memory: string;
  pidsLimit: number;
  /** `uid:gid` to run as, so the results directory stays writable on Linux hosts; null lets the image decide. */
  user: string | null;
}

export function dockerSettings(env: NodeJS.ProcessEnv = process.env): DockerSettings {
  const linux = process.platform === "linux" && typeof process.getuid === "function" && typeof process.getgid === "function";
  return {
    binary: env.INTENTOS_DOCKER_BIN ?? "docker",
    image: env.INTENTOS_VERIFIER_IMAGE ?? "intentos-verifier:0.1",
    cpus: env.INTENTOS_VERIFIER_CPUS ?? "1",
    memory: env.INTENTOS_VERIFIER_MEMORY ?? "1g",
    pidsLimit: 256,
    user: linux ? `${process.getuid!()}:${process.getgid!()}` : null,
  };
}

export interface DockerPreflight {
  ok: boolean;
  reason: string | null;
  imageDigest: string | null;
}

/** Environment passed to the docker client: enough to find the daemon and the user's context, nothing else. */
function clientEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? os.homedir() };
  for (const k of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}

function firstLine(s: string | null | undefined): string {
  return (s ?? "").trim().split("\n")[0] ?? "";
}

/** `docker info` then `docker image inspect <image>`; both bounded by a 20 s timeout. */
export function dockerPreflight(settings: DockerSettings): DockerPreflight {
  const info = spawnSync(settings.binary, ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", env: clientEnv(), timeout: 20_000 });
  if (info.error) return { ok: false, reason: `cannot run ${settings.binary}: ${info.error.message}`, imageDigest: null };
  if (info.status !== 0) return { ok: false, reason: `docker daemon unavailable (${settings.binary} info exited ${info.status}: ${firstLine(info.stderr) || firstLine(info.stdout)})`, imageDigest: null };
  const image = spawnSync(settings.binary, ["image", "inspect", settings.image, "--format", "{{.Id}}"], { encoding: "utf8", env: clientEnv(), timeout: 20_000 });
  if (image.error) return { ok: false, reason: `cannot inspect image ${settings.image}: ${image.error.message}`, imageDigest: null };
  if (image.status !== 0) return { ok: false, reason: `verifier image ${settings.image} not found (build it with \`npm run verifier:image\`): ${firstLine(image.stderr)}`, imageDigest: null };
  return { ok: true, reason: null, imageDigest: image.stdout.trim() || null };
}

/** `intentos-<runId>-<commandId>-<attempt>` restricted to the characters Docker accepts in names. */
export function containerName(runId: string, commandId: string, attempt: number): string {
  const raw = `intentos-${runId}-${commandId}-${attempt}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
  return raw.slice(0, 128);
}

export const CONTAINER_SNAPSHOT = "/work/snapshot";
export const CONTAINER_RESULTS = "/work/results";

export interface ContainerContext {
  /** Host snapshot directory (mounted read-only at /work/snapshot). */
  snapshot: string;
  /** Host directory receiving JUnit output (mounted read-write at /work/results). */
  resultsDir: string;
  /** Host hidden-tests directory; must live inside the snapshot. */
  hiddenDir: string;
  name: string;
  settings: DockerSettings;
  /** Host interpreter path to translate to the container's `python` (default: resolvePython()). */
  python?: string;
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function translateArg(arg: string, ctx: ContainerContext, python: string): string {
  const snapshot = stripTrailingSlash(path.resolve(ctx.snapshot));
  const results = stripTrailingSlash(path.resolve(ctx.resultsDir));
  const hidden = stripTrailingSlash(path.resolve(ctx.hiddenDir));
  const replaceAll = (s: string, from: string, to: string) => s.split(from).join(to);
  let out = arg;
  if (out === python) return "python";
  out = replaceAll(out, python, "python");
  // Most specific prefixes first: hidden tests live inside the snapshot, the snapshot lives inside the results dir.
  if (hidden.startsWith(snapshot + path.sep)) out = replaceAll(out, hidden, `${CONTAINER_SNAPSHOT}/${path.relative(snapshot, hidden).split(path.sep).join("/")}`);
  else out = replaceAll(out, hidden, `${CONTAINER_SNAPSHOT}/.intentos_hidden`);
  out = replaceAll(out, snapshot, CONTAINER_SNAPSHOT);
  // Anything else under the results dir is mapped flat into /work/results by basename.
  if (out.includes(results + path.sep)) {
    out = out.replace(new RegExp(`${escapeRe(results + path.sep)}([^\\s:=]+)`, "g"), (_m, rest: string) => `${CONTAINER_RESULTS}/${path.basename(rest)}`);
  }
  out = replaceAll(out, results, CONTAINER_RESULTS);
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when a translated argument still refers to an absolute path outside the container's /work tree. */
export function hasHostPath(arg: string): boolean {
  for (const piece of arg.split(/[=,:]/)) {
    if (piece.startsWith("/") && !piece.startsWith("/work/") && piece !== "/work") return true;
  }
  return false;
}

/**
 * Translate a host argv (as produced from the trusted policy) into a `docker run` argv.
 * Throws when a host path would leak into the container command line: that is a security property, not a convenience.
 */
export function planCommand(argv: string[], ctx: ContainerContext): string[] {
  const python = ctx.python ?? resolvePython();
  const translated = argv.map((a) => translateArg(a, ctx, python));
  const leaked = translated.filter(hasHostPath);
  if (leaked.length) throw new Error(`refusing to run a container command that still references host paths: ${leaked.join(" ")}`);
  const s = ctx.settings;
  const run = [
    s.binary, "run", "--rm", "--name", ctx.name,
    "--network", "none",
    "--read-only", "--tmpfs", "/tmp:rw,size=256m",
    "--cpus", s.cpus, "--memory", s.memory, "--pids-limit", String(s.pidsLimit),
    "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
    "-e", "PYTHONDONTWRITEBYTECODE=1", "-e", "PYTHONHASHSEED=0", "-e", "LANG=C.UTF-8",
    "-v", `${path.resolve(ctx.snapshot)}:${CONTAINER_SNAPSHOT}:ro`,
    "-v", `${path.resolve(ctx.resultsDir)}:${CONTAINER_RESULTS}:rw`,
    "-w", CONTAINER_SNAPSHOT,
  ];
  if (s.user) run.push("--user", s.user);
  run.push(s.image, ...translated);
  return run;
}

/** Best-effort `docker kill`; used after a timeout so a hung container does not outlive the verifier. */
export function killContainer(name: string, settings: DockerSettings): boolean {
  const res = spawnSync(settings.binary, ["kill", name], { encoding: "utf8", env: clientEnv(), timeout: 20_000 });
  return !res.error && res.status === 0;
}

export { clientEnv as dockerClientEnv };

/** Verifier description for environment.json: mode, image and whether docker mode is actually usable right now. */
export function describeVerifier(): { mode: VerifierMode; image: string | null; image_digest: string | null; available: boolean; reason: string | null } {
  const mode = verifierMode();
  if (mode === "host") return { mode, image: null, image_digest: null, available: true, reason: null };
  const settings = dockerSettings();
  const preflight = dockerPreflight(settings);
  return { mode, image: settings.image, image_digest: preflight.imageDigest, available: preflight.ok, reason: preflight.reason };
}
