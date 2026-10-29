import { describe, expect, it } from "vitest";
import { CurrencyMismatch, Money } from "../src/domain/money.ts";

describe("Money", () => {
  it("adds amounts of the same currency", () => {
    expect(new Money(100, "EUR").add(new Money(50, "EUR")).cents).toBe(150);
  });

  it("refuses to add amounts of different currencies", () => {
    expect(() => new Money(100, "EUR").add(new Money(100, "USD"))).toThrow(CurrencyMismatch);
  });

  it("formats in major units", () => {
    expect(new Money(1234, "EUR").toString()).toBe("12.34 EUR");
  });
});
