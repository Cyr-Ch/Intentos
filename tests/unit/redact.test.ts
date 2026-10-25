import { describe, expect, it } from "vitest";
import { redact } from "../../src/util/redact.ts";

describe("redaction", () => {
  it("strips common secret shapes", () => {
    expect(redact("key sk-abcdefghijklmnopqrstuvwxyz0123")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123");
    expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toContain("[REDACTED]");
    expect(redact("https://user:p4ssw0rd@host/repo.git")).toBe("https://[REDACTED]@host/repo.git");
    expect(redact("api_key=supersecretvalue123")).toContain("[REDACTED]");
  });
  it("leaves ordinary text alone", () => {
    expect(redact("PricingService owns pricing")).toBe("PricingService owns pricing");
  });
});
