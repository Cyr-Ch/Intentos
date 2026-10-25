from __future__ import annotations

from datetime import date

import pytest

from app.domain.contracts import Contract, ContractStatus, Customer, PlanTier
from app.domain.money import Money


@pytest.fixture
def today() -> date:
    return date(2026, 3, 15)


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
