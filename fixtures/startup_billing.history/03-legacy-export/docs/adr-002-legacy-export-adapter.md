# ADR-002: Invoice exports via the legacy export adapter

Status: Accepted
Date: 2026-04-10

## Context

Finance needed CSV invoice exports quickly. A small adapter is the fastest
route and there is no export service today.

## Decision

Invoice exports use `LegacyExportAdapter` in `app/legacy/export_adapter.py`.
New export modes should be added there.

## Consequences

Exports stay out of the service layer for now. Revisit if a second format is
requested.
