import { Money } from "./money.ts";

export interface Entry {
  account: string;
  amount: Money;
  memo: string;
}

export interface LedgerStore {
  balance(account: string): Money | undefined;
  append(entry: Entry): void;
}

/** Posts entries to accounts. */
export class Ledger {
  constructor(private readonly store: LedgerStore) {}

  balance(account: string, currency = "EUR"): Money {
    return this.store.balance(account) ?? new Money(0, currency);
  }

  post(entry: Entry): Money {
    const current = this.balance(entry.account, entry.amount.currency);
    const next = current.add(entry.amount);
    this.store.append(entry);
    return next;
  }
}
