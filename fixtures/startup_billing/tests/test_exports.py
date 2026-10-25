import json

import pytest

from app.domain.money import Money
from app.services.exports import Invoice, InvoiceExportService, UnsupportedExportFormat


def _invoice() -> Invoice:
    return Invoice(
        invoice_id="inv-42",
        contract_id="c-1",
        lines=[("60 seats", Money.of("6000.00")), ("Volume discount", Money.of("600.00"))],
        total=Money.of("5400.00"),
    )


def test_csv_export():
    data = InvoiceExportService().export(_invoice(), "csv")
    assert data == (
        b"invoice_id,contract_id,description,amount,currency\n"
        b"inv-42,c-1,60 seats,6000.00,USD\n"
        b"inv-42,c-1,Volume discount,600.00,USD\n"
        b"inv-42,c-1,TOTAL,5400.00,USD\n"
    )


def test_json_export():
    data = InvoiceExportService().export(_invoice(), "json")
    assert isinstance(data, bytes)
    assert json.loads(data) == {
        "invoice_id": "inv-42",
        "contract_id": "c-1",
        "lines": [
            {"description": "60 seats", "amount": "6000.00", "currency": "USD"},
            {"description": "Volume discount", "amount": "600.00", "currency": "USD"},
        ],
        "total": "5400.00",
        "currency": "USD",
    }
    assert data == json.dumps(json.loads(data), indent=2, sort_keys=True).encode()


def test_unsupported_format_raises():
    with pytest.raises(UnsupportedExportFormat):
        InvoiceExportService().export(_invoice(), "xml")
    with pytest.raises(ValueError):
        InvoiceExportService().export(_invoice(), "pdf")
