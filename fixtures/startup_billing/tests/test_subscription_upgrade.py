from datetime import date

import pytest

from app.domain.contracts import ContractStatus, PlanTier
from app.domain.entitlements import entitlements_for
from app.services.audit import AuditLog
from app.services.discounts import DiscountPolicy
from app.services.entitlements import EntitlementService
from app.services.notifications import Notifier
from app.services.payments import FakePaymentGateway
from app.services.pricing import PricingService
from app.services.subscriptions import SubscriptionService


def _build(approve: bool = True):
    audit = AuditLog()
    entitlements = EntitlementService(audit)
    notifier = Notifier()
    service = SubscriptionService(
        pricing=PricingService(DiscountPolicy(), audit),
        payments=FakePaymentGateway(approve=approve),
        entitlements=entitlements,
        notifier=notifier,
        audit=audit,
    )
    return service, entitlements, notifier, audit


def test_schedule_upgrade_takes_effect_next_cycle_without_touching_entitlements(make_contract, today):
    service, entitlements, notifier, audit = _build()
    contract = make_contract(tier=PlanTier.GROWTH)
    entitlements.grant_for(contract, PlanTier.GROWTH)

    result = service.schedule_upgrade(contract, PlanTier.ENTERPRISE, today)

    assert result.status == "scheduled"
    assert result.scheduled_for == date(2026, 4, 1)
    assert result.payment is None
    assert entitlements.current(contract.id) == entitlements_for(PlanTier.GROWTH)
    assert contract.customer.tier is PlanTier.GROWTH
    assert len(audit.events("upgrade.scheduled")) == 1
    assert len(notifier.messages) == 1


def test_apply_upgrade_grants_entitlements_after_payment(make_contract, today):
    service, entitlements, _, audit = _build(approve=True)
    contract = make_contract(tier=PlanTier.GROWTH)

    result = service.apply_scheduled_upgrade(contract, PlanTier.ENTERPRISE, today)

    assert result.status == "upgraded"
    assert result.payment is not None and result.payment.confirmed
    assert entitlements.current(contract.id) == entitlements_for(PlanTier.ENTERPRISE)
    assert contract.customer.tier is PlanTier.ENTERPRISE
    assert len(audit.events("entitlements.granted")) == 1


def test_declined_payment_leaves_entitlements_unchanged(make_contract, today):
    service, entitlements, notifier, audit = _build(approve=False)
    contract = make_contract(tier=PlanTier.GROWTH)
    entitlements.grant_for(contract, PlanTier.GROWTH)

    result = service.apply_scheduled_upgrade(contract, PlanTier.ENTERPRISE, today)

    assert result.status == "payment_failed"
    assert entitlements.current(contract.id) == entitlements_for(PlanTier.GROWTH)
    assert contract.customer.tier is PlanTier.GROWTH
    assert len(audit.events("entitlements.granted")) == 1  # only the initial grant
    assert notifier.messages[-1].subject == "Upgrade payment failed"


def test_locked_contract_cannot_schedule_upgrade(make_contract, today):
    service, *_ = _build()
    with pytest.raises(ValueError):
        service.schedule_upgrade(make_contract(status=ContractStatus.LOCKED), PlanTier.ENTERPRISE, today)
    with pytest.raises(ValueError):
        service.schedule_upgrade(make_contract(locked_until=date(2026, 12, 31)), PlanTier.ENTERPRISE, today)
