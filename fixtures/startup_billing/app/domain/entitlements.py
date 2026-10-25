"""Feature entitlements per plan tier."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from app.domain.contracts import PlanTier


class Feature(Enum):
    API_ACCESS = "api_access"
    SSO = "sso"
    AUDIT_LOG = "audit_log"
    PRIORITY_SUPPORT = "priority_support"


@dataclass(frozen=True)
class Entitlements:
    features: frozenset[Feature]
    seat_limit: int


_BY_TIER: dict[PlanTier, Entitlements] = {
    PlanTier.STARTER: Entitlements(frozenset({Feature.API_ACCESS}), seat_limit=10),
    PlanTier.GROWTH: Entitlements(frozenset({Feature.API_ACCESS, Feature.AUDIT_LOG}), seat_limit=100),
    PlanTier.ENTERPRISE: Entitlements(frozenset(Feature), seat_limit=10_000),
}


def entitlements_for(tier: PlanTier) -> Entitlements:
    return _BY_TIER[tier]
