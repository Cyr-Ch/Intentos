# Ledger invariants

## Money

Amounts are integers in minor units. Two amounts in different currencies MUST NOT be added; the
domain throws `CurrencyMismatch` instead of converting silently.

## Balances

An account balance MUST never go below zero through `post`. Overdrafts are rejected with
`InsufficientFunds` before the entry is recorded.

## Layering

Request handlers in `src/api` MUST NOT import `src/db` directly; they go through the `Ledger`
repository interface so storage can be swapped in tests.
