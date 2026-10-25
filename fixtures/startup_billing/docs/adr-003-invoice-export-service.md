# ADR-003: InvoiceExportService replaces the legacy export adapter

Status: Accepted
Date: 2026-07-18
Supersedes: adr-002-legacy-export-adapter.md

## Context

The legacy adapter (ADR-002) grew string-concatenation CSV code outside the
service layer, with no tests and no path to other formats. Customers asked for
JSON exports.

## Decision

- `InvoiceExportService` in `app/services/exports.py` is the home for all
  export formats. Supported formats are listed in `SUPPORTED_FORMATS`; unknown
  formats raise `UnsupportedExportFormat`.
- `app/legacy/export_adapter.py` is deprecated. It is kept for one release for
  backwards compatibility and must not receive new modes.

## Consequences

New export modes are added as methods of `InvoiceExportService` with tests in
`tests/test_exports.py`. ADR-002 is marked superseded and its guidance no
longer applies.
