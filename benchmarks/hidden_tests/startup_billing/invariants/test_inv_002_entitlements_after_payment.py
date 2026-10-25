"""INV-002: Entitlements change only after payment confirmation.

Authority: approved_policy (docs/business-policy.md, 'Entitlements and payment'). Hidden from the implementer.
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
    entitlements = EntitlementService(audit)
    service = SubscriptionService(
        pricing=PricingService(DiscountPolicy(), audit),
        payments=FakePaymentGateway(approve=approve),
        entitlements=entitlements,
        notifier=Notifier(),
        audit=audit,
    )
    return service, entitlements


def _contract() -> Contract:
    customer = Customer(id="c-inv2", name="Inv Two", tier=PlanTier.GROWTH)
    return Contract(id="k-inv2", customer=customer, status=ContractStatus.ACTIVE, monthly_price=Money.of("50.00"), seats=10, started_on=date(2025, 3, 1))


def test_declined_payment_leaves_entitlements_unchanged_for_every_public_upgrade_path():
    service, entitlements = _service(approve=False)
    contract = _contract()
    entitlements.grant_for(contract, PlanTier.GROWTH)
    before = entitlements.current(contract.id)
    for name in dir(service):
        if name.startswith("_") or "upgrade" not in name:
            continue
        method = getattr(service, name)
        if not callable(method):
            continue
        try:
            method(contract, PlanTier.ENTERPRISE, TODAY)
        except TypeError:
            continue  # different signature; not an upgrade entry point we can probe
        except ValueError:
            pass
        assert entitlements.current(contract.id) == before, f"{name} changed entitlements without confirmed payment"
        assert contract.customer.tier == PlanTier.GROWTH, f"{name} changed the tier without confirmed payment"


def test_confirmed_payment_grants_new_tier_entitlements():
    service, entitlements = _service(approve=True)
    contract = _contract()
    result = service.apply_scheduled_upgrade(contract, PlanTier.ENTERPRISE, TODAY)
    assert result.payment is not None and result.payment.confirmed
    assert entitlements.current(contract.id) == entitlements_for(PlanTier.ENTERPRISE)


def test_scheduling_an_upgrade_does_not_grant_entitlements():
    service, entitlements = _service(approve=True)
    contract = _contract()
    service.schedule_upgrade(contract, PlanTier.ENTERPRISE, TODAY)
    assert entitlements.current(contract.id) is None
