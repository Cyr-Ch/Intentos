"""INV-001: Locked and cancelled contracts never receive discounts or promotions of any kind.

Authority: approved_policy (docs/business-policy.md, 'Locked contracts'). Hidden from the implementer.
"""
from datetime import date
from decimal import Decimal

from app.domain.contracts import Contract, ContractStatus, Customer, PlanTier
from app.domain.money import Money
from app.services.audit import AuditLog
from app.services.discounts import DiscountPolicy
from app.services.pricing import PricingService

TODAY = date(2026, 6, 1)


def _contract(status: ContractStatus, tier: PlanTier = PlanTier.ENTERPRISE, seats: int = 120, locked_until=None) -> Contract:
    customer = Customer(id="c-inv1", name="Inv Corp", tier=tier)
    return Contract(
        id="k-inv1",
        customer=customer,
        status=status,
        monthly_price=Money.of("100.00"),
        seats=seats,
        started_on=date(2025, 1, 1),
        locked_until=locked_until,
    )


def _pricing() -> PricingService:
    return PricingService(DiscountPolicy(), AuditLog())


def test_locked_enterprise_contract_gets_no_discount_lines():
    quote = _pricing().quote(_contract(ContractStatus.LOCKED), TODAY)
    assert quote.discounts == []
    assert quote.total == quote.subtotal == Money.of("12000.00")


def test_cancelled_enterprise_contract_gets_no_discount_lines():
    quote = _pricing().quote(_contract(ContractStatus.CANCELLED), TODAY)
    assert quote.discounts == []
    assert quote.total == quote.subtotal


def test_locked_until_future_blocks_all_discounts():
    quote = _pricing().quote(_contract(ContractStatus.ACTIVE, locked_until=date(2027, 1, 1)), TODAY)
    assert quote.discounts == []
    assert quote.total == quote.subtotal


def test_locked_contract_total_never_below_subtotal_via_checkout_api():
    from app.api.checkout import checkout

    response = checkout(_contract(ContractStatus.LOCKED), TODAY, _pricing())
    assert response["discounts"] == []
    assert Decimal(response["total"]) == Decimal(response["subtotal"])


def test_active_eligible_contract_still_receives_discounts():
    """Guard against 'fixing' the invariant by removing all discounts."""
    quote = _pricing().quote(_contract(ContractStatus.ACTIVE), TODAY)
    assert quote.discounts, "an active 120-seat contract must still receive its volume discount"
    assert quote.total.amount < quote.subtotal.amount
