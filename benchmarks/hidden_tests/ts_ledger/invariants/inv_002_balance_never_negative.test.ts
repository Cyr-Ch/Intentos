/**
 * INV-002: a balance never goes below zero through Ledger.post; the overdraft is rejected before it is recorded.
 * Hidden invariant test for the ts_ledger fixture. Runs from <snapshot>/.intentos_hidden/invariants/.
 */
import { describe, expect, it } from "vitest";
import { InsufficientFunds, Ledger, type Entry, type LedgerStore } from "../../src/domain/ledger.ts";
import { Money } from "../../src/domain/money.ts";

class RecordingStore implements LedgerStore {
  entries: Entry[] = [];
  balance(account: string): Money | undefined {
    let total: Money | undefined;
    for (const e of this.entries) if (e.account === account) total = total ? total.add(e.amount) : e.amount;
    return total;
  }
  append(entry: Entry): void {
    this.entries.push(entry);
  }
}

describe("INV-002 balance never negative", () => {
  it("rejects an overdraft and records nothing", () => {
    const store = new RecordingStore();
    const ledger = new Ledger(store);
    ledger.post({ account: "a", amount: new Money(100, "EUR"), memo: "deposit" });
    expect(() => ledger.post({ account: "a", amount: new Money(-101, "EUR"), memo: "overdraft" })).toThrow(InsufficientFunds);
    expect(store.entries).toHaveLength(1);
    expect(ledger.balance("a").cents).toBe(100);
  });

  it("allows a debit down to exactly zero", () => {
    const ledger = new Ledger(new RecordingStore());
    ledger.post({ account: "a", amount: new Money(100, "EUR"), memo: "deposit" });
    expect(ledger.post({ account: "a", amount: new Money(-100, "EUR"), memo: "withdrawal" }).cents).toBe(0);
  });
});
