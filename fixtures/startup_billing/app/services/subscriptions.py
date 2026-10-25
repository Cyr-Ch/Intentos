"""Subscription upgrades: scheduling, charging and granting entitlements."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from app.domain.contracts import Contract, ContractStatus, PlanTier
from app.domain.entitlements import Entitlements
from app.services.audit import AuditLog
from app.services.entitlements import EntitlementService
from app.services.notifications import Notifier
from app.services.payments import PaymentGateway, PaymentResult
from app.services.pricing import PricingService


def first_of_next_month(today: date) -> date:
    if today.month == 12:
        return date(today.year + 1, 1, 1)
    return date(today.year, today.month + 1, 1)


@dataclass
class UpgradeResult:
    contract: Contract
    payment: PaymentResult | None
    entitlements: Entitlements | None
    scheduled_for: date | None
    status: str


class SubscriptionService:
    def __init__(
        self,
        pricing: PricingService,
        payments: PaymentGateway,
        entitlements: EntitlementService,
        notifier: Notifier,
        audit: AuditLog,
    ) -> None:
        self._pricing = pricing
        self._payments = payments
        self._entitlements = entitlements
        self._notifier = notifier
        self._audit = audit

    def schedule_upgrade(self, contract: Contract, new_tier: PlanTier, today: date) -> UpgradeResult:
        """Schedule an upgrade to take effect at the next billing cycle.

        Entitlements are not touched here; they change only when the scheduled
        upgrade is applied and paid for (see ``apply_scheduled_upgrade``).
        """
        if contract.is_locked(today) or contract.status is ContractStatus.CANCELLED:
            raise ValueError(f"contract {contract.id} is {contract.status.value} and cannot be upgraded")
        effective_on = first_of_next_month(today)
        self._audit.record(
            "upgrade.scheduled",
            contract_id=contract.id,
            from_tier=contract.customer.tier.value,
            to_tier=new_tier.value,
            effective_on=effective_on.isoformat(),
        )
        self._notifier.send(
            contract.customer.id,
            "Your plan upgrade is scheduled",
            f"Your plan changes to {new_tier.value} on {effective_on.isoformat()}.",
        )
        return UpgradeResult(contract, payment=None, entitlements=None, scheduled_for=effective_on, status="scheduled")

    def apply_scheduled_upgrade(self, contract: Contract, new_tier: PlanTier, today: date) -> UpgradeResult:
        """Charge the first cycle of the new tier and, on success, grant its entitlements.

        Entitlements are granted only after payment confirmation
        (docs/business-policy.md, 'Entitlements and payment').
        """
        quote = self._pricing.quote(contract, today)
        payment = self._payments.charge(contract, quote.total)
        if not payment.confirmed:
            self._audit.record("upgrade.payment_failed", contract_id=contract.id, reference=payment.reference)
            self._notifier.send(
                contract.customer.id,
                "Upgrade payment failed",
                f"We could not charge {payment.amount}; your plan is unchanged.",
            )
            return UpgradeResult(
                contract,
                payment=payment,
                entitlements=self._entitlements.current(contract.id),
                scheduled_for=None,
                status="payment_failed",
            )
        contract.customer.tier = new_tier
        entitlements = self._entitlements.grant_for(contract, new_tier)
        self._audit.record(
            "upgrade.applied",
            contract_id=contract.id,
            tier=new_tier.value,
            reference=payment.reference,
        )
        self._notifier.send(
            contract.customer.id,
            "Your plan has been upgraded",
            f"Welcome to {new_tier.value}. Charged {payment.amount} (ref {payment.reference}).",
        )
        return UpgradeResult(contract, payment=payment, entitlements=entitlements, scheduled_for=None, status="upgraded")
