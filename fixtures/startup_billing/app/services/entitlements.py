"""Grants and tracks entitlements per contract."""

from __future__ import annotations

from app.domain.contracts import Contract, PlanTier
from app.domain.entitlements import Entitlements, entitlements_for
from app.services.audit import AuditLog


class EntitlementService:
    def __init__(self, audit: AuditLog) -> None:
        self._audit = audit
        self._granted: dict[str, Entitlements] = {}

    def current(self, contract_id: str) -> Entitlements | None:
        return self._granted.get(contract_id)

    def grant_for(self, contract: Contract, tier: PlanTier) -> Entitlements:
        entitlements = entitlements_for(tier)
        self._granted[contract.id] = entitlements
        self._audit.record(
            "entitlements.granted",
            contract_id=contract.id,
            tier=tier.value,
            seat_limit=entitlements.seat_limit,
            features=sorted(feature.value for feature in entitlements.features),
        )
        return entitlements
