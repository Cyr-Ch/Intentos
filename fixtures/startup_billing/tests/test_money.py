from decimal import Decimal

import pytest

from app.domain.money import CurrencyMismatch, Money


def test_of_quantizes_to_cents_half_up():
    assert Money.of("10.005").amount == Decimal("10.01")
    assert Money.of("10.004").amount == Decimal("10.00")
    assert Money.of(10).amount == Decimal("10.00")
    assert str(Money.of("100")) == "100.00 USD"


def test_add_and_sub():
    assert Money.of("10.50") + Money.of("0.50") == Money.of("11.00")
    assert Money.of("10.50") - Money.of("0.50") == Money.of("10.00")
    assert (Money.of("1") - Money.of("1")).is_zero()
    assert Money.zero().is_zero()


def test_currency_mismatch_raises():
    with pytest.raises(CurrencyMismatch):
        Money.of("1", "USD") + Money.of("1", "EUR")
    with pytest.raises(ValueError):  # CurrencyMismatch is a ValueError
        Money.of("1", "USD") - Money.of("1", "EUR")


def test_multiply_and_percent_off():
    assert Money.of("100").multiply(60) == Money.of("6000.00")
    assert Money.of("200").percent_off(Decimal("10")) == Money.of("20.00")
    assert Money.of("33.33").percent_off(Decimal("15")) == Money.of("5.00")  # 4.9995 rounds up


def test_subtraction_never_goes_negative():
    with pytest.raises(ValueError, match="Money cannot be negative"):
        Money.of("1") - Money.of("2")
