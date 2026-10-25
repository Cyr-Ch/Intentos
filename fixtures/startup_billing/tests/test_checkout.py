from decimal import Decimal

from app.api.checkout import checkout
from app.services.audit import AuditLog
from app.services.discounts import DiscountPolicy
from app.services.pricing import PricingService


def _assert_no_decimals(value):
    if isinstance(value, dict):
        for item in value.values():
            _assert_no_decimals(item)
    elif isinstance(value, list):
        for item in value:
            _assert_no_decimals(item)
    else:
        assert not isinstance(value, Decimal), f"Decimal leaked into API response: {value!r}"


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


def test_checkout_below_threshold_has_no_discounts(make_contract, today):
    pricing = PricingService(DiscountPolicy(), AuditLog())
    response = checkout(make_contract(seats=5), today, pricing)
    assert response["discounts"] == []
    assert response["total"] == response["subtotal"] == "500.00"
