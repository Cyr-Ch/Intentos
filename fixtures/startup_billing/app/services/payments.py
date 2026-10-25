"""Payment gateway protocol and an in-memory fake for tests."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from app.domain.contracts import Contract
from app.domain.money import Money


@dataclass
class PaymentResult:
    confirmed: bool
    reference: str
    amount: Money


class PaymentGateway(Protocol):
    def charge(self, contract: Contract, amount: Money) -> PaymentResult: ...


class FakePaymentGateway:
    """Approves or declines every charge, and remembers what it was asked to charge."""

    def __init__(self, approve: bool = True) -> None:
        self.approve = approve
        self.charges: list[PaymentResult] = []

    def charge(self, contract: Contract, amount: Money) -> PaymentResult:
        result = PaymentResult(
            confirmed=self.approve,
            reference=f"pay-{len(self.charges) + 1:04d}",
            amount=amount,
        )
        self.charges.append(result)
        return result
