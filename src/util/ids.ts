import { createHash, randomBytes } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function shortHash(text: string, length = 10): string {
  return sha256(text).slice(0, length);
}

export function evidenceId(parts: Array<string | number | null | undefined>): string {
  return `EV-${shortHash(parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("|"))}`;
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `run-${stamp}-${randomBytes(3).toString("hex")}`;
}

/** Stable JSON serialization (sorted keys) used for hashing contracts. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function nowIso(): string {
  return new Date().toISOString();
}
