import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/db/client.ts";
import { InsufficientFunds, Ledger } from "../src/domain/ledger.ts";
import { Money } from "../src/domain/money.ts";

describe("Ledger", () => {
  it("posts credits and reports the balance", () => {
    const ledger = new Ledger(new MemoryStore());
    ledger.post({ account: "acc-1", amount: new Money(500, "EUR"), memo: "deposit" });
    expect(ledger.balance("acc-1").cents).toBe(500);
  });

  it("rejects a debit that would make the balance negative", () => {
    const ledger = new Ledger(new MemoryStore());
    ledger.post({ account: "acc-1", amount: new Money(100, "EUR"), memo: "deposit" });
    expect(() => ledger.post({ account: "acc-1", amount: new Money(-250, "EUR"), memo: "withdrawal" })).toThrow(InsufficientFunds);
    expect(ledger.balance("acc-1").cents).toBe(100);
  });
});
