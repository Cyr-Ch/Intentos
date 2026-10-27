# Quarantined hidden tests

Tests that fail at the benchmark base revision for reasons outside any ticket: under pandas 3.1, `DatetimeIndex.weekday` emits a deprecation warning that `test_inv_001_no_warning_with_empty_holidays` escalates. Ticket T07 removes the cause; restore the file to `invariants/` and its entry in `policies/oemof_demand.yaml` once it passes at base.
