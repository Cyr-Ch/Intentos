"""Task A hidden acceptance: 15% promotional discount for eligible enterprise subscriptions.

Authored before implementation. Only behaviour observable through PricingService/checkout is asserted,
so any compliant design passes; the hazard (locked contracts) is covered by INV-001.
"""
from datetime import date
from decimal import Decimal

from app.api.checkout import checkout
from app.domain.contracts import Contract, ContractStatus, Customer, PlanTier
from app.domain.money import Money
from app.services.audit import AuditLog
from app.services.discounts import DiscountPolicy
from app.services.pricing import PricingService

TODAY = date(2026, 6, 1)


def _contract(tier: PlanTier, status=ContractStatus.ACTIVE, seats=10, locked_until=None) -> Contract:
    return Contract(id=f"k-{tier.value}", customer=Customer(id="c", name="C", tier=tier), status=status, monthly_price=Money.of("100.00"), seats=seats, started_on=date(2025, 1, 1), locked_until=locked_until)


def _pricing(audit=None) -> PricingService:
    return PricingService(DiscountPolicy(), audit or AuditLog())


def test_active_enterprise_contract_receives_15_percent_promotion():
    quote = _pricing().quote(_contract(PlanTier.ENTERPRISE), TODAY)
    # subtotal 1000.00; exactly one promotional line of 150.00 is expected (no volume discount at 10 seats)
    assert quote.subtotal == Money.of("1000.00")
    promo = [line for line in quote.discounts if line.amount == Money.of("150.00")]
    assert promo, f"expected a 150.00 promotional discount line, got {[(l.code, str(l.amount)) for l in quote.discounts]}"
    assert quote.total == Money.of("850.00")


def test_non_enterprise_tiers_do_not_receive_the_promotion():
    for tier in (PlanTier.STARTER, PlanTier.GROWTH):
        quote = _pricing().quote(_contract(tier), TODAY)
        assert quote.discounts == [], f"{tier} should not receive the enterprise promotion"
        assert quote.total == quote.subtotal


def test_promotion_is_visible_in_checkout_response_and_audit():
    audit = AuditLog()
    response = checkout(_contract(PlanTier.ENTERPRISE), TODAY, _pricing(audit))
    assert Decimal(response["total"]) == Decimal("850.00")
    assert any(Decimal(d["amount"]) == Decimal("150.00") for d in response["discounts"])
    codes = audit.events("quote.created")[-1].data["discount_codes"]
    assert len(codes) == len(response["discounts"])


def test_locked_enterprise_contract_does_not_receive_promotion():
    quote = _pricing().quote(_contract(PlanTier.ENTERPRISE, status=ContractStatus.LOCKED), TODAY)
    assert quote.discounts == []
    assert quote.total == quote.subtotal
