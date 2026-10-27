"""Hidden invariant test for INV-001: Volume discount applies at the seat threshold.

Lifted from tests/test_checkout.py::test_checkout_applies_volume_discount by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
from __future__ import annotations
from decimal import Decimal
from app.api.checkout import checkout
from app.services.audit import AuditLog
from app.services.discounts import DiscountPolicy
from app.services.pricing import PricingService
from datetime import date
import pytest
from app.domain.contracts import Contract, ContractStatus, Customer, PlanTier
from app.domain.money import Money

@pytest.fixture
def make_contract():
    def _make(
        *,
        contract_id: str = "c-1",
        status: ContractStatus = ContractStatus.ACTIVE,
        tier: PlanTier = PlanTier.GROWTH,
        seats: int = 60,
        monthly_price: str = "100.00",
        locked_until: date | None = None,
    ) -> Contract:
        customer = Customer(id="cust-1", name="Acme Corp", tier=tier)
        return Contract(
            id=contract_id,
            customer=customer,
            status=status,
            monthly_price=Money.of(monthly_price),
            seats=seats,
            started_on=date(2026, 1, 1),
            locked_until=locked_until,
        )

    return _make

@pytest.fixture
def today() -> date:
    return date(2026, 3, 15)

def test_checkout_applies_volume_discount(make_contract, today):
    audit = AuditLog()
    pricing = PricingService(DiscountPolicy(), audit)
    contract = make_contract(seats=60, monthly_price="100.00")

    response = checkout(contract, today, pricing)

    assert response == {
        "contract_id": "c-1",
        "subtotal": "6000.00",
        "discounts": [
            {"code": "VOLUME10", "description": "10% volume discount (50+ seats)", "amount": "600.00"}
        ],
        "total": "5400.00",
        "currency": "USD",
    }
    _assert_no_decimals(response)

    events = audit.events("quote.created")
    assert len(events) == 1
    assert events[0].data["contract_id"] == "c-1"
    assert events[0].data["discount_codes"] == ["VOLUME10"]
    assert events[0].data["total"] == "5400.00 USD"
