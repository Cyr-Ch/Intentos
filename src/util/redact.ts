/** Best-effort secret redaction for logs, prompts, and reports. */
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[REDACTED]"],
  [/((?:api[_-]?key|secret|token|password|passwd)\s*[=:]\s*)["']?[^\s"'`,;]{8,}["']?/gi, "$1[REDACTED]"],
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}
