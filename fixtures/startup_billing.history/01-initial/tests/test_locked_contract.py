from datetime import date

from app.domain.contracts import ContractStatus
from app.services.audit import AuditLog
from app.services.discounts import DiscountPolicy
from app.services.pricing import PricingService


def _pricing() -> PricingService:
    return PricingService(DiscountPolicy(), AuditLog())


def test_locked_contract_gets_no_discount(make_contract, today):
    contract = make_contract(status=ContractStatus.LOCKED, seats=100)
    quote = _pricing().quote(contract, today)
    assert quote.discounts == []
    assert quote.total == quote.subtotal


def test_locked_until_expires(make_contract):
    contract = make_contract(status=ContractStatus.ACTIVE, seats=100, locked_until=date(2026, 3, 31))

    assert contract.is_locked(date(2026, 3, 31))
    assert _pricing().quote(contract, date(2026, 3, 31)).discounts == []

    assert not contract.is_locked(date(2026, 4, 1))
    quote = _pricing().quote(contract, date(2026, 4, 1))
    assert [line.code for line in quote.discounts] == ["VOLUME10"]
    assert quote.total == quote.subtotal - quote.discount_total
