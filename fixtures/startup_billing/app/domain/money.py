"""Decimal-based money value object."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

CENTS = Decimal("0.01")


class CurrencyMismatch(ValueError):
    """Raised when combining Money values of different currencies."""


@dataclass(frozen=True)
class Money:
    amount: Decimal
    currency: str = "USD"

    def __post_init__(self) -> None:
        quantized = Decimal(self.amount).quantize(CENTS, rounding=ROUND_HALF_UP)
        object.__setattr__(self, "amount", quantized)

    @classmethod
    def of(cls, value: str | int | Decimal, currency: str = "USD") -> Money:
        return cls(Decimal(value), currency)

    @classmethod
    def zero(cls, currency: str = "USD") -> Money:
        return cls(Decimal(0), currency)

    def _require_same_currency(self, other: Money) -> None:
        if self.currency != other.currency:
            raise CurrencyMismatch(f"cannot combine {self.currency} with {other.currency}")

    def __add__(self, other: Money) -> Money:
        self._require_same_currency(other)
        return Money(self.amount + other.amount, self.currency)

    def __sub__(self, other: Money) -> Money:
        self._require_same_currency(other)
        result = self.amount - other.amount
        if result < 0:
            raise ValueError("Money cannot be negative")
        return Money(result, self.currency)

    def multiply(self, factor: Decimal | int) -> Money:
        return Money(self.amount * Decimal(factor), self.currency)

    def percent_off(self, percent: Decimal) -> Money:
        """Return the discount amount equal to ``percent`` of this value."""
        return Money(self.amount * Decimal(percent) / Decimal(100), self.currency)

    def is_zero(self) -> bool:
        return self.amount == 0

    def __str__(self) -> str:
        return f"{self.amount} {self.currency}"
