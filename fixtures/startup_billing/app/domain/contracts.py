"""Customers, contracts and quotes."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from enum import Enum

from app.domain.money import Money


class ContractStatus(Enum):
    ACTIVE = "active"
    LOCKED = "locked"
    CANCELLED = "cancelled"


class PlanTier(Enum):
    STARTER = "starter"
    GROWTH = "growth"
    ENTERPRISE = "enterprise"


@dataclass
class Customer:
    id: str
    name: str
    tier: PlanTier
    country: str = "US"


@dataclass
class Contract:
    id: str
    customer: Customer
    status: ContractStatus
    monthly_price: Money
    seats: int
    started_on: date
    locked_until: date | None = None

    def is_locked(self, today: date) -> bool:
        """A contract is locked by status, or by an explicit lock period."""
        if self.status is ContractStatus.LOCKED:
            return True
        return self.locked_until is not None and today <= self.locked_until

    def is_active(self) -> bool:
        return self.status is ContractStatus.ACTIVE


@dataclass
class DiscountLine:
    code: str
    description: str
    amount: Money


@dataclass
class Quote:
    contract_id: str
    subtotal: Money
    discounts: list[DiscountLine]
    total: Money

    @property
    def discount_total(self) -> Money:
        total = Money.zero(self.subtotal.currency)
        for line in self.discounts:
            total = total + line.amount
        return total
