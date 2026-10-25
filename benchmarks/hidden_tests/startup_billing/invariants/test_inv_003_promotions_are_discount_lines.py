"""INV-003: Promotions are discounts — eligibility via DiscountPolicy, surfaced as DiscountLine entries and audited.

Authority: approved_policy (docs/business-policy.md, 'Promotions'). Hidden from the implementer.
This test is structural: it holds on HEAD (no promotions yet) and after any compliant promotion.
"""
from datetime import date
from decimal import Decimal

from app.domain.contracts import Contract, ContractStatus, Customer, PlanTier, DiscountLine
from app.domain.money import Money
from app.services.audit import AuditLog
from app.services.discounts import DiscountPolicy
from app.services.pricing import PricingService

TODAY = date(2026, 6, 1)


def _contract(tier: PlanTier, status: ContractStatus = ContractStatus.ACTIVE, seats: int = 10) -> Contract:
    return Contract(id=f"k-{tier.value}", customer=Customer(id="c", name="C", tier=tier), status=status, monthly_price=Money.of("100.00"), seats=seats, started_on=date(2025, 1, 1))


def test_quote_total_equals_subtotal_minus_every_discount_line():
    """Any price reduction must be represented as a DiscountLine (no hidden arithmetic)."""
    audit = AuditLog()
    pricing = PricingService(DiscountPolicy(), audit)
    for tier in PlanTier:
        for seats in (1, 60):
            quote = pricing.quote(_contract(tier, seats=seats), TODAY)
            total = quote.subtotal
            for line in quote.discounts:
                assert isinstance(line, DiscountLine)
                assert line.amount.amount >= Decimal("0")
                total = total - line.amount
            assert quote.total == total


def test_every_discount_in_quote_is_audited_by_code():
    audit = AuditLog()
    pricing = PricingService(DiscountPolicy(), audit)
    quote = pricing.quote(_contract(PlanTier.ENTERPRISE, seats=60), TODAY)
    events = audit.events("quote.created")
    assert events, "quote.created audit event missing"
    audited_codes = set(events[-1].data.get("discount_codes", []))
    assert {line.code for line in quote.discounts} == audited_codes


def test_ineligible_contracts_get_no_lines_from_policy_directly():
    policy = DiscountPolicy()
    for status in (ContractStatus.LOCKED, ContractStatus.CANCELLED):
        c = _contract(PlanTier.ENTERPRISE, status=status, seats=500)
        assert policy.applicable_discounts(c, Money.of("50000.00"), TODAY) == []
