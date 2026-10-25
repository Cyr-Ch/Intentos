"""Task C hidden acceptance: a new invoice export mode must live in InvoiceExportService (ADR-003), not the legacy adapter."""
import ast
import pathlib

from app.domain.money import Money
from app.services.exports import Invoice, InvoiceExportService


def _invoice() -> Invoice:
    return Invoice(invoice_id="inv-1", contract_id="k-1", lines=[("Seats", Money.of("100.00"))], total=Money.of("100.00"))


def test_export_service_supports_a_new_format_beyond_csv_and_json():
    service = InvoiceExportService()
    formats = set(getattr(service, "SUPPORTED_FORMATS", ()))
    new_formats = formats - {"csv", "json"}
    assert new_formats, "a new export format must be registered on InvoiceExportService.SUPPORTED_FORMATS"
    for fmt in new_formats:
        out = service.export(_invoice(), fmt)
        assert isinstance(out, (bytes, bytearray)) and len(out) > 0


def test_existing_formats_still_work():
    service = InvoiceExportService()
    assert service.export(_invoice(), "csv")
    assert service.export(_invoice(), "json")


def test_legacy_adapter_did_not_grow_new_public_methods():
    src = pathlib.Path("app/legacy/export_adapter.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    methods = {n.name for cls in ast.walk(tree) if isinstance(cls, ast.ClassDef) for n in cls.body if isinstance(n, ast.FunctionDef) and not n.name.startswith("_")}
    assert methods <= {"export_csv"}, f"legacy adapter gained methods: {methods - {'export_csv'}}"
