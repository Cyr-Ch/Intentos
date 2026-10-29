/**
 * INV-001: amounts in different currencies are never combined; the domain throws CurrencyMismatch.
 * Hidden invariant test for the ts_ledger fixture. Runs from <snapshot>/.intentos_hidden/invariants/.
 */
import { describe, expect, it } from "vitest";
import { CurrencyMismatch, Money } from "../../src/domain/money.ts";

describe("INV-001 currency mismatch", () => {
  it("add refuses a different currency", () => {
    expect(() => new Money(100, "EUR").add(new Money(1, "USD"))).toThrow(CurrencyMismatch);
  });

  it("subtract refuses a different currency", () => {
    expect(() => new Money(100, "EUR").subtract(new Money(1, "USD"))).toThrow(CurrencyMismatch);
  });
});
