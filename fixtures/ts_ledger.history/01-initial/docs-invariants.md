# Ledger invariants

## Money

Amounts are integers in minor units. Two amounts in different currencies MUST NOT be added; the
domain throws `CurrencyMismatch` instead of converting silently.

## Layering

Request handlers in `src/api` MUST NOT import `src/db` directly; they go through the `Ledger`
repository interface so storage can be swapped in tests.
