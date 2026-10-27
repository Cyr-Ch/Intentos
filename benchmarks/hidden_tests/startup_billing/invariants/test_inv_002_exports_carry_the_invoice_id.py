"""Hidden invariant test for INV-002: Exports carry the invoice id.

Lifted from tests/test_exports.py::test_csv_export by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import json
import pytest
from app.domain.money import Money
from app.services.exports import Invoice, InvoiceExportService, UnsupportedExportFormat

def test_csv_export():
    data = InvoiceExportService().export(_invoice(), "csv")
    assert data == (
        b"invoice_id,contract_id,description,amount,currency\n"
        b"inv-42,c-1,60 seats,6000.00,USD\n"
        b"inv-42,c-1,Volume discount,600.00,USD\n"
        b"inv-42,c-1,TOTAL,5400.00,USD\n"
    )
