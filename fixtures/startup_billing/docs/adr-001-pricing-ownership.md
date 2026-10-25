# ADR-001: PricingService owns pricing

Status: Accepted
Date: 2026-03-02

## Context

Early checkout code computed subtotals and discounts in the API handler. Two
bugs came from the same cause: the handler and the service disagreed on
rounding and on who checks discount eligibility.

## Decision

- `PricingService` (`app/services/pricing.py`) owns all price computation:
  subtotal, discount application and total.
- `DiscountPolicy` (`app/services/discounts.py`) owns discount eligibility and
  is the single extension point for new discount kinds.
- The API layer is formatting only. Modules under `app/api/**` must not import
  `decimal`, `app.domain.money`, or `app.services.discounts`, and must not do
  arithmetic on amounts.

## Consequences

Adding a discount means changing `DiscountPolicy`, never the API. Price
changes are visible in the `quote.created` audit event. Tests assert that API
responses contain only strings, never `Decimal` values.
