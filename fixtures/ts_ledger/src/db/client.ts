import type { Entry, LedgerStore } from "../domain/ledger.ts";
import { Money } from "../domain/money.ts";

/** In-memory storage standing in for a database client. */
export class MemoryStore implements LedgerStore {
  private readonly entries: Entry[] = [];

  balance(account: string): Money | undefined {
    let total: Money | undefined;
    for (const e of this.entries) {
      if (e.account !== account) continue;
      total = total ? total.add(e.amount) : e.amount;
    }
    return total;
  }

  append(entry: Entry): void {
    this.entries.push(entry);
  }
}
