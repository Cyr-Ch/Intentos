"""Thin API layer: formats SubscriptionService results. Upgrade rules live in app.services.subscriptions."""

from __future__ import annotations

from datetime import date

from app.domain.contracts import Contract, PlanTier
from app.services.subscriptions import SubscriptionService


def request_upgrade(contract: Contract, new_tier_name: str, today: date, subscriptions: SubscriptionService) -> dict:
    """Schedule an upgrade and return a JSON-able response."""
    result = subscriptions.schedule_upgrade(contract, PlanTier(new_tier_name), today)
    return {
        "contract_id": result.contract.id,
        "new_tier": new_tier_name,
        "status": result.status,
        "scheduled_for": result.scheduled_for.isoformat() if result.scheduled_for else None,
    }
