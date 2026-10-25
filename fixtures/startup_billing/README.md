# startup_billing

A small, credible billing backend used as a demonstration fixture. It has no
external dependencies; `Decimal` money, in-memory audit, fake payments.

## Architecture

Three layers; dependencies point downward only (`api -> services -> domain`).

- `app/domain` — value objects and entities: `Money`, `Contract`, `Quote`,
  `Entitlements`. Pure data and invariants, no I/O and no services.
- `app/services` — business operations: `PricingService` (owns all price
  math), `DiscountPolicy` (owns discount eligibility), `SubscriptionService`,
  `EntitlementService`, `InvoiceExportService`, plus audit, payments and
  notifications.
- `app/api` — thin formatting over services. No arithmetic and no policy; it
  turns service results into JSON-able dicts.

`app/legacy` holds the deprecated `LegacyExportAdapter` (ADR-002, superseded
by ADR-003). It receives no new functionality.

## Rules of the house

The business rules the code must uphold are in `docs/business-policy.md`;
the architectural decisions and their status are in `docs/adr-*.md`. Code
docstrings cite those documents by section heading.

## Running tests

```sh
python3 -m venv .venv && .venv/bin/pip install pytest
.venv/bin/python -m pytest -q
```
