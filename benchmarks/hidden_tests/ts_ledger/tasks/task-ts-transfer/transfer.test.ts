/**
 * Acceptance tests for task-ts-transfer: Ledger.transfer moves money between two accounts atomically.
 * Written before implementation; hidden from the implementer. Runs from <snapshot>/.intentos_hidden/task/.
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

describe("transfer", () => {
  it("moves the amount from one account to the other", () => {
    const store = new RecordingStore();
    const ledger = new Ledger(store) as Ledger & { transfer(from: string, to: string, amount: Money, memo?: string): void };
    ledger.post({ account: "a", amount: new Money(500, "EUR"), memo: "deposit" });
    ledger.transfer("a", "b", new Money(200, "EUR"), "rent");
    expect(ledger.balance("a").cents).toBe(300);
    expect(ledger.balance("b").cents).toBe(200);
  });

  it("refuses a transfer the source cannot cover and records nothing", () => {
    const store = new RecordingStore();
    const ledger = new Ledger(store) as Ledger & { transfer(from: string, to: string, amount: Money, memo?: string): void };
    ledger.post({ account: "a", amount: new Money(100, "EUR"), memo: "deposit" });
    expect(() => ledger.transfer("a", "b", new Money(150, "EUR"))).toThrow(InsufficientFunds);
    expect(store.entries).toHaveLength(1);
    expect(ledger.balance("b").cents).toBe(0);
  });
});
