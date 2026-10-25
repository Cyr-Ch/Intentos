"""Task B hidden acceptance: immediate subscription upgrades.

Authored before implementation. An immediate upgrade must charge first and only then grant entitlements;
a declined payment must leave everything unchanged. The exact method name is discovered dynamically
(any public SubscriptionService method whose name contains 'immediate' or 'upgrade_now').
"""
from datetime import date

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


def _service(approve: bool):
    audit = AuditLog()
    ent = EntitlementService(audit)
    svc = SubscriptionService(pricing=PricingService(DiscountPolicy(), audit), payments=FakePaymentGateway(approve=approve), entitlements=ent, notifier=Notifier(), audit=audit)
    return svc, ent, audit


def _contract() -> Contract:
    return Contract(id="k-b", customer=Customer(id="c", name="C", tier=PlanTier.GROWTH), status=ContractStatus.ACTIVE, monthly_price=Money.of("50.00"), seats=10, started_on=date(2025, 3, 1))


def _immediate_method(svc):
    names = [n for n in dir(svc) if not n.startswith("_") and ("immediate" in n or "upgrade_now" in n)]
    assert names, "no immediate-upgrade entry point found on SubscriptionService"
    return getattr(svc, names[0])


def test_immediate_upgrade_with_confirmed_payment_grants_entitlements_now():
    svc, ent, audit = _service(approve=True)
    contract = _contract()
    result = _immediate_method(svc)(contract, PlanTier.ENTERPRISE, TODAY)
    assert ent.current(contract.id) == entitlements_for(PlanTier.ENTERPRISE)
    assert contract.customer.tier == PlanTier.ENTERPRISE
    assert getattr(result, "scheduled_for", None) in (None, TODAY)


def test_immediate_upgrade_with_declined_payment_changes_nothing():
    svc, ent, audit = _service(approve=False)
    contract = _contract()
    try:
        _immediate_method(svc)(contract, PlanTier.ENTERPRISE, TODAY)
    except ValueError:
        pass
    assert ent.current(contract.id) is None
    assert contract.customer.tier == PlanTier.GROWTH


def test_immediate_upgrade_is_audited():
    svc, ent, audit = _service(approve=True)
    contract = _contract()
    _immediate_method(svc)(contract, PlanTier.ENTERPRISE, TODAY)
    assert any("upgrade" in e.event_type for e in audit.entries)
