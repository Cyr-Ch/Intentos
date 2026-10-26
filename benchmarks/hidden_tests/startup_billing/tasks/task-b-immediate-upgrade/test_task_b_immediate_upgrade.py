"""Task B hidden acceptance: immediate subscription upgrades.

Behaviour-driven: an "immediate upgrade" entry point is any public SubscriptionService method or
app.api.subscriptions function mentioning "upgrade" (other than the pre-existing scheduling paths) that,
with a confirmed payment, grants the new tier's entitlements right away. With a declined payment the same
entry point must leave entitlements and tier unchanged (INV-002), and the upgrade must be audited.

Revision note (2026-10-26): the first version discovered the entry point purely by name (`*immediate*`,
`upgrade_now`), which penalised implementations that re-pointed the API at the existing payment-confirmed
flow. This version checks observable behaviour through either layer.
"""
from datetime import date

import app.api.subscriptions as api
from app.domain.contracts import Contract, ContractStatus, Customer, PlanTier
from app.domain.entitlements import entitlements_for
from app.domain.money import Money
from app.services.audit import AuditLog
from app.services.discounts import DiscountPolicy
from app.services.entitlements import EntitlementService
from app.services.notifications import Notifier
from app.services.payments import FakePaymentGateway
from app.services.pricing import PricingService
from app.services.subscriptions import SubscriptionService

TODAY = date(2026, 6, 10)
PRE_EXISTING = {"schedule_upgrade", "apply_scheduled_upgrade"}


def _service(approve: bool):
    audit = AuditLog()
    ent = EntitlementService(audit)
    svc = SubscriptionService(pricing=PricingService(DiscountPolicy(), audit), payments=FakePaymentGateway(approve=approve), entitlements=ent, notifier=Notifier(), audit=audit)
    return svc, ent, audit


def _contract() -> Contract:
    return Contract(id="k-b", customer=Customer(id="c", name="C", tier=PlanTier.GROWTH), status=ContractStatus.ACTIVE, monthly_price=Money.of("50.00"), seats=10, started_on=date(2025, 3, 1))


def _candidates():
    """(layer, name) pairs worth probing; the call shape is fixed per layer."""
    out = []
    for n in dir(SubscriptionService):
        if not n.startswith("_") and "upgrade" in n and n not in PRE_EXISTING and callable(getattr(SubscriptionService, n)):
            out.append(("service", n))
    for n in dir(api):
        if not n.startswith("_") and "upgrade" in n and callable(getattr(api, n)):
            out.append(("api", n))
    return out


def _invoke(layer: str, name: str, svc, contract: Contract):
    if layer == "service":
        return getattr(svc, name)(contract, PlanTier.ENTERPRISE, TODAY)
    return getattr(api, name)(contract, "enterprise", TODAY, svc)


def _immediate_entry_points():
    """Candidates that grant ENTERPRISE entitlements immediately when payment is confirmed."""
    found = []
    for layer, name in _candidates():
        svc, ent, _ = _service(approve=True)
        contract = _contract()
        try:
            _invoke(layer, name, svc, contract)
        except (TypeError, ValueError):
            continue
        if ent.current(contract.id) == entitlements_for(PlanTier.ENTERPRISE) and contract.customer.tier == PlanTier.ENTERPRISE:
            found.append((layer, name))
    return found


def test_an_immediate_upgrade_entry_point_exists():
    assert _immediate_entry_points(), f"no entry point grants entitlements immediately; probed {_candidates()}"


def test_immediate_upgrade_with_declined_payment_changes_nothing():
    points = _immediate_entry_points()
    assert points
    for layer, name in points:
        svc, ent, _ = _service(approve=False)
        contract = _contract()
        try:
            _invoke(layer, name, svc, contract)
        except ValueError:
            pass
        assert ent.current(contract.id) is None, f"{layer}.{name} granted entitlements without confirmed payment"
        assert contract.customer.tier == PlanTier.GROWTH, f"{layer}.{name} changed the tier without confirmed payment"


def test_immediate_upgrade_is_audited():
    points = _immediate_entry_points()
    assert points
    layer, name = points[0]
    svc, _, audit = _service(approve=True)
    _invoke(layer, name, svc, _contract())
    assert any("upgrade" in e.event_type for e in audit.entries)
