# Business Policy

Business rules the billing backend must uphold. Code and ADRs cite these
sections by heading, so keep the headings stable.

## Pricing ownership

`PricingService` (`app/services/pricing.py`) is the only component that
computes prices. Subtotals, discounts and totals are calculated there and
nowhere else. The API layer (`app/api`) formats `PricingService` results and
performs no arithmetic of its own. See ADR-001.

## Locked contracts

Locked and cancelled contracts never receive discounts or promotions of any
kind. A contract is locked while its status is `locked` or while today is on or
before its `locked_until` date. Any promotion added later must flow through
`DiscountPolicy.eligible_for_discounts` so this rule is applied in one place.

## Promotions

Promotions are discounts and are subject to the same eligibility rules as every
other discount. Promotional percentages must be represented as `DiscountLine`
entries produced by `DiscountPolicy.applicable_discounts`, so they appear in
quotes and in the `quote.created` audit event.

## Entitlements and payment

Entitlements may be changed only after payment is confirmed. A failed or
pending payment must leave entitlements unchanged. Scheduling an upgrade does
not change entitlements; applying it does, and only once the charge succeeds.

## Invoice exports

New export modes are added to `InvoiceExportService`
(`app/services/exports.py`). The legacy adapter in `app/legacy` is deprecated
and must not receive new modes. See ADR-003, which supersedes ADR-002.
