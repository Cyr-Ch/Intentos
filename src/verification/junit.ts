export interface JunitCase {
  classname: string;
  name: string;
  status: "passed" | "failed" | "error" | "skipped";
  message: string | null;
  file: string | null;
}

/** Minimal JUnit XML parser sufficient for pytest's --junit-xml output. */
export function parseJunit(xml: string): JunitCase[] {
  const cases: JunitCase[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = parseAttrs(m[1] ?? "");
    const body = m[3] ?? "";
    let status: JunitCase["status"] = "passed";
    let message: string | null = null;
    const fail = body.match(/<(failure|error|skipped)\b([^>]*)>?/);
    if (fail) {
      const kind = fail[1]!;
      status = kind === "failure" ? "failed" : kind === "error" ? "error" : "skipped";
      const a = parseAttrs(fail[2] ?? "");
      message = a.message ?? null;
      if (!message) {
        const inner = body.match(/<(?:failure|error|skipped)\b[^>]*>([\s\S]*?)<\/(?:failure|error|skipped)>/);
        message = inner?.[1]?.trim().split("\n").slice(-3).join(" ") ?? null;
      }
    }
    cases.push({ classname: attrs.classname ?? "", name: attrs.name ?? "", status, message: message ? unescape(message).slice(0, 500) : null, file: attrs.file ?? null });
  }
  return cases;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)="([^"]*)"/g)) out[m[1]!] = unescape(m[2]!);
  return out;
}

function unescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
}
