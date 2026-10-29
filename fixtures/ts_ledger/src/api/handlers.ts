import { Ledger, type LedgerStore } from "../domain/ledger.ts";
import { Money } from "../domain/money.ts";

export interface PostRequest {
  account: string;
  cents: number;
  currency: string;
  memo?: string;
}

export function makeHandlers(store: LedgerStore) {
  const ledger = new Ledger(store);
  return {
    post(req: PostRequest): { balance: string } {
      const next = ledger.post({ account: req.account, amount: new Money(req.cents, req.currency), memo: req.memo ?? "" });
      return { balance: next.toString() };
    },
    balance(account: string): { balance: string } {
      return { balance: ledger.balance(account).toString() };
    },
  };
}
