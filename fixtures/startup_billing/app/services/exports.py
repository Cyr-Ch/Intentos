"""Invoice exports. All export formats live here (docs/adr-003-invoice-export-service.md)."""

from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass

from app.domain.money import Money


@dataclass
class Invoice:
    invoice_id: str
    contract_id: str
    lines: list[tuple[str, Money]]
    total: Money


class UnsupportedExportFormat(ValueError):
    """Raised for an export format InvoiceExportService does not support."""


class InvoiceExportService:
    """The home for every invoice export format (ADR-003).

    New export modes are added here, not to app.legacy.export_adapter, which
    is deprecated and superseded by this service.
    """

    SUPPORTED_FORMATS = ("csv", "json")

    def export(self, invoice: Invoice, fmt: str) -> bytes:
        if fmt == "csv":
            return self._to_csv(invoice)
        if fmt == "json":
            return self._to_json(invoice)
        raise UnsupportedExportFormat(
            f"unsupported export format {fmt!r}; supported: {', '.join(self.SUPPORTED_FORMATS)}"
        )

    def _to_csv(self, invoice: Invoice) -> bytes:
        buffer = io.StringIO()
        writer = csv.writer(buffer, lineterminator="\n")
        writer.writerow(["invoice_id", "contract_id", "description", "amount", "currency"])
        for description, amount in invoice.lines:
            writer.writerow([invoice.invoice_id, invoice.contract_id, description, str(amount.amount), amount.currency])
        writer.writerow([invoice.invoice_id, invoice.contract_id, "TOTAL", str(invoice.total.amount), invoice.total.currency])
        return buffer.getvalue().encode("utf-8")

    def _to_json(self, invoice: Invoice) -> bytes:
        payload = {
            "invoice_id": invoice.invoice_id,
            "contract_id": invoice.contract_id,
            "lines": [
                {"description": description, "amount": str(amount.amount), "currency": amount.currency}
                for description, amount in invoice.lines
            ],
            "total": str(invoice.total.amount),
            "currency": invoice.total.currency,
        }
        return json.dumps(payload, indent=2, sort_keys=True).encode("utf-8")
