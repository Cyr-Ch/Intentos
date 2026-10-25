"""PricingService owns all price calculation (docs/adr-001-pricing-ownership.md)."""

from __future__ import annotations

from datetime import date

from app.domain.contracts import Contract, Quote
from app.services.audit import AuditLog
from app.services.discounts import DiscountPolicy


class PricingService:
    """The only component that computes prices. The API layer formats its output."""

    def __init__(self, discount_policy: DiscountPolicy, audit: AuditLog) -> None:
        self._discount_policy = discount_policy
        self._audit = audit

    def quote(self, contract: Contract, today: date) -> Quote:
        subtotal = contract.monthly_price.multiply(contract.seats)
        discounts = self._discount_policy.applicable_discounts(contract, subtotal, today)
        total = subtotal
        for line in discounts:
            total = total - line.amount
        quote = Quote(contract_id=contract.id, subtotal=subtotal, discounts=discounts, total=total)
        self._audit.record(
            "quote.created",
            contract_id=contract.id,
            subtotal=str(subtotal),
            total=str(total),
            discount_codes=[line.code for line in discounts],
        )
        return quote
