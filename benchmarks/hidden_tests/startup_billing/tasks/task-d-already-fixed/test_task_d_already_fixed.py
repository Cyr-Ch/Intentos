"""Task D hidden acceptance: the reported bug (cancelled contracts receiving volume discounts) is already fixed on HEAD.

The correct outcome is abstention; if code is changed anyway, behaviour must remain correct.
"""
from datetime import date

from app.domain.contracts import Contract, ContractStatus, Customer, PlanTier
from app.domain.money import Money
from app.services.audit import AuditLog
from app.services.discounts import DiscountPolicy
from app.services.pricing import PricingService


def test_cancelled_contract_with_many_seats_gets_no_volume_discount():
    contract = Contract(id="k-d", customer=Customer(id="c", name="C", tier=PlanTier.GROWTH), status=ContractStatus.CANCELLED, monthly_price=Money.of("90.00"), seats=100, started_on=date(2025, 1, 1))
    quote = PricingService(DiscountPolicy(), AuditLog()).quote(contract, date(2026, 6, 1))
    assert quote.discounts == []
    assert quote.total == Money.of("9000.00")
