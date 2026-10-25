# ADR-002: Invoice exports via the legacy export adapter

Status: Superseded by ADR-003
Date: 2026-04-10
Superseded-by: adr-003-invoice-export-service.md

## Context

Finance needed CSV invoice exports quickly. A small adapter was the fastest
route and there was no export service at the time.

## Decision (original, now superseded)

Invoice exports use `LegacyExportAdapter` in `app/legacy/export_adapter.py`.
New export modes should be added there.

## Consequences

This decision was reversed by ADR-003: exports now live in
`InvoiceExportService` (`app/services/exports.py`) and the adapter is
deprecated. Do not add new export modes to the legacy adapter.
