"""Thin API layer: formats PricingService results. Pricing math lives in app.services.pricing (ADR-001)."""

from __future__ import annotations

from datetime import date

from app.domain.contracts import Contract
from app.services.pricing import PricingService


def checkout(contract: Contract, today: date, pricing: PricingService) -> dict:
    """Quote the contract and return a JSON-able response (strings, no Decimal)."""
    quote = pricing.quote(contract, today)
    return {
        "contract_id": quote.contract_id,
        "subtotal": str(quote.subtotal.amount),
        "discounts": [
            {"code": line.code, "description": line.description, "amount": str(line.amount.amount)}
            for line in quote.discounts
        ],
        "total": str(quote.total.amount),
        "currency": quote.total.currency,
    }
