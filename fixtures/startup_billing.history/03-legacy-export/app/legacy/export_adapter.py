"""Invoice export adapter. New export modes go here (ADR-002)."""

from __future__ import annotations


class LegacyExportAdapter:
    """CSV export for finance. Invoices are duck-typed: invoice_id, lines, total."""

    def export_csv(self, invoice) -> str:
        rows = [f"{invoice.invoice_id},{description},{amount}" for description, amount in invoice.lines]
        rows.append(f"{invoice.invoice_id},TOTAL,{invoice.total}")
        return "\n".join(rows) + "\n"
