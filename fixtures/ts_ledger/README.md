# ts-ledger

A small double-entry ledger used as an IntentOS fixture for TypeScript repositories.

- `src/domain`: `Money` and `Ledger`, pure TypeScript with no I/O.
- `src/db`: the only module allowed to talk to storage.
- `src/api`: request handlers; they call the domain and the repository, never storage directly.

Run `npm test` (vitest).
