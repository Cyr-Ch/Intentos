"""DEPRECATED — superseded by app.services.exports.InvoiceExportService (ADR-003).

Kept for one release for backwards compatibility. Do not add new export modes here.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.exports import Invoice


class LegacyExportAdapter:
    """Old CSV-only export. Use InvoiceExportService instead."""

    def export_csv(self, invoice: Invoice) -> str:
        rows = [f"{invoice.invoice_id},{description},{amount}" for description, amount in invoice.lines]
        rows.append(f"{invoice.invoice_id},TOTAL,{invoice.total}")
        return "\n".join(rows) + "\n"
