export class CurrencyMismatch extends Error {
  constructor(a: string, b: string) {
    super(`currency mismatch: ${a} vs ${b}`);
    this.name = "CurrencyMismatch";
  }
}

/** An amount in minor units (cents) of one currency. */
export class Money {
  constructor(
    public readonly cents: number,
    public readonly currency: string,
  ) {
    if (!Number.isInteger(cents)) throw new TypeError("cents must be an integer");
  }

  add(other: Money): Money {
    if (other.currency !== this.currency) throw new CurrencyMismatch(this.currency, other.currency);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    if (other.currency !== this.currency) throw new CurrencyMismatch(this.currency, other.currency);
    return new Money(this.cents - other.cents, this.currency);
  }

  isNegative(): boolean {
    return this.cents < 0;
  }

  toString(): string {
    return `${(this.cents / 100).toFixed(2)} ${this.currency}`;
  }
}
