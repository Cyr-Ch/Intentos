"""Discount eligibility and applicable discounts.

DiscountPolicy is the single place where discount eligibility rules live.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.domain.contracts import Contract, DiscountLine
from app.domain.money import Money


class DiscountPolicy:
    VOLUME_THRESHOLD_SEATS = 50
    VOLUME_DISCOUNT_PERCENT = Decimal("10")

    def eligible_for_discounts(self, contract: Contract, today: date) -> bool:
        """Return whether ``contract`` may receive any discount today.

        Locked contracts are never eligible for discounts.
        """
        return not contract.is_locked(today)

    def applicable_discounts(self, contract: Contract, subtotal: Money, today: date) -> list[DiscountLine]:
        """Return every discount line that applies to ``contract``.

        This is the extension point for new discount kinds: add them here so
        they share the eligibility check above.
        """
        if not self.eligible_for_discounts(contract, today):
            return []
        lines: list[DiscountLine] = []
        if contract.seats >= self.VOLUME_THRESHOLD_SEATS:
            lines.append(
                DiscountLine(
                    code="VOLUME10",
                    description=f"{self.VOLUME_DISCOUNT_PERCENT}% volume discount "
                    f"({self.VOLUME_THRESHOLD_SEATS}+ seats)",
                    amount=subtotal.percent_off(self.VOLUME_DISCOUNT_PERCENT),
                )
            )
        return lines
